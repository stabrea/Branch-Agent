import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Resource use of a running child (memory and CPU time) sampled through the operating system, so a
 * runaway command can be stopped even when it ignores signals. This is a poll, not a kernel cap:
 * a process may exceed a limit briefly before the next sample sees it.
 */
export interface UsageSample { memoryMb: number; cpuSeconds: number }
type Reader = (pid: number) => Promise<UsageSample | null>;

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
async function readPosix(pid: number): Promise<UsageSample | null> {
  const out = await runCapture('ps', ['-o', 'rss=,time=', '-p', String(pid)]);
  const match = out?.trim().match(/^(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)/);
  if (!match) return null;
  const [, rss, days, hours, minutes, seconds] = match;
  return { memoryMb: Number(rss) / 1024, cpuSeconds: Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) };
}
export const readUsage: Reader = process.platform === 'win32' ? readWindows : readPosix;

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
