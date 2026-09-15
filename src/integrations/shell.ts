import { stat } from 'node:fs/promises';
import { WorkspaceFiles } from '../files.js';
import type { ToolContext } from '../contracts.js';
import type { ToolRegistry } from '../registry.js';
import { ShellConfigSchema, ShellInputSchema, shellEnvironment, validateExecutables, type ShellConfig, type ShellInput } from './shell-config.js';
import { ShellProcess, type ProcessResult } from './shell-process.js';

interface Operation { controller: AbortController; owner: string; runId: string; done: Promise<unknown> }
export class BranchShell {
  private readonly config: ShellConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly pending = new Set<Operation>();
  private closed = false;
  constructor(input: unknown, env = process.env) {
    this.config = ShellConfigSchema.parse(input);
    this.env = shellEnvironment(this.config, env);
  }
  async ready(): Promise<void> { await validateExecutables(this.config); }
  execute(input: ShellInput, context: ToolContext): Promise<ProcessResult & { target: Record<string, string> }> {
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
    const process = new ShellProcess({ executable: executable.path, args: [...executable.args, ...input.args], cwd, env: this.env,
      signal, timeoutMs: input.timeoutMs ?? this.config.timeoutMs, maxOutputBytes: this.config.maxOutputBytes });
    const result = await process.run();
    return { ...result, target: { alias: input.executable, executable: executable.path, cwd } };
  }
  async closeRun(context: Pick<ToolContext, 'owner' | 'runId'>): Promise<void> {
    const operations = [...this.pending].filter(operation => operation.owner === context.owner && operation.runId === context.runId);
    for (const operation of operations) operation.controller.abort(new Error('Run finished'));
    await Promise.allSettled(operations.map(operation => operation.done));
  }
  async close(): Promise<void> {
    this.closed = true;
    const operations = [...this.pending];
    for (const operation of operations) operation.controller.abort(new Error('Host command execution closed'));
    await Promise.allSettled(operations.map(operation => operation.done));
  }
}

export function registerShell(registry: ToolRegistry, shell: BranchShell): void {
  registry.onRunFinished(context => shell.closeRun(context));
  registry.register({ name: 'shell.execute', permission: 'shell.execute', parameters: ShellInputSchema,
    description: 'Run a configured trusted host executable alias with argument arrays in a workspace directory. This is host execution, not OS isolation: programs can access the host and launch other programs. Output and time are bounded; escaped descendants may survive cancellation.',
    execute: (input, context) => shell.execute(input, context) });
}
