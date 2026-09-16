import { execFile, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Starts the update hand-over script so that it outlives the app and stays invisible. A child started
 * with spawn dies with the app when the app runs inside a Windows job (launchers, test harnesses and
 * some shells put it in one), so the Task Scheduler runs it instead: a scheduled task is created, run at
 * once and deleted again; deleting the task does not stop the command it started. The task runs a tiny
 * Windows Script Host launcher so that no console window flashes while files are swapped. Spawn is the
 * fallback when the scheduler is unavailable.
 */
export type Exec = (file: string, args: string[], options: { windowsHide: boolean; timeout: number }, callback: (error: Error | null) => void) => unknown;
export type Spawn = (command: string, args: string[], options: Record<string, unknown>) => { unref(): void };
export type Write = (file: string, content: string) => void;

/** The launcher text: runs the script through cmd with window style 0 (hidden) and does not wait. */
export function hiddenLauncher(script: string, pid: number): string {
  const command = `cmd.exe /d /c ""${script}" ${pid}"`;
  return `CreateObject("WScript.Shell").Run "${command.replace(/"/g, '""')}", 0, False\r\n`;
}

export async function launchHandOver(script: string, pid: number, deps: { exec?: Exec; spawn?: Spawn; write?: Write; systemRoot?: string } = {}): Promise<"task" | "spawn"> {
  const exec = deps.exec ?? (execFile as unknown as Exec), start = deps.spawn ?? (spawn as unknown as Spawn);
  const write = deps.write ?? ((file: string, content: string) => writeFileSync(file, content, "utf8"));
  const root = deps.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  const schtasks = join(root, "System32", "schtasks.exe"), wscript = join(root, "System32", "wscript.exe");
  const name = `BranchAgentUpdate-${pid}`, launcher = `${script}.launch.vbs`;
  const run = (args: string[]) => new Promise<void>((resolve, reject) =>
    exec(schtasks, args, { windowsHide: true, timeout: 15000 }, (error) => (error ? reject(error) : resolve())));
  try {
    write(launcher, hiddenLauncher(script, pid));
    await run(["/Create", "/F", "/TN", name, "/SC", "ONCE", "/ST", "00:00", "/TR", `"${wscript}" //B //Nologo "${launcher}"`]);
    await run(["/Run", "/TN", name]);
    await run(["/Delete", "/F", "/TN", name]).catch(() => undefined);
    return "task";
  } catch {
    start("cmd.exe", ["/d", "/c", script, String(pid)], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return "spawn";
  }
}
