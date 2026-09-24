import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readRunning, sessionTokenFileName, type RunningInstance } from "./running.js";
import { stopBackgroundEngine, type StopReport } from "./background-engine.js";

/**
 * `branch quit`: asks the Branch that is running on this computer, window or background engine, to
 * close the way it does when the owner quits it (open work is saved, and the app gives it a few
 * seconds at most), and returns once that process has really gone. A script restarts Branch with
 * `branch quit` followed by starting it again.
 */
export const quitPath = "/api/deployment/quit";

const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

async function savedToken(dataDir: string): Promise<string | null> {
  const token = (await readFile(join(dataDir, sessionTokenFileName), "utf8").catch(() => "")).trim();
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

/** True only for the master key of this data folder, never a short-lived key. */
async function carriesMasterKey(request: IncomingMessage, dataDir: string): Promise<boolean> {
  const supplied = /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ""))?.[1] ?? "";
  const saved = await savedToken(dataDir);
  return Boolean(saved) && supplied.length === saved!.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(saved!));
}

/** Only a program on this computer, not through the phone door, holding this data folder's own key. */
export async function localWithMasterKey(request: IncomingMessage, input: { dataDir: string; viaRemote?: boolean }): Promise<boolean> {
  const local = loopback.has(request.socket?.localAddress ?? "") && loopback.has(request.socket?.remoteAddress ?? "");
  return !input.viaRemote && local && (await carriesMasterKey(request, input.dataDir));
}

/**
 * Before an update: asks the running Branch to take no new work and give what it is doing up to
 * `budgetMs` to finish (src/runtime.ts `drain`). Answers how that went, or null when no Branch is
 * running. A Branch that is running but cannot be asked, or does not answer, throws, and the update
 * stops before anything is closed. What the update then cuts off is offered back by the version
 * that comes up next.
 */
export const drainPath = "/api/never-break/drain";
export interface DrainReport { finished: number; stillRunning: number }
export async function drainRunning(dataDir: string, budgetMs = 30000, deps: QuitDeps = {}): Promise<DrainReport | null> {
  const note = await runningNow(dataDir, deps.alive ?? stillAlive);
  if (!note) return null; // nothing is running, so there is nothing to finish
  // A Branch is running: the update goes on only once it has been asked and has answered, so no task
  // it has is cut off without being marked to be offered back.
  const refused = (why: string) => new Error(`Branch is running but could not be asked to finish its work first (${why}), so nothing was changed. Close Branch, or try again.`);
  const token = await savedToken(dataDir);
  if (new URL(note.url).hostname !== "127.0.0.1" || !token) throw refused("it is not reachable on this computer");
  const response = await (deps.fetch ?? globalThis.fetch)(`${note.url}${drainPath}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ budgetMs }), signal: AbortSignal.timeout(budgetMs + 10000),
  }).catch((error: unknown) => { throw refused(error instanceof Error ? error.message : String(error)); });
  if (!response.ok) throw refused(`it answered ${response.status}`);
  return (await response.json()) as DrainReport;
}
/** Takes a drain back when the update stopped before Branch was closed. Never throws. */
export async function undrainRunning(dataDir: string, deps: QuitDeps = {}): Promise<void> {
  const note = await runningNow(dataDir, deps.alive ?? stillAlive).catch(() => null);
  const token = await savedToken(dataDir);
  if (!note || !token || new URL(note.url).hostname !== "127.0.0.1") return;
  await (deps.fetch ?? globalThis.fetch)(`${note.url}${drainPath}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ undo: true }), signal: AbortSignal.timeout(10000),
  }).catch(() => undefined);
}

/**
 * The engine's side. Only this computer, holding the master key, may ask; the answer is sent before
 * the process starts closing. `quit` is what quitting means for this launch (the window's own Quit,
 * or the same stop as Ctrl+C for `branch start`); a launch that did not supply one refuses.
 */
export async function quitRequest(
  request: IncomingMessage, input: { dataDir: string; quit?: (() => void) | undefined; viaRemote?: boolean },
): Promise<{ closing: true; pid: number; message: string }> {
  if (request.method !== "POST") throw new Error("Ask with POST.");
  // Both ends of the connection are this computer, it did not come through the phone door, and it
  // carries the data folder's own key (a web page can neither read that key nor send it cross-site).
  if (!(await localWithMasterKey(request, input)))
    throw new Error("Only a program on this computer holding Branch's own key can close it.");
  const quit = input.quit;
  if (!quit) throw new Error("This copy of Branch cannot be closed from outside.");
  setTimeout(quit, 200);
  return { closing: true, pid: process.pid, message: "Branch Agent is closing." };
}

export interface QuitDeps {
  fetch?: typeof fetch;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the process to go once it has been asked (20 seconds). */
  waitMs?: number;
  /** The background engine's own stop, used when the polite request is not answered. */
  stopEngine?: (dataDir: string) => Promise<StopReport>;
}
export interface QuitReport {
  /** True when nothing of Branch is running any more. */
  stopped: boolean;
  wasRunning: boolean;
  /** The process that was closed, so an update can wait for it too. */
  pid: number | null;
  message: string;
}

const stillAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === "EPERM"; }
};
const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** The running note, but only while the process it names still exists. */
export async function runningNow(dataDir: string, alive: (pid: number) => boolean = stillAlive): Promise<RunningInstance | null> {
  const note = await readRunning(dataDir);
  return note && alive(note.pid) ? note : null;
}

async function gone(pid: number, deps: QuitDeps): Promise<boolean> {
  const alive = deps.alive ?? stillAlive, sleep = deps.sleep ?? pause;
  const deadline = Date.now() + (deps.waitMs ?? 20000);
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
  return true;
}

async function ask(dataDir: string, note: RunningInstance, deps: QuitDeps): Promise<boolean> {
  try {
    if (new URL(note.url).hostname !== "127.0.0.1") return false;
    const token = await savedToken(dataDir);
    if (!token) return false;
    const response = await (deps.fetch ?? globalThis.fetch)(`${note.url}${quitPath}`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch { return false; }
}

/** Closes the running Branch and waits for it; "not running" counts as done. */
export async function quitRunning(dataDir: string, deps: QuitDeps = {}): Promise<QuitReport> {
  const note = await runningNow(dataDir, deps.alive ?? stillAlive);
  if (!note) return { stopped: true, wasRunning: false, pid: null, message: "Branch Agent is not running." };
  const pid = note.pid;
  if ((await ask(dataDir, note, deps)) && (await gone(pid, deps)))
    return { stopped: true, wasRunning: true, pid, message: "Branch Agent has closed." };
  if (note.mode === "daemon") {
    const report = await (deps.stopEngine ?? stopBackgroundEngine)(dataDir);
    if (report.stopped) return { stopped: true, wasRunning: true, pid, message: "Branch Agent has closed." };
  }
  return { stopped: false, wasRunning: true, pid,
    message: "Branch Agent did not close. Quit it from its window or menu, then try again." };
}
