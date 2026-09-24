import type { Store } from "../store.js";
import { readComfort } from "./settings.js";

/**
 * R17-S17: whether the window should look for an update now, and whether it may install one.
 *
 * Installing always goes through the app's own Update button path (src/desktop/updater.ts): the
 * download is checked against its published checksum, the new version is tried on a copy of the
 * owner's work first (never-break's canary), and a safety copy is written before anything is
 * swapped. Nothing here downloads or installs; it only says what is due.
 */
export type UpdateStep = "nothing" | "check" | "install";
export interface UpdatePlan { mode: "off" | "check" | "install"; step: UpdateStep; reason: string; lastCheckedAt: string | null }

const lastKey = "comfort-update-last";
export const checkEveryMs = 24 * 60 * 60 * 1000;
export const betaCheckEveryMs = 5 * 60 * 1000;

export function lastUpdateCheck(store: Pick<Store, "get">, owner: string): string | null {
  const at = store.get("settings", owner, lastKey)?.data?.at;
  return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null;
}
export function noteUpdateCheck(store: Store, owner: string, now = new Date()): void {
  store.save("settings", owner, lastKey, { at: now.toISOString() });
}

/**
 * Integration review: every task still at work in this house, whoever started it, including one
 * paused on a question (swapping the program would lose it). Counted in full, not from a recent list.
 */
export function busyTaskCount(store: Pick<Store, "sqlite">): number {
  const row = store.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('running','needs_input')").get();
  return Number(row?.n ?? 0);
}

export interface PlanFacts {
  /** Tasks still working or waiting for an answer; an install never starts while one is. */
  busyTasks: number;
  /** What the updater last said: "available" means a newer version is known. */
  updaterPhase?: string | undefined;
  now?: Date;
}

/** What is due, in plain words. */
export function updatePlan(store: Pick<Store, "get">, owner: string, facts: PlanFacts): UpdatePlan {
  const settings = readComfort(store, owner, "notify");
  const mode = settings.autoUpdate;
  const lastCheckedAt = lastUpdateCheck(store, owner);
  const plan = (step: UpdateStep, reason: string): UpdatePlan => ({ mode, step, reason, lastCheckedAt });
  if (mode === "off") return plan("nothing", "Updates are only looked for when you press Check.");
  const now = (facts.now ?? new Date()).getTime();
  const interval = settings.releaseChannel === "stable" ? checkEveryMs : betaCheckEveryMs;
  const due = lastCheckedAt === null || now - Date.parse(lastCheckedAt) >= interval;
  /* Dev builds Branch on this computer from every merged change (dogfood F1, the owner's decision): with "update by
     itself" on it is built and installed like any other update, once no task is working, so each fix is seen live. */
  const install = mode === "install";
  if (install && facts.updaterPhase === "available") {
    if (facts.busyTasks > 0) return plan("nothing", "A newer version is ready; it installs once no task is working.");
    return plan("install", "A newer version is ready and nothing is working, so it is installed now, safely.");
  }
  // An available update is remembered by GitHub, not by this process. After a restart the updater
  // starts idle, so look again even if yesterday's check timestamp is still fresh.
  if (install && facts.updaterPhase === "idle")
    return plan("check", "Checking for an update that may have waited through the last restart.");
  if (!due) return plan("nothing", settings.releaseChannel !== "stable"
    ? `${settings.releaseChannel === "dev" ? "Dev" : "Beta"} updates were looked for less than five minutes ago.`
    : "Updates were looked for less than a day ago.");
  return plan("check", install ? "Looking for a newer version to install." : "Looking for a newer version to tell you about.");
}
