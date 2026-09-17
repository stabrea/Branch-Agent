import { stat } from 'node:fs/promises';
import { WorkspaceFiles } from '../files.js';
import type { ToolContext } from '../contracts.js';
import type { ToolRegistry } from '../registry.js';
import { ShellConfigSchema, ShellInputSchema, shellEnvironment, netlessEnvironment, validateExecutables, type ShellConfig, type ShellInput } from './shell-config.js';
import { ShellProcess, type ProcessResult } from './shell-process.js';
import { defaultJobObjects, type Job, type JobObjects } from './job-object.js';
import { scrubSecrets } from '../locker.js';
import { sandboxShape, shapeChoice, type WallContext } from '../sandbox.js';
import { openWall } from '../sandbox-backends.js'; // wave mac3 (os-sandbox)

/** Longest a command waits for its Windows job object before running with sampled limits. */
const jobStartupMs = 1000;

export type SecretResolver = (context: ToolContext, names: string[]) => Promise<Record<string, string>>;
export interface ShellTarget {
  alias: string; executable: string; cwd: string; secrets: string[];
  /** Whether this command was pointed at a dead address instead of the internet. */
  netless: boolean;
  isolation: 'job-object' | 'sampling';
}

interface Operation { controller: AbortController; owner: string; runId: string; done: Promise<unknown> }
export class BranchShell {
  private readonly config: ShellConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly pending = new Set<Operation>();
  private closed = false;
  private spare: Job | null = null;
  constructor(input: unknown, env = process.env, private readonly secrets?: SecretResolver,
    private readonly jobs: JobObjects = defaultJobObjects()) {
    this.config = ShellConfigSchema.parse(input);
    this.env = shellEnvironment(this.config, env);
  }
  async ready(): Promise<void> { await validateExecutables(this.config); }
  execute(input: ShellInput, context: ToolContext): Promise<ProcessResult & { target: ShellTarget }> {
    if (this.closed) return Promise.reject(new Error('Host command execution is closed'));
    if (this.pending.size) return Promise.reject(new Error('A host command is already active'));
    if (!context.owner || !context.runId) return Promise.reject(new Error('Host commands require an owner and run ID'));
    const parsed = ShellInputSchema.parse(input);
    const operation: Operation = { controller: new AbortController(), owner: context.owner, runId: context.runId, done: Promise.resolve() };
    this.pending.add(operation);
    const done = this.perform(parsed, context, operation.controller.signal);
    operation.done = done;
    void done.finally(() => this.pending.delete(operation)).catch(() => undefined);
    return done;
  }
  private async perform(input: ShellInput, context: ToolContext, stopping: AbortSignal) {
    const executable = Object.hasOwn(this.config.executables, input.executable) ? this.config.executables[input.executable] : undefined;
    if (!executable) throw new Error('Executable alias is not configured');
    const signal = AbortSignal.any([context.signal, stopping]);
    signal.throwIfAborted();
    const cwd = await new WorkspaceFiles(context.workspace).checked(input.cwd, true);
    if (!(await stat(cwd)).isDirectory()) throw new Error('Command cwd must be a workspace directory');
    if (input.timeoutMs && input.timeoutMs > this.config.timeoutMs) throw new Error('Command timeout exceeds configured maximum');
    signal.throwIfAborted();
    const injected = await this.injected(input.secrets, context);
    // An approval rule may say how tightly this command is held; without one the shell settings and
    // the call's own `netless` decide, exactly as they did before rules could say anything about it.
    const shape = sandboxShape(context.sandbox,
      { job: this.config.useJobObject, netless: input.netless ?? this.config.netless });
    const netless = shape.netless;
    const job = shape.job ? await this.job() : null;
    const result = await this.spawn({ executable, args: input.args, cwd, injected, netless, job,
      timeoutMs: input.timeoutMs ?? this.config.timeoutMs, signal,
      // wave mac3 (os-sandbox): a command pointed at the dead address gets no network behind the wall either.
      wall: context.osSandbox && netless ? { ...context.osSandbox, network: 'none' as const } : context.osSandbox, workspace: context.workspace });
    const scrubbed = { ...result, stdout: scrubSecrets(result.stdout, injected), stderr: scrubSecrets(result.stderr, injected) };
    return { ...scrubbed, target: { alias: input.executable, executable: executable.path, cwd,
      secrets: Object.keys(injected), netless, isolation: result.isolation, sandbox: shapeChoice(shape) } };
  }
  /** A Windows job to hold this command, where the computer offers one; null means sampled limits. */
  private async job(): Promise<Job | null> {
    if (!this.config.useJobObject) return null;
    // A supervisor that came ready after an earlier command had already started serves the next one.
    if (this.spare) { const ready = this.spare; this.spare = null; return ready; }
    const pending = this.jobs.create({ maxMemoryMb: this.config.maxMemoryMb, maxCpuSeconds: this.config.maxCpuSeconds }).catch(() => null);
    // The supervisor compiles a little C# on start; on a cold computer that can take many seconds.
    // A command never waits longer than this for it: the limits fall back to sampling instead.
    const job = await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), jobStartupMs).unref())]);
    if (job === null) void pending.then((late) => { if (!late) return; if (this.closed || this.spare) void late.close().catch(() => undefined); else this.spare = late; });
    return job;
  }
  private async spawn(run: { executable: { path: string; args: string[] }; args: string[]; cwd: string;
    injected: Record<string, string>; netless: boolean; job: Job | null; timeoutMs: number; signal: AbortSignal;
    wall?: WallContext | undefined; workspace: string }): Promise<ProcessResult> {
    // The environment is built from an allowlist only, then the dead-address proxy, then secrets.
    const env = { ...this.env, ...(run.netless ? netlessEnvironment() : {}), ...run.injected };
    // wave mac3 (os-sandbox): behind the wall when the owner's switch says so. A saved key the owner
    // tied to a site reaches the program only as a stand-in; the wall's door swaps the real one in.
    const plain = { executable: run.executable.path, args: [...run.executable.args, ...run.args], cwd: run.cwd, env };
    const wall = run.wall ? await openWall(run.wall, plain, { workspace: run.workspace, secrets: run.injected }) : null;
    const start = wall?.start ?? plain;
    try {
      const result = await new ShellProcess({ executable: start.executable, args: start.args,
        cwd: run.cwd, env: start.env, signal: run.signal, timeoutMs: run.timeoutMs, maxOutputBytes: this.config.maxOutputBytes,
        maxMemoryMb: this.config.maxMemoryMb, maxCpuSeconds: this.config.maxCpuSeconds, job: run.job ?? undefined }).run();
      const note = wall ? await wall.finish(result) : null;
      return note ? { ...result, stderr: `${result.stderr}${result.stderr && !result.stderr.endsWith('\n') ? '\n' : ''}${note}` } : result;
    } catch (error) {
      await run.job?.close().catch(() => undefined);
      throw error;
    } finally {
      await wall?.close();
    }
  }
  /** Secret values exist only in the child's environment; the model sees names and scrubbed output. */
  private async injected(names: string[], context: ToolContext): Promise<Record<string, string>> {
    if (!names.length) return {};
    if (!this.secrets) throw new Error('Secrets are not available to host commands in this launch');
    return this.secrets(context, names);
  }
  async closeRun(context: Pick<ToolContext, 'owner' | 'runId'>): Promise<void> {
    const operations = [...this.pending].filter(operation => operation.owner === context.owner && operation.runId === context.runId);
    for (const operation of operations) operation.controller.abort(new Error('Run finished'));
    await Promise.allSettled(operations.map(operation => operation.done));
  }
  async close(): Promise<void> {
    this.closed = true;
    const spare = this.spare; this.spare = null;
    if (spare) await spare.close().catch(() => undefined);
    const operations = [...this.pending];
    for (const operation of operations) operation.controller.abort(new Error('Host command execution closed'));
    await Promise.allSettled(operations.map(operation => operation.done));
  }
}

export function registerShell(registry: ToolRegistry, shell: BranchShell): void {
  registry.onRunFinished(context => shell.closeRun(context));
  registry.register({ name: 'shell.execute', permission: 'shell.execute', parameters: ShellInputSchema,
    description: 'Run a configured trusted host executable alias with argument arrays in a workspace directory. Name secrets from the active project in `secrets` to expose them to the program as environment variables; their values never appear in results. Set `netless` to point the command at a dead local address so tools that respect proxy settings cannot reach the internet (best effort, not a firewall). On Windows the command is placed in a job object so the system enforces the memory and processor limits and kills the whole tree afterwards; where that is unavailable the limits are sampled instead. This is still host execution, not OS isolation: programs can read the host filesystem and launch other programs.',
    execute: (input, context) => shell.execute(input, context) });
}
