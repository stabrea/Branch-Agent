import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Whether the work in progress was asked for with a short-lived key (`branch token create`) rather
 * than this computer's own key. The server marks a request the moment such a key is accepted, and
 * the mark follows everything that request starts, including the task and its "finished" event.
 * A feature that must stay the owner's alone — sending work to GitHub, for one — reads it here.
 */
const scope = new AsyncLocalStorage<{ shortLivedKey: true }>();

/** Marks the rest of the current request as started with a short-lived key. */
export function markShortLivedKey(): void {
  scope.enterWith({ shortLivedKey: true });
}
/** Runs `work` as if it had been asked for with a short-lived key (for tests and for callers that know). */
export function underShortLivedKey<T>(work: () => T): T {
  return scope.run({ shortLivedKey: true }, work);
}
export function startedWithShortLivedKey(): boolean {
  return scope.getStore()?.shortLivedKey === true;
}

/**
 * Integration review (bucket 18): what a task wrote down about where it came from, when it started.
 * A mark on the request alone is lost by anything that starts later — a follow-up message, a queued
 * task, a background specialist, a continued task — so each task records it on its own
 * `run.started`, and this reads it back, following the parent and the task it continued.
 */
export interface RunOrigin {
  /** Started with a short-lived key, or started by something that was. */
  shortLivedKey: boolean;
  /** Who started the task at the top of the chain: "owner", "schedule", "trigger", "mcp", ... */
  source: string;
  /** What the task itself was allowed to use; null when it recorded nothing. */
  permissions: string[] | null;
  /** The task that started this one, when it is a specialist's. */
  parentRunId: string | null;
}
type EventReader = { events(runId: string): { kind: string; data: Record<string, unknown> }[] };
const startOf = (store: EventReader, runId: string) => store.events(runId).find((event) => event.kind === "run.started")?.data;

export function runOrigin(store: EventReader, runId: string): RunOrigin {
  const own = startOf(store, runId);
  const origin: RunOrigin = {
    shortLivedKey: false, source: typeof own?.source === "string" ? own.source : "owner",
    permissions: Array.isArray(own?.permissions) ? own.permissions.map(String) : null,
    parentRunId: typeof own?.parentRunId === "string" ? own.parentRunId : null,
  };
  const seen = new Set<string>();
  const queue = [runId];
  while (queue.length && seen.size < 20) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const data = startOf(store, id);
    if (!data) continue;
    if (data.shortLivedKey === true) origin.shortLivedKey = true;
    if (typeof data.source === "string" && data.source !== "owner") origin.source = data.source;
    for (const next of [data.parentRunId, data.resumedFrom]) if (typeof next === "string") queue.push(next);
  }
  return origin;
}
