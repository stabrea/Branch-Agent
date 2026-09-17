import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import { WorkspaceFiles } from "./files.js";
import { killProcessGroup, killWindowsTree } from "./integrations/shell-process.js";
import { defaultJobObjects, jobWithin, type Job, type JobObjects } from "./integrations/job-object.js";
import { ShellConfigSchema, shellEnvironment, type ShellConfig } from "./integrations/shell-config.js";
import { backgroundSettings, type BackgroundSettings } from "./processes.js";

/**
 * A command line the owner can keep open. An ordinary command starts a program, waits for it and
 * lets it go, so nothing carries from one command to the next: not the folder it was in, not what
 * it had loaded, not a sign-in it had done. A kept-open shell is the same program left running with
 * its input still attached, so a second command lands in the same place as the first, in a later
 * task and even in a later conversation of the same sitting.
 *
 * It is held to exactly what any other command is held to: the same list of programs the owner
 * allows, the same environment built from an allowlist, the same Windows job enforcing memory and
 * processor limits, the same rolling output buffer, and the same approval rules, which are asked
 * again for every command sent rather than once when the shell was opened. It is never a window on
 * the screen, and it does not outlive the app.
 */
const alias = z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/);
export const OpenShellSchema = z.object({
  program: alias.describe("One of the programs the owner allows commands to be run with."),
  args: z.array(z.string().max(500).refine((v) => !v.includes("\0"), "NUL is not permitted")).max(20).default([]),
  cwd: z.string().min(1).max(500).default("."),
  name: z.string().trim().min(1).max(60).default("a command line"),
}).strict();
export const SendToShellSchema = z.object({
  id: z.string().uuid(),
  input: z.string().min(1).max(4000).refine((v) => !v.includes("\0"), "NUL is not permitted"),
  /** Longest to wait for this command's answer before handing back what there is so far. */
  waitMs: z.number().int().min(100).max(60000).default(5000),
}).strict();
export const ShellSessionReadSchema = z.object({
  id: z.string().uuid().optional(),
  characters: z.number().int().min(100).max(8000).default(2000),
}).strict();
export const CloseShellSchema = z.object({ id: z.string().uuid() }).strict();

export interface ShellSessionView {
  id: string; name: string; program: string; pid: number | null; sessionId: string;
  status: "open" | "closed" | "ended"; openedAt: string; endedAt: string | null;
  exitCode: number | null; commands: number; isolation: "job-object" | "sampling";
  bytes: number; dropped: boolean;
}

