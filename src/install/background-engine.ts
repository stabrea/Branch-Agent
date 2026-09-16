import { clearRunning, readRunning } from "./running.js";
import { runTool, systemTool, type RunTool } from "./windows.js";

/**
 * Talking to the engine that is already working with the window closed. When the window joined a
 * background engine, that engine owns the saved work and holds the program files open, so before an
 * update the window asks it for the safety copy and then asks it to close.
 */
export interface BackupDeps { fetch?: typeof fetch; timeoutMs?: number }

/**
 * Asks the background engine to write the safety copy of the person's work. Whatever went wrong
 * there is passed on word for word, so the owner reads the same sentence either way.
 */
export async function requestUpdateBackup(url: string, token: string, deps: BackupDeps = {}): Promise<void> {
  const call = deps.fetch ?? globalThis.fetch;
  const response = await call(`${url}/api/deployment/backup`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(deps.timeoutMs ?? 180000),
  });
  const body = (await response.json().catch(() => null)) as { error?: unknown; path?: unknown } | null;
  if (!response.ok)
    throw new Error(typeof body?.error === "string" && body.error
      ? body.error
      : `the background engine did not answer properly (HTTP ${response.status})`);
  if (typeof body?.path !== "string")
    throw new Error("the background engine did not say where it put the copy");
}

export interface StopDeps {
  run?: RunTool;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  systemRoot?: string;
  /** How long to wait for the engine to go, each time it is asked. */
  waitMs?: number;
}
export interface StopReport {
  /** The engine's process id, so the hand-over script can wait for it too. */
  pid: number | null;
  stopped: boolean;
  forced: boolean;
  message: string;
}

const stillAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === "EPERM"; }
};
const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

async function waitForExit(pid: number, deps: StopDeps): Promise<boolean> {
  const alive = deps.alive ?? stillAlive, sleep = deps.sleep ?? pause;
  const deadline = Date.now() + (deps.waitMs ?? 12000);
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
  return true;
}

/**
 * Closes the background engine and waits for it to go, politely first and firmly after. A refusal is
 * not treated as a failure: the hand-over script waits for the same process and ends it if it has to.
 */
export async function stopBackgroundEngine(dataDir: string, deps: StopDeps = {}): Promise<StopReport> {
  const instance = await readRunning(dataDir);
  if (!instance || instance.mode !== "daemon" || instance.pid === process.pid)
    return { pid: null, stopped: false, forced: false, message: "Nothing was working in the background." };
  const run = deps.run ?? runTool, taskkill = systemTool("taskkill.exe", deps.systemRoot);
  const pid = instance.pid;
  const asked = await run(taskkill, ["/PID", String(pid), "/T"]).then(() => true, () => false);
  if (asked && (await waitForExit(pid, deps))) return finish(dataDir, pid, false);
  await run(taskkill, ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
  if (await waitForExit(pid, deps)) return finish(dataDir, pid, true);
  return {
    pid, stopped: false, forced: true,
    message: "The background engine did not close in time; the update will close it before swapping the files.",
  };
}

async function finish(dataDir: string, pid: number, forced: boolean): Promise<StopReport> {
  await clearRunning(dataDir).catch(() => undefined);
  return {
    pid, stopped: true, forced,
    message: "Branch stopped working in the background so the new version can replace the files.",
  };
}
