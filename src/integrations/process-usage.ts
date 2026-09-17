import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Resource use of a running child (memory and CPU time) sampled through the operating system, so a
 * runaway command can be stopped even when it ignores signals. This is a poll, not a kernel cap:
 * a process may exceed a limit briefly before the next sample sees it.
 */
export interface UsageSample { memoryMb: number; cpuSeconds: number }
type Reader = (pid: number) => Promise<UsageSample | null>;
/** Runs a program and hands back what it printed, or null. Replaced in tests. */
export type CaptureRunner = (executable: string, args: string[]) => Promise<string | null>;

function runCapture(executable: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0 ? output : null); });
  });
}
async function readWindows(pid: number): Promise<UsageSample | null> {
  const root = process.env.SystemRoot;
  if (!root) return null;
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { "$($p.WorkingSetSize) $($p.UserModeTime) $($p.KernelModeTime)" }`;
  const out = await runCapture(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script]);
  const parts = out?.trim().split(/\s+/).map(Number);
  if (!parts || parts.length < 3 || parts.some(Number.isNaN)) return null;
  return { memoryMb: parts[0]! / 1048576, cpuSeconds: (parts[1]! + parts[2]!) / 10_000_000 };
}
/** `ps` time: `[[dd-]hh:]mm:ss[.cc]`, as macOS and Linux both print it. */
export function psSeconds(text: string): number | null {
  const match = text.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const [, days, hours, minutes, seconds, fraction] = match;
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
    + (fraction ? Number(`0.${fraction}`) : 0);
}
/** `rss time` lines: memory is the largest single program's, processor time the total. */
export function psGroupSample(output: string | null): UsageSample | null {
  let memoryKb = 0, cpuSeconds = 0, rows = 0;
  for (const line of (output ?? '').split('\n')) {
    const [rss, time] = line.trim().split(/\s+/);
    const seconds = time === undefined ? null : psSeconds(time);
    if (!rss || !/^\d+$/.test(rss) || seconds === null) continue;
    memoryKb = Math.max(memoryKb, Number(rss)); cpuSeconds += seconds; rows++;
  }
  return rows ? { memoryMb: memoryKb / 1024, cpuSeconds } : null;
}
async function readPosix(pid: number, run: CaptureRunner = runCapture): Promise<UsageSample | null> {
  return psGroupSample(await run('ps', ['-o', 'rss=,time=', '-p', String(pid)]));
}
/** macOS: every program in the group the command leads, falling back to the command alone. */
export async function readDarwinGroup(pgid: number, run: CaptureRunner = runCapture): Promise<UsageSample | null> {
  return psGroupSample(await run('ps', ['-o', 'rss=,time=', '-g', String(pgid)])) ?? readPosix(pgid, run);
}
/** Linux keeps processor time in ticks of 1/100 s in `/proc`, whatever the kernel's own tick is. */
const procTicks = 100;
/** Linux: every program in the group, read straight from `/proc` with no program started. */
export async function readLinuxGroup(pgid: number, procRoot = '/proc'): Promise<UsageSample | null> {
  const entries = await readdir(procRoot).catch(() => [] as string[]);
  let memoryKb = 0, ticks = 0, rows = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await readFile(join(procRoot, entry, 'stat'), 'utf8').catch(() => '');
    // The program's name is in brackets and may itself hold spaces, so fields are counted after it.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(fields[2]) !== pgid) continue;
    const status = await readFile(join(procRoot, entry, 'status'), 'utf8').catch(() => '');
    memoryKb = Math.max(memoryKb, Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0));
    ticks += Number(fields[11] ?? 0) + Number(fields[12] ?? 0);
    rows++;
  }
  return rows ? { memoryMb: memoryKb / 1024, cpuSeconds: ticks / procTicks } : null;
}
/** How usage is read on each platform. On macOS and Linux the pid is the command's group. */
export function usageReaderFor(platform: NodeJS.Platform, options: { run?: CaptureRunner; procRoot?: string } = {}): Reader {
  if (platform === 'win32') return readWindows;
  if (platform === 'darwin') return (pid) => readDarwinGroup(pid, options.run);
  if (platform === 'linux') return (pid) => readLinuxGroup(pid, options.procRoot);
  return (pid) => readPosix(pid, options.run);
}
export const readUsage: Reader = usageReaderFor(process.platform);

/** Samples until stopped; calls `exceeded` with the reason the first time a limit is passed. */
export function watchUsage(pid: number, limits: { maxMemoryMb: number; maxCpuSeconds: number }, exceeded: (reason: 'memory_limit' | 'cpu_limit', sample: UsageSample) => void,
  options: { intervalMs?: number; reader?: Reader } = {}): { stop: () => void; peak: () => UsageSample } {
  const reader = options.reader ?? readUsage;
  const peak: UsageSample = { memoryMb: 0, cpuSeconds: 0 };
  let active = true, busy = false;
  const timer = setInterval(async () => {
    if (!active || busy) return;
    busy = true;
    try {
      const sample = await reader(pid);
      if (!sample || !active) return;
      peak.memoryMb = Math.max(peak.memoryMb, sample.memoryMb); peak.cpuSeconds = Math.max(peak.cpuSeconds, sample.cpuSeconds);
      if (sample.memoryMb > limits.maxMemoryMb) { active = false; exceeded('memory_limit', sample); }
      else if (sample.cpuSeconds > limits.maxCpuSeconds) { active = false; exceeded('cpu_limit', sample); }
    } finally { busy = false; }
  }, options.intervalMs ?? 1000);
  timer.unref();
  return { stop: () => { active = false; clearInterval(timer); }, peak: () => ({ ...peak }) };
}
