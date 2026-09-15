import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

export type StopReason = 'cancelled' | 'timed_out' | 'output_limit' | 'descendant_pipes';
export interface ProcessResult {
  status: 'completed' | 'failed' | StopReason;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  truncated: boolean;
  observedOutputBytes: number;
  cleanup: { status: 'parent_exited' | 'tree_termination_requested' | 'incomplete'; strategy: string; limitation: string };
}
export interface ProcessOptions {
  executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  signal: AbortSignal; timeoutMs: number; maxOutputBytes: number;
}

export class ShellProcess {
  private readonly child: ChildProcess;
  private readonly started = performance.now();
  private readonly stdout: Buffer[] = [];
  private readonly stderr: Buffer[] = [];
  private kept = 0;
  private observed = 0;
  private exited = false;
  private closed = false;
  private failed = false;
  private reason: StopReason | undefined;
  private stopping: Promise<void> | undefined;
  private incomplete = false;
  private pipeTimer: NodeJS.Timeout | undefined;
  private readonly closedPromise: Promise<void>;
  private readonly donePromise: Promise<void>;
  private finish!: () => void;
  constructor(private readonly options: ProcessOptions) {
    this.child = spawn(options.executable, options.args, { cwd: options.cwd, env: options.env,
      shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout!.on('data', (chunk: Buffer) => this.capture(chunk, this.stdout));
    this.child.stderr!.on('data', (chunk: Buffer) => this.capture(chunk, this.stderr));
    this.child.on('error', () => { this.failed = true; });
    this.child.once('exit', () => this.parentExited());
    this.donePromise = new Promise(resolve => { this.finish = resolve; });
    this.closedPromise = new Promise(resolve => this.child.once('close', () => { this.closed = true; resolve(); this.finish(); }));
  }
  async run(): Promise<ProcessResult> {
    const abort = () => { void this.stop('cancelled'); };
    this.options.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { void this.stop('timed_out'); }, this.options.timeoutMs);
    if (this.options.signal.aborted) abort();
    try {
      await this.donePromise;
      await this.stopping;
      return this.result();
    } finally {
      clearTimeout(timeout);
      clearTimeout(this.pipeTimer);
      this.options.signal.removeEventListener('abort', abort);
    }
  }
  private capture(chunk: Buffer, destination: Buffer[]): void {
    this.observed += chunk.length;
    const keep = Math.min(chunk.length, this.options.maxOutputBytes - this.kept);
    if (keep > 0) destination.push(Buffer.from(chunk.subarray(0, keep)));
    this.kept += keep;
    if (keep < chunk.length) void this.stop('output_limit');
  }
  private parentExited(): void {
    this.exited = true;
    this.pipeTimer = setTimeout(() => {
      if (!this.closed) void this.stop('descendant_pipes');
    }, 250);
  }
  private stop(reason: StopReason): Promise<void> {
    this.reason ??= reason;
    return this.stopping ??= this.terminate();
  }
  private async terminate(): Promise<void> {
    const pid = this.child.pid;
    try { if (pid) {
      if (process.platform === 'win32') {
        if (this.exited) this.incomplete = true;
        else if (!(await killWindowsTree(pid))) this.incomplete = true;
      } else await killProcessGroup(pid);
    } } catch { this.incomplete = true; }
    if (!(await settledWithin(this.closedPromise, 1500))) {
      this.incomplete = true;
      if (!this.exited) this.child.kill('SIGKILL');
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
      if (!(await settledWithin(this.closedPromise, 500))) this.child.unref();
    }
    this.finish();
  }
  private result(): ProcessResult {
    return {
      status: this.reason ?? (this.failed || this.child.exitCode !== 0 ? 'failed' : 'completed'),
      stdout: Buffer.concat(this.stdout).toString('utf8'), stderr: Buffer.concat(this.stderr).toString('utf8'),
      exitCode: this.child.exitCode, signal: this.child.signalCode, durationMs: Math.round(performance.now() - this.started),
      truncated: this.observed > this.kept, observedOutputBytes: this.observed,
      cleanup: { status: this.incomplete ? 'incomplete' : this.reason ? 'tree_termination_requested' : 'parent_exited',
        strategy: process.platform === 'win32' ? 'taskkill /T /F' : 'POSIX process group',
        limitation: 'Trusted host execution, not OS isolation. Escaped descendants or children whose parent already exited may survive; process-tree cleanup is not guaranteed.' },
    };
  }
}

async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}
async function killWindowsTree(pid: number): Promise<boolean> {
  const root = process.env.SystemRoot;
  if (!root) return false;
  const child = spawn(join(root, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'],
    { shell: false, windowsHide: true, env: { SystemRoot: root }, stdio: 'ignore' });
  let succeeded = false;
  const done = new Promise<void>(resolve => {
    child.once('error', () => resolve());
    child.once('close', code => { succeeded = code === 0; resolve(); });
  });
  if (!(await settledWithin(done, 5000))) { child.kill('SIGKILL'); child.unref(); }
  return succeeded;
}
async function killProcessGroup(pid: number): Promise<void> {
  const kill = (signal: NodeJS.Signals) => {
    try { process.kill(-pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 150));
  kill('SIGKILL');
}
