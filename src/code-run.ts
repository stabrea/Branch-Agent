import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import { lockdownOverrides } from "./lockdown.js"; // mac7/lockdown-fix
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import { WorkspaceFiles } from "./files.js";
import { defaultJobObjects, jobWithin, type JobObjects } from "./integrations/job-object.js";
import { sandboxShape, shapeChoice, type SandboxChoice } from "./sandbox.js";
import type { HeldBySystem } from "./integrations/posix-limits.js";
import { checkCodeBlock } from "./code-check.js";
import {
  chooseSandboxBackend, defaultSandboxProbe, defaultSandboxSpawn as defaultSandboxSpawnFor,
  sandboxBackendSet, sliceFor, SandboxBackendSettingsSchema,
  type SandboxBackend, type SandboxBackendName, type SandboxProbe, type SandboxSpawn,
} from "./sandbox-backends.js";
import { agentContainerSlice } from "./sandbox-agent-containers.js";

/**
 * Running a small script the assistant just wrote: a sum, a bit of reshaping, a quick check. It runs
 * in a brand-new program of its own, started in the workspace, with the same memory and processor
 * ceilings a host command gets and no way out to the internet unless the owner says otherwise.
 *
 * How tightly it is held is the owner's to choose: an approval rule covering this tool may say "in a
 * box with no way out to the internet", "in a box", or "no box" (see src/sandbox.ts), and the choice
 * arrives on the call. Without a rule the script settings below decide, as they always did. None of
 * the three is a security boundary — the script still runs on this computer with this app's reach —
 * so running scripts at all is off until the owner switches it on.
 */
export const CodeRunSettingsSchema = z.object({
  /** Off until the owner turns it on, because a script is host execution like any other. */
  enabled: z.boolean().default(false),
  /** The owner's Python, given in full. Left empty, only JavaScript can be run. */
  python: z.string().max(1000).default(""),
  /** Let a script reach the internet. Off means it is pointed at a dead address, as commands are. */
  network: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(60000).default(15000),
  maxMemoryMb: z.number().int().min(16).max(8192).default(512),
  maxCpuSeconds: z.number().int().min(1).max(120).default(20),
  maxOutputBytes: z.number().int().min(256).max(16384).default(8192),
}).strict();
export type CodeRunSettings = z.infer<typeof CodeRunSettingsSchema>;

export function codeRunSettings(store: Store, owner: string): CodeRunSettings {
  const parsed = CodeRunSettingsSchema.safeParse(store.get("settings", owner, "code-run")?.data ?? {});
  const settings = parsed.success ? parsed.data : CodeRunSettingsSchema.parse({});
  return lockdownOverrides(store, owner, "code-run") ? { ...settings, enabled: false } : settings; // mac7/lockdown-fix
}
export async function saveCodeRunSettings(store: Store, owner: string, input: unknown): Promise<CodeRunSettings> {
  const value = CodeRunSettingsSchema.parse(input ?? {});
  if (value.python) {
    if (!isAbsolute(value.python)) throw new Error("Give Python in full, starting from the drive.");
    if (!(await stat(value.python).catch(() => null))?.isFile()) throw new Error("There is no program at that address.");
  }
  store.save("settings", owner, "code-run", { ...value });
  return value;
}

export const CodeRunInputSchema = z.object({
  language: z.enum(["javascript", "python"]),
  source: z.string().min(1).max(16384),
}).strict();
export interface CodeRunResult {
  language: string; status: string; exitCode: number | null; output: string; errors: string;
  truncated: boolean; durationMs: number; network: boolean; isolation: "job-object" | "sampling";
  /** macOS and Linux: what the system itself held, when the script ran in a limited process group. */
  heldBySystem?: HeldBySystem;
  /** How tightly the script was held: the owner's rule for this tool, or the script settings. */
  sandbox: SandboxChoice;
  /** Where it actually ran: this computer, a container, the Linux side, or the throwaway desktop. */
  backend: SandboxBackendName;
  /** The folder it could see, relative to the workspace; "." when it could see the whole thing. */
  folder: string;
}

