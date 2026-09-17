import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import { WorkspaceFiles } from "./files.js";
import { killProcessGroup, killWindowsTree } from "./integrations/shell-process.js";
import { defaultJobObjects, jobWithin, startedThrough, type Job, type JobObjects } from "./integrations/job-object.js";
import { fromTheTop, netlessEnvironment } from "./integrations/shell-config.js";
import { sandboxShape, shapeChoice, type SandboxChoice } from "./sandbox.js";
import {
  chooseSandboxBackend, defaultSandboxProbe, sandboxBackendSet, sliceFor,
  SandboxBackendSettingsSchema, type SandboxBackendName, type SandboxProbe, type SandboxStart,
} from "./sandbox-backends.js";

/**
 * Some programs are meant to keep going: a website being built as you edit it, a watcher, a little
 * server. They outlive the tool call that started them. Each one is held under the same Windows job
 * the one-off commands use, so the operating system enforces its memory and processor limits and
 * kills whatever it left behind; what it prints is kept in a small rolling buffer, the newest at the
 * end. Nothing survives the conversation it belongs to, and nothing survives the app closing.
 */
const alias = z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/);
export const BackgroundSettingsSchema = z.object({
  /** Programs the owner is willing to leave running, each under a short name they choose. */
  programs: z.record(alias, z.object({
    path: z.string().min(1).max(1000),
    args: z.array(z.string().max(500)).max(20).default([]),
  }).strict()).default({}),
  /** How many may be running at once across the whole app. */
  maxRunning: z.number().int().min(1).max(8).default(3),
  /** How long one may stay up before it is stopped anyway. */
  maxMinutes: z.number().int().min(1).max(720).default(120),
  maxMemoryMb: z.number().int().min(16).max(16384).default(2048),
  maxCpuSeconds: z.number().int().min(1).max(36000).default(1800),
  /** How much of what it printed is kept; the oldest is dropped first. */
  bufferBytes: z.number().int().min(1024).max(131072).default(16384),
}).strict();
export type BackgroundSettings = z.infer<typeof BackgroundSettingsSchema>;

export function backgroundSettings(store: Store, owner: string): BackgroundSettings {
  const parsed = BackgroundSettingsSchema.safeParse(store.get("settings", owner, "background-processes")?.data ?? {});
  return parsed.success ? parsed.data : BackgroundSettingsSchema.parse({});
}
/** Saves the list, refusing a program that is not there or is a wrapper script. */
export async function saveBackgroundSettings(store: Store, owner: string, input: unknown): Promise<BackgroundSettings> {
  const value = BackgroundSettingsSchema.parse(input ?? {});
  for (const [name, program] of Object.entries(value.programs)) {
    if (!isAbsolute(program.path)) throw new Error(`Give "${name}" in full, ${fromTheTop()}.`);
    if (/\.(cmd|bat)$/i.test(program.path)) throw new Error(`Name the real program for "${name}", not a .cmd or .bat wrapper.`);
    if (!(await stat(program.path).catch(() => null))?.isFile()) throw new Error(`There is no program at the address given for "${name}".`);
  }
  store.save("settings", owner, "background-processes", { ...value });
  return value;
}

export interface ProcessView {
  id: string; name: string; program: string; pid: number | null; sessionId: string; runId: string;
  status: "running" | "finished" | "stopped" | "failed"; startedAt: string; endedAt: string | null;
  exitCode: number | null; isolation: "job-object" | "sampling"; bytes: number; dropped: boolean;
}