/** One kept-open command line and everything it has printed lately. */
class OpenShell {
  readonly id = randomUUID();
  readonly openedAt = new Date().toISOString();
  status: ShellSessionView["status"] = "open";
  endedAt: string | null = null;
  exitCode: number | null = null;
  commands = 0;
  dropped = false;
  /** Set the moment the owner asks it to close, so the program's own goodbye is not read as an end. */
  private asked = false;
  private kept = "";
  private since = "";
  private lastAt = 0;
  private readonly timer: NodeJS.Timeout;
  constructor(
    readonly name: string, readonly program: string, readonly sessionId: string,
    private readonly child: ChildProcess, private readonly job: Job | null,
    private readonly bufferBytes: number, maxMinutes: number,
  ) {
    child.stdout?.on("data", (chunk: Buffer) => this.keep(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.keep(chunk));
    child.once("error", () => this.settle("ended"));
    child.once("exit", (code) => { this.exitCode = code; this.settle("ended"); });
    this.timer = setTimeout(() => { void this.close(); }, maxMinutes * 60000);
    this.timer.unref();
  }
  private keep(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    this.kept += text;
    this.since += text;
    this.lastAt = Date.now();
    if (this.kept.length > this.bufferBytes) {
      this.kept = this.kept.slice(this.kept.length - this.bufferBytes);
      this.dropped = true;
    }
  }
  private settle(status: ShellSessionView["status"]): void {
    if (this.status !== "open") return;
    // A command line the owner closed counts as closed, however the program itself chose to go.
    this.status = this.asked ? "closed" : status;
    this.endedAt = new Date().toISOString();
    clearTimeout(this.timer);
    void this.job?.close().catch(() => undefined);
  }
  /** Sends one line and hands back what came of it, once the answer has gone quiet. */
  async send(input: string, waitMs: number, quietMs: number): Promise<string> {
    if (this.status !== "open") throw new Error("That command line is no longer open.");
    this.since = ""; this.lastAt = 0; this.commands++;
    this.child.stdin?.write(`${input}\n`);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (this.since && Date.now() - this.lastAt >= quietMs) break;
      await new Promise((resolve) => setTimeout(resolve, 20).unref());
    }
    return this.since;
  }
  output(limit: number): { text: string; dropped: boolean } {
    const text = this.kept.length > limit ? this.kept.slice(this.kept.length - limit) : this.kept;
    return { text, dropped: this.dropped || this.kept.length > limit };
  }
  view(): ShellSessionView {
    return { id: this.id, name: this.name, program: this.program, pid: this.child.pid ?? null,
      sessionId: this.sessionId, status: this.status, openedAt: this.openedAt, endedAt: this.endedAt,
      exitCode: this.exitCode, commands: this.commands, isolation: this.job ? "job-object" : "sampling",
      bytes: this.kept.length, dropped: this.dropped };
  }
  /** Closes it and everything it started; letting the job go is what really clears the tree. */
  async close(): Promise<ShellSessionView> {
    const pid = this.child.pid;
    this.asked = true;
    if (this.status === "open" && pid) {
      this.child.stdin?.end();
      try {
        if (process.platform === "win32") await killWindowsTree(pid);
        else await killProcessGroup(pid);
      } catch { /* the job being let go is the real cleanup */ }
    }
    this.settle("closed");
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    return this.view();
  }
}

/** How long a command's answer must be quiet before it counts as finished. */
const quietMs = 120;

