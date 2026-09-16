import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import { WorkspaceFiles } from "./files.js";
import { ShellProcess } from "./integrations/shell-process.js";
import { netlessEnvironment } from "./integrations/shell-config.js";
import { defaultJobObjects, jobWithin, type JobObjects } from "./integrations/job-object.js";

/**
 * Running a small script the assistant just wrote: a sum, a bit of reshaping, a quick check. It runs
 * in a brand-new program of its own, started in the workspace, with the same memory and processor
 * ceilings a host command gets and no way out to the internet unless the owner says otherwise. This
 * is a limit on resources, not a sandbox: the script runs on this computer with this app's reach, so
 * it is off until the owner switches it on.
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
  return parsed.success ? parsed.data : CodeRunSettingsSchema.parse({});
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
}

export class CodeRunner {
  constructor(
    private readonly store: Store, private readonly owner: string, private readonly workspace: string,
    private readonly jobs: JobObjects = defaultJobObjects(),
  ) {}
  async run(input: z.infer<typeof CodeRunInputSchema>, context: ToolContext): Promise<CodeRunResult> {
    const settings = codeRunSettings(this.store, this.owner);
    if (!settings.enabled)
      throw new Error("Running small scripts is switched off. The owner turns it on in Settings, where they also choose whether a script may reach the internet.");
    if (input.language === "python" && !settings.python)
      throw new Error("No Python is set up on this computer. The owner points at theirs in Settings, or ask for JavaScript instead.");
    const executable = input.language === "python" ? settings.python : process.execPath;
    const args = input.language === "python" ? ["-c", input.source] : ["--input-type=module", "--eval", input.source];
    const cwd = await new WorkspaceFiles(this.workspace).checked(".", true);
    const job = await jobWithin(this.jobs, { maxMemoryMb: settings.maxMemoryMb, maxCpuSeconds: settings.maxCpuSeconds }, 1500);
    const result = await new ShellProcess({
      executable, args, cwd,
      env: { PATH: "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", TEMP: process.env.TEMP ?? "",
        ...(settings.network ? {} : netlessEnvironment()) },
      signal: context.signal, timeoutMs: settings.timeoutMs, maxOutputBytes: settings.maxOutputBytes,
      maxMemoryMb: settings.maxMemoryMb, maxCpuSeconds: settings.maxCpuSeconds, ...(job ? { job } : {}),
    }).run();
    if (context.runId)
      this.store.event(context.runId, "code.ran", { language: input.language, status: result.status, exitCode: result.exitCode });
    return { language: input.language, status: result.status, exitCode: result.exitCode,
      output: result.stdout, errors: result.stderr, truncated: result.truncated,
      durationMs: result.durationMs, network: settings.network, isolation: result.isolation };
  }
}

export function registerCodeRun(registry: ToolRegistry, runner: CodeRunner): void {
  registry.register({
    name: "code.run", permission: "shell.execute", group: "code",
    description: "Run a small script you have just written (JavaScript, or Python when the owner has one) in a program of its own, started in the workspace, with a time, memory and output limit and no way out to the internet unless the owner allows it. Use it for a calculation or a quick check, not for changing files.",
    parameters: CodeRunInputSchema,
    target: (args) => `a small ${args.language === "python" ? "Python" : "JavaScript"} script`,
    execute: (args, context) => runner.run(args, context),
  });
}