/** One program left running, with what it has printed so far. */
class Running {
  readonly id = randomUUID();
  readonly startedAt = new Date().toISOString();
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  dropped = false;
  status: ProcessView["status"] = "running";
  endedAt: string | null = null;
  exitCode: number | null = null;
  private timer: NodeJS.Timeout;
  /** Set the moment the owner asks for it to stop, so the kill's own exit code is not read as a failure. */
  private asked = false;
  constructor(
    readonly name: string, readonly program: string, readonly sessionId: string, readonly runId: string,
    private readonly child: ChildProcess, private readonly job: Job | null,
    private readonly bufferBytes: number, maxMinutes: number,
  ) {
    child.stdout?.on("data", (chunk: Buffer) => this.keep(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.keep(chunk));
    child.once("error", () => { this.settle("failed"); });
    child.once("exit", (code) => { this.exitCode = code; this.settle(code === 0 ? "finished" : "failed"); });
    this.timer = setTimeout(() => { void this.stop(); }, maxMinutes * 60000);
    this.timer.unref();
  }
  private keep(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.bufferBytes && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.length;
      this.dropped = true;
    }
  }
  private settle(status: ProcessView["status"]): void {
    if (this.status !== "running") return;
    // A program the owner stopped counts as stopped, whatever exit code the kill itself produced.
    this.status = this.asked ? "stopped" : status;
    this.endedAt = new Date().toISOString();
    clearTimeout(this.timer);
    void this.job?.close().catch(() => undefined);
  }
  /** What it has printed, newest at the end, and whether anything older was dropped. */
  output(limit: number): { text: string; dropped: boolean } {
    const text = Buffer.concat(this.chunks).toString("utf8");
    return { text: text.length > limit ? text.slice(text.length - limit) : text, dropped: this.dropped || text.length > limit };
  }
  view(): ProcessView {
    return { id: this.id, name: this.name, program: this.program, pid: this.child.pid ?? null,
      sessionId: this.sessionId, runId: this.runId, status: this.status, startedAt: this.startedAt,
      endedAt: this.endedAt, exitCode: this.exitCode, isolation: this.job?.kind === "job-object" ? "job-object" : "sampling",
      bytes: this.bytes, dropped: this.dropped };
  }
  /** Stops it and everything it started; letting the job go is what really clears the tree. */
  async stop(): Promise<ProcessView> {
    const pid = this.child.pid;
    this.asked = true;
    if (this.status === "running" && pid) {
      try {
        if (process.platform === "win32") await killWindowsTree(pid);
        else await killProcessGroup(pid);
      } catch { /* the job being let go is the real cleanup */ }
    }
    this.settle("stopped");
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    return this.view();
  }
}

export const StartInputSchema = z.object({
  program: alias.describe("The short name of one of the programs the owner allows to be left running."),
  args: z.array(z.string().max(500).refine((value) => !value.includes("\0"), "NUL is not permitted")).max(40).default([]),
  cwd: z.string().min(1).max(500).default("."),
  /** A name the owner will see in the list, such as "website preview". */
  name: z.string().trim().min(1).max(60).default("a program"),
}).strict();

export class BackgroundProcesses {
  private readonly running = new Map<string, Running>();
  constructor(
    private readonly store: Store, private readonly owner: string, private readonly workspace: string,
    private readonly jobs: JobObjects = defaultJobObjects(),
    /** How a backend is looked for. Replaced in tests, so no container is ever started. */
    private readonly probe: SandboxProbe = defaultSandboxProbe(),
  ) {}
  settings(): BackgroundSettings { return backgroundSettings(this.store, this.owner); }
  /** Starts a program and leaves it running; the tool call is over long before the program is. */
  async start(input: z.infer<typeof StartInputSchema>, context: ToolContext): Promise<ProcessView & { sandbox: SandboxChoice; backend: SandboxBackendName }> {
    const settings = this.settings();
    const program = Object.hasOwn(settings.programs, input.program) ? settings.programs[input.program] : undefined;
    if (!program) throw new Error(`"${input.program}" is not one of the programs allowed to be left running. The owner adds those in Settings.`);
    if (this.list({ active: true }).length >= settings.maxRunning)
      throw new Error(`${settings.maxRunning} programs are already running; stop one before starting another.`);
    const cwd = await new WorkspaceFiles(this.workspace).checked(input.cwd, true);
    // An approval rule may say how tightly a program left running is held. Without one it is held
    // to its limits and left able to reach the internet, exactly as it was before.
    const shape = sandboxShape(context.sandbox, { job: true, netless: false });
    const job = shape.job
      ? await jobWithin(this.jobs, { maxMemoryMb: settings.maxMemoryMb, maxCpuSeconds: settings.maxCpuSeconds }, 1500)
      : null;
    // A rule may also say where it runs. The backend wraps the command — a container run, a call
    // into the Linux side — and the program left running is that wrapper, so stopping it stops
    // what it started. A backend that is not on this computer refuses here, before anything starts.
    const start = await this.wrapped(context, cwd,
      { executable: program.path, args: [...program.args, ...input.args] }, shape, settings);
    // On macOS and Linux the limits are set as the program starts, so the job may change how it starts.
    const argv = startedThrough(job, { executable: start.executable, args: start.args });
    const child = spawn(argv.executable, argv.args, { cwd: start.cwd, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: start.env });
    if (job && child.pid) await job.assign(child.pid).catch(() => false);
    const entry = new Running(input.name, input.program, this.sessionOf(context), context.runId, child, job,
      settings.bufferBytes, settings.maxMinutes);
    this.running.set(entry.id, entry);
    if (context.runId) this.store.event(context.runId, "process.started", { id: entry.id, name: entry.name, program: entry.program, pid: child.pid ?? null, sandbox: shapeChoice(shape), backend: context.sandboxBackend ?? "job-object" });
    return { ...entry.view(), sandbox: shapeChoice(shape), backend: context.sandboxBackend ?? "job-object" };
  }

