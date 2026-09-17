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
