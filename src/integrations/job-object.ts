import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

/**
 * Windows can put a program and everything it starts into a "job", and the operating system itself
 * then enforces a memory ceiling, a processor-time ceiling and, when Branch Agent lets the job go,
 * kills whatever is left. That is a real cap rather than the once-a-second look the process sampler
 * takes. Job objects are not available everywhere, so every caller must cope with `null` and fall
 * back to the sampler; nothing here is allowed to stop a command from running.
 */
export interface JobLimits { maxMemoryMb: number; maxCpuSeconds: number }
export interface Job {
  readonly kind: 'job-object';
  /** Puts a running program into the job. False means the job could not take it. */
  assign(pid: number): Promise<boolean>;
  /** Letting the job go kills anything still inside it. */
  close(): Promise<void>;
}
export interface JobObjects { create(limits: JobLimits): Promise<Job | null> }
/** Used where jobs are not available: the caller keeps the sampled limits it already had. */
export const noJobObjects: JobObjects = { create: async () => null };

const KILL_ON_CLOSE = 0x2000, PROCESS_TIME = 0x2, PROCESS_MEMORY = 0x100;
const limitFlags = KILL_ON_CLOSE | PROCESS_TIME | PROCESS_MEMORY;
const declaration = `using System;using System.Runtime.InteropServices;
public static class BranchJob{
[DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]public static extern IntPtr CreateJobObjectW(IntPtr a,string n);
[DllImport("kernel32.dll",SetLastError=true)]public static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr i,uint l);
[DllImport("kernel32.dll",SetLastError=true)]public static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
[DllImport("kernel32.dll",SetLastError=true)]public static extern IntPtr OpenProcess(uint a,bool inherit,uint pid);
[DllImport("kernel32.dll",SetLastError=true)]public static extern bool CloseHandle(IntPtr h);}`;

/** The supervisor script: it owns the job handle and lives exactly as long as the command does. */
function supervisorScript(limits: JobLimits): string {
  const cpu = Math.max(1, Math.round(limits.maxCpuSeconds)) * 10_000_000;
  const memory = Math.max(16, Math.round(limits.maxMemoryMb)) * 1048576;
  return [
    "$ErrorActionPreference='Stop'",
    "if([IntPtr]::Size -ne 8){Write-Output 'unavailable';exit 1}",
    `Add-Type -TypeDefinition @'\n${declaration}\n'@`,
    "$job=[BranchJob]::CreateJobObjectW([IntPtr]::Zero,$null)",
    "if($job -eq [IntPtr]::Zero){Write-Output 'unavailable';exit 1}",
    "$m=[Runtime.InteropServices.Marshal];$size=144;$buf=$m::AllocHGlobal($size)",
    "for($i=0;$i -lt $size;$i+=8){$m::WriteInt64($buf,$i,[int64]0)}",
    `$m::WriteInt64($buf,0,[int64]${cpu})`,
    `$m::WriteInt32($buf,16,[int32]${limitFlags})`,
    `$m::WriteInt64($buf,112,[int64]${memory})`,
    "if(-not [BranchJob]::SetInformationJobObject($job,9,$buf,[uint32]$size)){Write-Output 'unavailable';exit 1}",
    "Write-Output 'ready'",
    "$line=[Console]::In.ReadLine()",
    "$target=0",
    "if(-not [int]::TryParse($line,[ref]$target)){Write-Output 'refused';exit 1}",
    "$handle=[BranchJob]::OpenProcess(0x0101,$false,[uint32]$target)",
    "if($handle -eq [IntPtr]::Zero){Write-Output 'refused'}",
    "elseif([BranchJob]::AssignProcessToJobObject($job,$handle)){Write-Output 'assigned'}else{Write-Output 'refused'}",
    "if($handle -ne [IntPtr]::Zero){[void][BranchJob]::CloseHandle($handle)}",
    "[void][Console]::In.ReadToEnd()",
    "[void][BranchJob]::CloseHandle($job)",
  ].join('\n');
}

/** Job objects through a small PowerShell supervisor; no extra software is installed. */
export class WindowsJobObjects implements JobObjects {
  constructor(private readonly startupMs = 20000) {}
  async create(limits: JobLimits): Promise<Job | null> {
    const root = process.env.SystemRoot;
    if (process.platform !== 'win32' || !root) return null;
    const encoded = Buffer.from(supervisorScript(limits), 'utf16le').toString('base64');
    const child = spawn(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { SystemRoot: root, PATH: '' } });
    const ready = await nextWord(child, this.startupMs);
    if (ready !== 'ready') { child.kill(); return null; }
    return new SupervisedJob(child, this.startupMs);
  }
}

class SupervisedJob implements Job {
  readonly kind = 'job-object' as const;
  private finished = false;
  constructor(private readonly child: ChildProcess, private readonly waitMs: number) {
    child.once('exit', () => { this.finished = true; });
  }
  async assign(pid: number): Promise<boolean> {
    if (this.finished || !this.child.stdin?.writable) return false;
    this.child.stdin.write(`${pid}\n`);
    return (await nextWord(this.child, this.waitMs)) === 'assigned';
  }
  async close(): Promise<void> {
    if (this.finished) return;
    this.child.stdin?.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 3000);
      timer.unref();
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

/** Reads the next line the supervisor prints, or gives up. */
function nextWord(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let buffer = '';
    const done = (value: string) => { clearTimeout(timer); child.stdout?.off('data', onData); resolve(value); };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const line = /^(.*?)\r?\n/.exec(buffer);
      if (line) done(line[1]!.trim());
    };
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    timer.unref();
    child.stdout?.on('data', onData);
    child.once('exit', () => done(buffer.trim() || 'unavailable'));
  });
}

/** What this computer can offer: real jobs on 64-bit Windows, the sampler everywhere else. */
export const defaultJobObjects = (): JobObjects =>
  process.platform === 'win32' ? new WindowsJobObjects() : noJobObjects;
