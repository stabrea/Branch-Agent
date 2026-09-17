import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { clearRunning, readRunning, sessionTokenFileName } from "./running.js";
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
  /** Which system this is; defaults to this computer's. Only Windows uses `taskkill`. */
  platform?: NodeJS.Platform;
  /** macOS and Linux: sends a signal to a process. Tests hand in a fake. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** macOS and Linux: the call that asks the engine to close over its own local address. */
  fetch?: typeof fetch;
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
  if ((deps.platform ?? process.platform) !== "win32") return stopPosixEngine(dataDir, instance, deps);
  const run = deps.run ?? runTool, taskkill = systemTool("taskkill.exe", deps.systemRoot);
  const pid = instance.pid;
  const asked = await run(taskkill, ["/PID", String(pid), "/T"]).then(() => true, () => false);
  if (asked && (await waitForExit(pid, deps))) return finish(dataDir, pid, false);
  await run(taskkill, ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
  if (await waitForExit(pid, deps)) return finish(dataDir, pid, true);
  return notInTime(pid);
}

const notInTime = (pid: number): StopReport => ({
  pid, stopped: false, forced: true,
  message: "The background engine did not close in time; the update will close it before swapping the files.",
});

/** macOS and Linux wait a few seconds at each step rather than Windows' twelve. */
const posixWaitMs = 3000;

/**
 * macOS and Linux: the engine is asked over its own local address first, then sent the ordinary
 * "please stop" signal, and only then ended outright. Each step waits a few seconds at most. No
 * signal is ever sent to a process id that cannot be shown to still be this engine: a note left
 * behind by a crash may name an id the system has since given to an unrelated program.
 */
async function stopPosixEngine(
  dataDir: string, instance: { pid: number; url: string }, deps: StopDeps,
): Promise<StopReport> {
  const pid = instance.pid, bounded = { ...deps, waitMs: deps.waitMs ?? posixWaitMs };
  const kill = deps.kill ?? ((target: number, signal: NodeJS.Signals) => { process.kill(target, signal); });
  const send = (signal: NodeJS.Signals): boolean => {
    try { kill(pid, signal); return true; } catch { return false; }
  };
  const closing = await engineCall(dataDir, instance.url, "POST", "/api/deployment/close", deps);
  if (closing?.ok && (await waitForExit(pid, bounded))) return finish(dataDir, pid, false);
  if (!closing?.ok && !(await stillTheEngine(dataDir, instance, deps))) {
    await clearRunning(dataDir).catch(() => undefined);
    return { pid: null, stopped: false, forced: false, message: "Nothing was working in the background." };
  }
  if (send("SIGTERM") && (await waitForExit(pid, bounded))) return finish(dataDir, pid, false);
  send("SIGKILL");
  if (await waitForExit(pid, bounded)) return finish(dataDir, pid, true);
  return notInTime(pid);
}

/**
 * True when the noted process is still Branch's engine: its address answers as Branch with the saved
 * key, or the system says that process id is running Branch's engine script.
 */
async function stillTheEngine(dataDir: string, instance: { pid: number; url: string }, deps: StopDeps): Promise<boolean> {
  const state = await engineCall(dataDir, instance.url, "GET", "/api/state", deps);
  const body = state?.ok ? ((await state.json().catch(() => null)) as { version?: unknown } | null) : null;
  if (typeof body?.version === "string") return true;
  const run = deps.run ?? runTool;
  const command = await run("/bin/ps", ["-p", String(instance.pid), "-o", "command="]).catch(() => "");
  return /[\\/]dist[\\/]cli\.js\b/.test(command);
}

/** One call to the engine's own loopback address with the saved key; null when it could not be made. */
async function engineCall(
  dataDir: string, url: string, method: "GET" | "POST", path: string, deps: StopDeps,
): Promise<Response | null> {
  try {
    if (new URL(url).hostname !== "127.0.0.1") return null;
    const token = (await readFile(join(dataDir, sessionTokenFileName), "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const call = deps.fetch ?? globalThis.fetch;
    return await call(`${url}${path}`, {
      method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(posixWaitMs),
    });
  } catch { return null; }
}

async function finish(dataDir: string, pid: number, forced: boolean): Promise<StopReport> {
  await clearRunning(dataDir).catch(() => undefined);
  return {
    pid, stopped: true, forced,
    message: "Branch stopped working in the background so the new version can replace the files.",
  };
}
