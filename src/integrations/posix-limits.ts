import { isAbsolute } from 'node:path';
import type { Job, JobLimits, JobObjects } from './job-object.js';

/**
 * The macOS and Linux counterpart of the Windows job. Neither system can hand an already running
 * program a set of limits the way a Windows job can, so the limits are set on the way in: the
 * program is started through `/bin/sh`, which lowers its own limits and then replaces itself with
 * the program. The program is also started as the leader of its own process group, so ending the
 * group ends everything it started (unless something deliberately left the group).
 *
 * The shell script is fixed text plus whole numbers. The program and its arguments reach the
 * script only as `$0` and `$@`, never inside the script, so nothing a person typed can be run as
 * a shell command.
 */
export type PosixPlatform = 'darwin' | 'linux';
export const isPosixPlatform = (platform: string): platform is PosixPlatform =>
  platform === 'darwin' || platform === 'linux';

/** What the system itself holds on each platform, in words the owner can read. */
export interface PosixLimitSupport {
  processorTime: boolean;
  memory: boolean;
  processCount: boolean;
  wholeGroupEnds: boolean;
  sentence: string;
}
export function posixLimitSupport(platform: PosixPlatform): PosixLimitSupport {
  const system = platform === 'darwin' ? 'macOS' : 'Linux';
  return { processorTime: true, memory: false, processCount: false, wholeGroupEnds: true,
    sentence: `On ${system} the system holds the processor-time ceiling for each program in the group; the total across the group, and memory, are checked about once a second. The system's own memory caps count memory a program has only set aside, which stops programs such as Node from starting at all, so they are not used. The number of programs is not capped either: the only system cap counts every program you run, not just this command's. Ending the command ends every program it started; one that deliberately left the group may survive. This is a resource cap, not OS isolation: the command still reaches your files and the network.` };
}

/** What the system held, for a result or a list entry. */
export interface HeldBySystem { processorTime: boolean; memory: boolean; wholeGroupEnds: boolean }
export function heldBySystemOn(platform: PosixPlatform): HeldBySystem {
  const { processorTime, memory, wholeGroupEnds } = posixLimitSupport(platform);
  return { processorTime, memory, wholeGroupEnds };
}

/** Lowers one limit, soft then hard, and never raises one that is already lower. */
function lowerLine(flag: '-t', value: number): string {
  const lower = (kind: '-S' | '-H') =>
    `c=$(ulimit ${kind} ${flag}); if [ "$c" = unlimited ] || [ "$c" -gt ${value} ]; then ulimit ${kind} ${flag} ${value}; fi`;
  return `${lower('-S')}; ${lower('-H')}`;
}

/** The fixed script for these limits. Only whole numbers are ever put into it. */
export function limitScript(limits: JobLimits, platform: PosixPlatform): string {
  const cpu = Math.max(1, Math.round(limits.maxCpuSeconds));
  if (!Number.isSafeInteger(cpu)) throw new Error('Limits must be whole numbers');
  // Memory is deliberately not set here on either platform; see `posixLimitSupport`.
  void platform;
  return `${lowerLine('-t', cpu)}; exec "$0" "$@"`;
}

export interface Command { executable: string; args: string[] }
/** The command as it is really started: `/bin/sh -c <fixed script> <program> <arguments…>`. */
export function limitWrapper(command: Command, limits: JobLimits, platform: PosixPlatform): Command {
  return { executable: '/bin/sh', args: ['-c', limitScript(limits, platform), command.executable, ...command.args] };
}

type Kill = (pid: number, signal: NodeJS.Signals | 0) => void;
const systemKill: Kill = (pid, signal) => { process.kill(pid, signal); };
/**
 * Sends a signal to the whole group; false when there is no group left to send it to. Once the
 * group has taken a first signal, macOS answers EPERM rather than ESRCH while the only members left
 * are finished programs waiting to be collected, so from then on EPERM also means nothing is left.
 */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0, kill: Kill, accepted = false): boolean {
  try { kill(-pgid, signal); return true; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || (accepted && code === 'EPERM')) return false;
    throw error;
  }
}
/**
 * Ends a whole process group: asks politely, waits a bounded moment for it to go, then forces it.
 * A group that has already gone is not signalled again, so its number is never reused by mistake.
 */
export async function endProcessGroup(pgid: number, options: { graceMs?: number; kill?: Kill } = {}): Promise<void> {
  if (!Number.isInteger(pgid) || pgid <= 1) return;
  const kill = options.kill ?? systemKill;
  if (!signalGroup(pgid, 'SIGTERM', kill)) return;
  const deadline = Date.now() + (options.graceMs ?? 150);
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    if (!signalGroup(pgid, 0, kill, true)) return;
  }
  signalGroup(pgid, 'SIGKILL', kill, true);
}

/** One command's limits and group. It must be started with `wrap` and `detached: true`. */
export class PosixProcessGroup implements Job {
  readonly kind = 'process-group' as const;
  private wrapped = false;
  private leader = 0;
  private closed = false;
  constructor(private readonly limits: JobLimits, private readonly platform: PosixPlatform,
    private readonly kill: Kill = systemKill) {}
  get support(): PosixLimitSupport { return posixLimitSupport(this.platform); }
  /** What the system is holding for the program it was given, or null when it holds nothing. */
  held(): HeldBySystem | null { return this.wrapped && this.leader ? heldBySystemOn(this.platform) : null; }
  /** A program not given by its full address is started as it is, without the limits. */
  wrap(command: Command): Command {
    if (this.closed || !isAbsolute(command.executable)) return command;
    this.wrapped = true;
    return limitWrapper(command, this.limits, this.platform);
  }
  async assign(pid: number): Promise<boolean> {
    if (this.closed || !this.wrapped || !Number.isInteger(pid) || pid <= 1) return false;
    this.leader = pid;
    return true;
  }
  /** Letting it go ends whatever is left in the group, as closing a Windows job does. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.leader) await endProcessGroup(this.leader, { kill: this.kill });
  }
}

/** Process groups with limits, for macOS and Linux. */
export class PosixProcessGroups implements JobObjects {
  constructor(private readonly platform: PosixPlatform, private readonly kill: Kill = systemKill) {}
  async create(limits: JobLimits): Promise<Job | null> {
    return new PosixProcessGroup(limits, this.platform, this.kill);
  }
}
