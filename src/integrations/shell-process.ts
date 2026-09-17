import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { watchUsage } from './process-usage.js';
import { startedThrough, type Job } from './job-object.js';
import { endProcessGroup, heldBySystemOn, posixLimitSupport, type HeldBySystem } from './posix-limits.js';

export type StopReason = 'cancelled' | 'timed_out' | 'output_limit' | 'descendant_pipes' | 'memory_limit' | 'cpu_limit';
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
  /** Highest memory and processor time seen while sampling (about once a second). */
  usage: { peakMemoryMb: number; cpuSeconds: number };
  /** Whether Windows itself held the limits for this command, or Branch Agent sampled them. */
  isolation: 'job-object' | 'sampling';
  /**
   * macOS and Linux: what the system itself held for this command, when it was started in a
   * limited process group. Absent on Windows and where only sampling was used.
   */
  heldBySystem?: HeldBySystem;
}
export interface ProcessOptions {
  executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  signal: AbortSignal; timeoutMs: number; maxOutputBytes: number;
  maxMemoryMb?: number; maxCpuSeconds?: number; usageIntervalMs?: number;
  /**
   * A Windows job, already created and waiting, that this command is put into as it starts. On
   * macOS and Linux, a limited process group the command is started through.
   */
  job?: Job | undefined;
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
  private watcher: ReturnType<typeof watchUsage> | undefined;
  private readonly held: Promise<boolean>;
  private inJob = false;
  constructor(private readonly options: ProcessOptions) {
    const start = startedThrough(options.job, { executable: options.executable, args: options.args });
    this.child = spawn(start.executable, start.args, { cwd: options.cwd, env: options.env,
      shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    // The job is created before the command starts, so it takes it over within a moment of spawning.
    this.held = options.job && this.child.pid ? options.job.assign(this.child.pid).catch(() => false) : Promise.resolve(false);
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
    if (this.child.pid && (this.options.maxMemoryMb || this.options.maxCpuSeconds))
      this.watcher = watchUsage(this.child.pid, { maxMemoryMb: this.options.maxMemoryMb ?? Infinity, maxCpuSeconds: this.options.maxCpuSeconds ?? Infinity },
        reason => { void this.stop(reason); }, { ...(this.options.usageIntervalMs ? { intervalMs: this.options.usageIntervalMs } : {}) });
    if (this.options.signal.aborted) abort();
    try {
      this.inJob = await this.held;
      await this.donePromise;
      await this.stopping;
      return this.result();
    } finally {
      clearTimeout(timeout);
      clearTimeout(this.pipeTimer);
      this.watcher?.stop();
      this.options.signal.removeEventListener('abort', abort);
      // Letting the job go is what kills anything the command left behind.
      await this.options.job?.close().catch(() => undefined);
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
    const rawTruncated = this.observed > this.kept;
    const stdout = boundedUtf8(decodeOutput(this.stdout, rawTruncated), this.options.maxOutputBytes);
    const stderr = boundedUtf8(decodeOutput(this.stderr, rawTruncated), this.options.maxOutputBytes - Buffer.byteLength(stdout.text));
    const windowsJob = this.inJob && this.options.job?.kind !== 'process-group';
    return {
      status: this.reason ?? (this.failed || this.child.exitCode !== 0 ? 'failed' : 'completed'),
      stdout: stdout.text, stderr: stderr.text,
      exitCode: this.child.exitCode, signal: this.child.signalCode, durationMs: Math.round(performance.now() - this.started),
      truncated: rawTruncated || stdout.truncated || stderr.truncated, observedOutputBytes: this.observed,
      usage: (() => { const peak = this.watcher?.peak() ?? { memoryMb: 0, cpuSeconds: 0 }; return { peakMemoryMb: Math.round(peak.memoryMb), cpuSeconds: Math.round(peak.cpuSeconds * 10) / 10 }; })(),
      isolation: windowsJob ? 'job-object' : 'sampling',
      ...(this.inJob && !windowsJob ? { heldBySystem: heldByGroup() } : {}),
      cleanup: this.inJob && !windowsJob ? this.groupCleanup() : { status: this.incomplete ? 'incomplete' : this.reason ? 'tree_termination_requested' : 'parent_exited',
        strategy: this.inJob ? 'Windows job object, killed on close' : process.platform === 'win32' ? 'taskkill /T /F' : 'POSIX process group',
        limitation: this.inJob
          ? 'Windows holds the memory and processor limits and kills the whole job when it is let go. This is a resource cap, not OS isolation: the command still reaches the host filesystem and the network, and anything it started outside the job may survive.'
          : 'Trusted host execution, not OS isolation. Escaped descendants or children whose parent already exited may survive; process-tree cleanup is not guaranteed.' },
    };
  }
  /** macOS and Linux: the group was ended as the command finished, whatever it left behind. */
  private groupCleanup(): ProcessResult['cleanup'] {
    return { status: this.incomplete ? 'incomplete' : this.reason ? 'tree_termination_requested' : 'parent_exited',
      strategy: 'POSIX process group with system limits, ended when the command finishes',
      limitation: posixLimitSupport(hostPosix()).sentence };
  }
}

const hostPosix = (): 'darwin' | 'linux' => process.platform === 'darwin' ? 'darwin' : 'linux';
const heldByGroup = (): HeldBySystem => heldBySystemOn(hostPosix());

function decodeOutput(chunks: Buffer[], truncated: boolean): string {
  const decoder = new StringDecoder('utf8');
  const text = decoder.write(Buffer.concat(chunks));
  // A raw byte cap can cut a valid code point; do not invent a replacement for that suffix.
  return text + (truncated ? '' : decoder.end());
}

function boundedUtf8(text: string, maximum: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maximum) return { text, truncated: false };
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}
export async function killWindowsTree(pid: number): Promise<boolean> {
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
/** Ends a command's whole process group on macOS and Linux: SIGTERM, then a bounded SIGKILL. */
export async function killProcessGroup(pid: number): Promise<void> {
  await endProcessGroup(pid);
}
