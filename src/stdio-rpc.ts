import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { killProcessGroup, killWindowsTree } from "./integrations/shell-process.js";
import { defaultJobObjects, jobWithin, type Job, type JobLimits, type JobObjects } from "./integrations/job-object.js";

/**
 * Talking to a helper program over its own input and output. Language servers and debug adapters
 * both speak the same shape: a `Content-Length` line, a blank line, then one JSON message. This
 * module does the framing, the starting and the stopping; what the messages mean is left to the
 * two clients built on top of it.
 *
 * The program is always one the owner already has and has named in Settings, started from its full
 * address and never through a shell, inside the same Windows job the rest of the app uses, so its
 * memory and processor limits are the operating system's to enforce and nothing it starts survives.
 */
export interface StdioProgram {
  executable: string;
  args: string[];
  cwd: string;
  limits?: JobLimits;
  /** Everything it prints on the error stream, newest last, for when it will not start. */
  onStderr?: (text: string) => void;
}
/** The most one message may weigh; a server that sends more than this has lost its place. */
export const maxMessageBytes = 8 * 1024 * 1024;

/** Refuses a program that is not there, is given as a bare name, or is a wrapper script. */
export async function checkedProgram(path: string): Promise<string> {
  if (!path || !isAbsolute(path)) throw new Error("Give the program in full, starting from the drive.");
  if (/\.(cmd|bat)$/i.test(path)) throw new Error("Name the real program, not a .cmd or .bat wrapper.");
  if (!(await stat(path).catch(() => null))?.isFile()) throw new Error("There is no program at that address.");
  return path;
}

/** Pulls whole messages out of a stream of bytes, header by header. */
export class MessageReader {
  private buffer = Buffer.alloc(0);
  constructor(private readonly onMessage: (message: Record<string, unknown>) => void) {}
  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > maxMessageBytes * 2) throw new Error("The helper program sent more than this can hold");
    for (;;) {
      const split = this.buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      const header = this.buffer.toString("ascii", 0, split);
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? NaN);
      if (!Number.isInteger(length) || length < 0 || length > maxMessageBytes)
        throw new Error("The helper program sent a message this cannot read");
      const start = split + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.toString("utf8", start, start + length);
      this.buffer = this.buffer.subarray(start + length);
      try { this.onMessage(JSON.parse(body) as Record<string, unknown>); } catch { /* a damaged message is dropped */ }
    }
  }
}

/** Wraps one message in the header the other side expects. */
export function frameMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

const environment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "", PATHEXT: process.env.PATHEXT ?? "",
  SYSTEMROOT: process.env.SYSTEMROOT ?? "", TEMP: process.env.TEMP ?? "",
  HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "",
  APPDATA: process.env.APPDATA ?? "", LOCALAPPDATA: process.env.LOCALAPPDATA ?? "",
});

/** One running helper program, with messages going both ways. */
export class StdioChannel {
  private readonly reader: MessageReader;
  private readonly child: ChildProcess;
  private job: Job | null = null;
  private stopped = false;
  private failure: string | null = null;
  readonly listeners = new Set<(message: Record<string, unknown>) => void>();

  private constructor(child: ChildProcess, private readonly program: StdioProgram) {
    this.child = child;
    this.reader = new MessageReader((message) => { for (const listener of this.listeners) listener(message); });
    child.stdout?.on("data", (chunk: Buffer) => {
      try { this.reader.push(chunk); } catch (error) { this.failure = (error as Error).message; void this.stop(); }
    });
    child.stderr?.on("data", (chunk: Buffer) => this.program.onStderr?.(chunk.toString("utf8").slice(0, 2000)));
    child.once("error", (error) => { this.failure = error.message; this.settle(); });
    child.once("exit", () => this.settle());
  }

  static async start(program: StdioProgram, jobs: JobObjects = defaultJobObjects()): Promise<StdioChannel> {
    await checkedProgram(program.executable);
    const limits = program.limits ?? { maxMemoryMb: 2048, maxCpuSeconds: 1800 };
    const job = await jobWithin(jobs, limits, 1500);
    const child = spawn(program.executable, program.args, {
      cwd: program.cwd, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], env: environment(),
    });
    if (job && child.pid) await job.assign(child.pid).catch(() => false);
    const channel = new StdioChannel(child, program);
    channel.job = job;
    return channel;
  }

  get pid(): number | null { return this.child.pid ?? null; }
  get running(): boolean { return !this.stopped && this.child.exitCode === null && !this.child.killed; }
  /** Why it stopped, when it stopped on its own. */
  get problem(): string | null { return this.failure; }

  send(message: unknown): void {
    if (!this.running || !this.child.stdin?.writable) throw new Error(this.failure ?? "The helper program is not running");
    this.child.stdin.write(frameMessage(message));
  }

  private settle(): void {
    if (this.stopped) return;
    this.stopped = true;
    void this.job?.close().catch(() => undefined);
  }

  async stop(): Promise<void> {
    const pid = this.child.pid;
    if (this.running && pid) {
      try {
        if (process.platform === "win32") await killWindowsTree(pid);
        else await killProcessGroup(pid);
      } catch { /* letting the job go is the real cleanup */ }
    }
    this.settle();
    this.child.stdin?.end();
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }
}

/** A message with a number for an answer to be matched against. */
interface Waiting { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

/**
 * Requests and answers over one channel, counted by an id the caller never sees. Both protocols
 * number their messages; the two clients say which field holds the number.
 */
export class RequestTable {
  private next = 1;
  private readonly waiting = new Map<number, Waiting>();
  constructor(private readonly timeoutMs: number) {}
  take(): number { return this.next++; }
  /** Registers a wait for one id and gives back the promise its answer will settle. */
  expect(id: number, timeoutMs = this.timeoutMs): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("The helper program did not answer in time"));
      }, timeoutMs);
      timer.unref();
      this.waiting.set(id, { resolve, reject, timer });
    });
  }
  /** Settles the wait for one id; true when there was one. */
  settle(id: number, message: Record<string, unknown>, error?: string): boolean {
    const waiting = this.waiting.get(id);
    if (!waiting) return false;
    clearTimeout(waiting.timer);
    this.waiting.delete(id);
    if (error) waiting.reject(new Error(error)); else waiting.resolve(message);
    return true;
  }
  /** Fails everything still waiting, for when the program stops. */
  abandon(reason: string): void {
    for (const id of [...this.waiting.keys()]) this.settle(id, {}, reason);
  }
}