export class ShellSessions {
  private readonly open = new Map<string, OpenShell>();
  private readonly config: ShellConfig;
  private readonly env: NodeJS.ProcessEnv;
  private closed = false;
  constructor(
    input: unknown, private readonly store: Store, private readonly owner: string,
    env: NodeJS.ProcessEnv = process.env, private readonly jobs: JobObjects = defaultJobObjects(),
  ) {
    this.config = ShellConfigSchema.parse(input);
    this.env = shellEnvironment(this.config, env);
  }
  /** The limits a kept-open shell is held to; the same ones a program left running is held to. */
  settings(): BackgroundSettings { return backgroundSettings(this.store, this.owner); }
  /** The conversation a shell is filed under: the one whose task opened it. */
  sessionOf(context: ToolContext): string {
    return this.store.run(context.runId)?.sessionId ?? context.runId;
  }
  async start(input: z.infer<typeof OpenShellSchema>, context: ToolContext): Promise<ShellSessionView> {
    if (this.closed) throw new Error("Commands are not being run in this launch any more.");
    const limits = this.settings();
    const program = Object.hasOwn(this.config.executables, input.program)
      ? this.config.executables[input.program] : undefined;
    if (!program) throw new Error(`"${input.program}" is not one of the programs commands may be run with.`);
    if (this.list({ active: true }).length >= limits.maxRunning)
      throw new Error(`${limits.maxRunning} command lines are already open; close one before opening another.`);
    const cwd = await new WorkspaceFiles(context.workspace).checked(input.cwd, true);
    const job = this.config.useJobObject
      ? await jobWithin(this.jobs, { maxMemoryMb: limits.maxMemoryMb, maxCpuSeconds: limits.maxCpuSeconds }, 1500)
      : null;
    const child = spawn(program.path, [...program.args, ...input.args], { cwd, shell: false,
      windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], env: this.env });
    if (job && child.pid) await job.assign(child.pid).catch(() => false);
    const shell = new OpenShell(input.name, input.program, this.sessionOf(context), child, job,
      limits.bufferBytes, limits.maxMinutes);
    this.open.set(shell.id, shell);
    if (context.runId) this.store.event(context.runId, "shell.session_opened",
      { id: shell.id, name: shell.name, program: shell.program, pid: child.pid ?? null });
    return shell.view();
  }
  /** Sends one command to a shell that is already open and hands back what it printed. */
  async send(input: z.infer<typeof SendToShellSchema>, context: ToolContext): Promise<ShellSessionView & { output: string }> {
    const shell = this.mine(input.id, this.sessionOf(context));
    const text = await shell.send(input.input, Math.min(input.waitMs, this.config.timeoutMs * 2), quietMs);
    if (context.runId) this.store.event(context.runId, "shell.session_command",
      { id: shell.id, characters: text.length, commands: shell.commands });
    return { ...shell.view(), output: text };
  }
  list(options: { active?: boolean; sessionId?: string } = {}): ShellSessionView[] {
    return [...this.open.values()].map((shell) => shell.view())
      .filter((view) => (!options.active || view.status === "open")
        && (!options.sessionId || view.sessionId === options.sessionId))
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  }
  /** What one kept-open shell has printed lately, newest at the end. */
  read(id: string, characters: number, sessionId?: string): ShellSessionView & { output: string } {
    const shell = this.mine(id, sessionId);
    const { text, dropped } = shell.output(characters);
    return { ...shell.view(), dropped, output: text };
  }
  async close(id: string, context?: ToolContext, sessionId?: string): Promise<ShellSessionView> {
    const shell = this.mine(id, sessionId);
    const view = await shell.close();
    if (context?.runId) this.store.event(context.runId, "shell.session_closed", { id: view.id, commands: view.commands });
    return view;
  }
  /** Everything opened in one conversation goes when that conversation does. */
  async closeSession(sessionId: string): Promise<number> {
    const mine = [...this.open.values()].filter((shell) => shell.sessionId === sessionId && shell.status === "open");
    await Promise.allSettled(mine.map((shell) => shell.close()));
    return mine.length;
  }
  /** Closing the app closes every kept-open shell; nothing is left behind for the next launch. */
  async closeAll(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.open.values()].map((shell) => shell.close()));
    this.open.clear();
  }
  /**
   * The shell with that number, when it belongs to the conversation asking. One another
   * conversation opened is simply not there, in the same words as a wrong number.
   */
  private mine(id: string, sessionId?: string): OpenShell {
    const shell = this.open.get(id);
    if (!shell || (sessionId !== undefined && shell.sessionId !== sessionId))
      throw new Error("There is no command line with that number");
    return shell;
  }
}

export function registerShellSessions(registry: ToolRegistry, shells: ShellSessions): void {
  registry.register({
    name: "shell.session.open", permission: "shell.execute", group: "code",
    description: "Open a command line and keep it open, so later commands land in the same place: the same folder, the same loaded state, the same sign-in. It is one of the programs the owner allows, held to the same limits as any other command, and it closes when the app does.",
    parameters: OpenShellSchema,
    target: (args) => `${args.program} ${args.args.join(" ")}`.trim().slice(0, 300),
    execute: (args, context) => shells.start(args, context),
  });
  registry.register({
    name: "shell.session.run", permission: "shell.execute", group: "code",
    description: "Send one command to a command line that is already open and read what it printed. Asked for permission the same way any other command is, every time.",
    parameters: SendToShellSchema,
    target: (args) => String(args.input).slice(0, 300),
    execute: (args, context) => shells.send(args, context),
  });
  registry.register({
    name: "shell.session.list", permission: "shell.execute", group: "code",
    description: "The command lines this conversation has open. Name one to read what it has printed lately as well.",
    parameters: ShellSessionReadSchema,
    execute: async (args, context) => {
      const sessionId = shells.sessionOf(context);
      if (args.id) return shells.read(args.id, args.characters, sessionId);
      return { sessions: shells.list({ sessionId }) };
    },
  });
  registry.register({
    name: "shell.session.close", permission: "shell.execute", group: "code",
    description: "Close a kept-open command line and everything it started.",
    parameters: CloseShellSchema,
    execute: (args, context) => shells.close(args.id, context, shells.sessionOf(context)),
  });
}