export class CodeRunner {
  constructor(
    private readonly store: Store, private readonly owner: string, private readonly workspace: string,
    private readonly jobs: JobObjects = defaultJobObjects(),
    /** How a backend is looked for, and how one is started. Both replaced in tests, so no
     * container, distribution or throwaway desktop is ever really started. */
    private readonly probe: SandboxProbe = defaultSandboxProbe(),
    private readonly spawn?: SandboxSpawn,
  ) {}
  /** Every backend, built from the owner's settings at the moment of the call. */
  private backends(): Record<SandboxBackendName, SandboxBackend> {
    const settings = SandboxBackendSettingsSchema.parse(this.store.get("settings", this.owner, "sandbox-backends")?.data ?? {});
    return sandboxBackendSet({ settings, probe: this.probe, spawn: this.spawn ?? defaultSandboxSpawnFor(this.jobs) });
  }
  /**
   * What starts the script. On this computer that is the owner's own Node or Python; inside a
   * container or on the Linux side it is whatever that place calls them, because this computer's
   * program is not there and its address would mean nothing.
   */
  private program(language: "javascript" | "python", backend: SandboxBackendName, python: string): string {
    const elsewhere = backend === "docker" || backend === "wsl";
    if (language === "python") return elsewhere ? "python3" : python;
    return elsewhere ? "node" : process.execPath;
  }
  async run(input: z.infer<typeof CodeRunInputSchema>, context: ToolContext): Promise<CodeRunResult> {
    const settings = codeRunSettings(this.store, this.owner);
    if (!settings.enabled)
      throw new Error("Running small scripts is switched off. The owner turns it on in Settings, where they also choose whether a script may reach the internet.");
    // An approval rule may say how tightly this is held and where it runs; without one the script
    // settings decide, exactly as they did before rules could say anything about it.
    const shape = sandboxShape(context.sandbox, { job: true, netless: !settings.network });
    // The script is read before anything at all is started, so an obvious mistake costs nothing.
    const verdict = checkCodeBlock(input.source, { language: input.language, network: !shape.netless });
    if (!verdict.ok) throw new Error(verdict.reason);
    const backend = await chooseSandboxBackend(this.backends(), context.sandboxBackend);
    if (input.language === "python" && !settings.python && backend.name !== "docker" && backend.name !== "wsl")
      throw new Error("No Python is set up on this computer. The owner points at theirs in Settings, or ask for JavaScript instead.");
    const folder = context.sandboxPaths?.[0] ?? ".";
    const root = await new WorkspaceFiles(this.workspace).checked(".", true);
    // FQ-security.containers: a container is one agent's own folder, not the shared workspace, so
    // one agent's container can never see another's files — every other backend is unchanged.
    const slice = backend.name === "docker"
      ? await agentContainerSlice(root, context.agent, context.sandboxPaths ?? [])
      : await sliceFor(root, context.sandboxPaths ?? []);
    const handle = await backend.prepare(slice);
    const limits = { timeoutMs: settings.timeoutMs, maxMemoryMb: settings.maxMemoryMb,
      maxCpuSeconds: settings.maxCpuSeconds, maxOutputBytes: settings.maxOutputBytes,
      network: !shape.netless, job: shape.job,
      // wave mac3 (os-sandbox): the wall, made stricter still when the script may not reach the internet.
      ...(context.osSandbox ? { wall: shape.netless ? { ...context.osSandbox, network: "none" as const } : context.osSandbox } : {}) };
    const executable = this.program(input.language, backend.name, settings.python);
    const args = input.language === "python" ? ["-c", input.source] : ["--input-type=module", "--eval", input.source];
    try {
      const result = await handle.run({ executable, args }, limits, context.signal);
      const sandbox = shapeChoice(shape);
      if (context.runId)
        this.store.event(context.runId, "code.ran", { language: input.language, status: result.status,
          exitCode: result.exitCode, sandbox, backend: backend.name, folder });
      return { language: input.language, status: result.status, exitCode: result.exitCode,
        output: result.stdout, errors: result.stderr, truncated: result.truncated,
        durationMs: result.durationMs, network: !shape.netless, isolation: result.isolation,
        ...(result.heldBySystem ? { heldBySystem: result.heldBySystem } : {}), sandbox, backend: backend.name, folder };
    } finally {
      await handle.collect(["branch-output.txt"]).catch(() => undefined);
      await handle.dispose().catch(() => undefined);
    }
  }
}

export function registerCodeRun(registry: ToolRegistry, runner: CodeRunner): void {
  registry.register({
    name: "code.run", permission: "code.execute", group: "code",
    description: "Run a small script you have just written (JavaScript, or Python when the owner has one) in a program of its own, started in the workspace, with a time, memory and output limit and no way out to the internet unless the owner allows it. Use it for a calculation or a quick check, not for changing files.",
    parameters: CodeRunInputSchema,
    target: (args) => `a small ${args.language === "python" ? "Python" : "JavaScript"} script`,
    execute: (args, context) => runner.run(args, context),
  });
}