  /**
   * The command as the chosen backend would start it. With no rule naming one this is the command
   * itself, unchanged, which is what a program left running has always been.
   */
  private async wrapped(
    context: ToolContext, cwd: string, command: { executable: string; args: string[] },
    shape: { job: boolean; netless: boolean }, settings: BackgroundSettings,
  ): Promise<SandboxStart> {
    const chosen = SandboxBackendSettingsSchema.parse(this.store.get("settings", this.owner, "sandbox-backends")?.data ?? {});
    const backend = await chooseSandboxBackend(sandboxBackendSet({ settings: chosen, probe: this.probe }), context.sandboxBackend);
    const handle = await backend.prepare(await sliceFor(cwd, context.sandboxPaths ?? []));
    const start = await handle.argvFor(command, { timeoutMs: settings.maxMinutes * 60_000,
      maxMemoryMb: settings.maxMemoryMb, maxCpuSeconds: settings.maxCpuSeconds,
      maxOutputBytes: settings.bufferBytes, network: !shape.netless, job: shape.job });
    return start;
  }
  /** The conversation a task belongs to: what a program is filed under and read back by. */
  sessionOf(context: ToolContext): string {
    return this.store.run(context.runId)?.sessionId ?? context.runId;
  }
  list(options: { active?: boolean; sessionId?: string } = {}): ProcessView[] {
    return [...this.running.values()].map((entry) => entry.view())
      .filter((view) => (!options.active || view.status === "running") && (!options.sessionId || view.sessionId === options.sessionId))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
  /**
   * What one program has printed so far, the newest at the end. When a conversation is named, a
   * program another conversation started is simply not there — the same words as a wrong number,
   * so one conversation cannot find out what another one is running.
   */
  read(id: string, limit = 4000, sessionId?: string): ProcessView & { output: string } {
    const entry = this.running.get(id);
    if (!entry || (sessionId !== undefined && entry.sessionId !== sessionId))
      throw new Error("There is no program with that number");
    const { text, dropped } = entry.output(limit);
    return { ...entry.view(), dropped, output: text };
  }
  /** Stopping is scoped the same way reading is, so one conversation cannot stop another's work. */
  async stop(id: string, context?: ToolContext, sessionId?: string): Promise<ProcessView> {
    const entry = this.running.get(id);
    if (!entry || (sessionId !== undefined && entry.sessionId !== sessionId))
      throw new Error("There is no program with that number");
    const view = await entry.stop();
    if (context?.runId) this.store.event(context.runId, "process.stopped", { id: view.id, name: view.name, exitCode: view.exitCode });
    return view;
  }
  /** Everything started in one conversation goes when that conversation does. */
  async closeSession(sessionId: string): Promise<number> {
    const mine = [...this.running.values()].filter((entry) => entry.sessionId === sessionId && entry.status === "running");
    await Promise.allSettled(mine.map((entry) => entry.stop()));
    return mine.length;
  }
  /** Closing the app stops everything; nothing is left behind for the next launch to find. */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map((entry) => entry.stop()));
    this.running.clear();
  }
}

export function registerProcesses(registry: ToolRegistry, processes: BackgroundProcesses): void {
  registry.register({
    name: "process.start", permission: "process.manage", group: "code",
    description: "Start one of the programs the owner allows to be left running (a preview server, a watcher) and leave it going after this step is over. What it prints is kept in a rolling buffer you can read later. It stops when this conversation ends or the app closes.",
    parameters: StartInputSchema,
    target: (args) => `${args.program} ${args.args.join(" ")}`.trim().slice(0, 300),
    execute: (args, context) => processes.start(args, context),
  });
  registry.register({
    name: "process.list", permission: "process.read", group: "code",
    description: "What this conversation has left running, what each one is, and whether it is still going. Programs other conversations started are not listed here; the owner sees all of them in the Activity screen.",
    parameters: z.object({}).strict(),
    execute: async (_args, context) => ({ processes: processes.list({ sessionId: processes.sessionOf(context) }) }),
  });
  registry.register({
    name: "process.read", permission: "process.read", group: "code",
    description: "Read what a running program has printed so far. Only the most recent part is kept; the answer says when older output was dropped.",
    parameters: z.object({ id: z.string().uuid(), characters: z.number().int().min(100).max(8000).default(4000) }).strict(),
    execute: async (args, context) => processes.read(args.id, args.characters, processes.sessionOf(context)),
  });
  registry.register({
    name: "process.stop", permission: "process.manage", group: "code",
    description: "Stop a running program and everything it started.",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    execute: (args, context) => processes.stop(args.id, context, processes.sessionOf(context)),
  });
}
