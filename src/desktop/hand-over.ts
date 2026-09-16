import { execFile, spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Starts the update hand-over script so that it outlives the app. A child started with spawn dies
 * with the app when the app runs inside a Windows job (launchers, test harnesses and some shells
 * put it in one), so the Task Scheduler runs it instead: a scheduled task is created, run at once
 * and deleted again; deleting the task does not stop the command it started. Spawn is the fallback.
 */
export type Exec = (file: string, args: string[], options: { windowsHide: boolean; timeout: number }, callback: (error: Error | null) => void) => unknown;
export type Spawn = (command: string, args: string[], options: Record<string, unknown>) => { unref(): void };

export async function launchHandOver(script: string, pid: number, deps: { exec?: Exec; spawn?: Spawn; systemRoot?: string } = {}): Promise<"task" | "spawn"> {
  const exec = deps.exec ?? (execFile as unknown as Exec), start = deps.spawn ?? (spawn as unknown as Spawn);
  const root = deps.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  const schtasks = join(root, "System32", "schtasks.exe");
  const name = `BranchAgentUpdate-${pid}`;
  const run = (args: string[]) => new Promise<void>((resolve, reject) =>
    exec(schtasks, args, { windowsHide: true, timeout: 15000 }, (error) => (error ? reject(error) : resolve())));
  try {
    await run(["/Create", "/F", "/TN", name, "/SC", "ONCE", "/ST", "00:00", "/TR", `cmd.exe /d /c "\"${script}\" ${pid}"`]);
    await run(["/Run", "/TN", name]);
    await run(["/Delete", "/F", "/TN", name]).catch(() => undefined);
    return "task";
  } catch {
    start("cmd.exe", ["/d", "/c", script, String(pid)], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return "spawn";
  }
}
