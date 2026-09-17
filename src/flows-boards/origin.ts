import { runOrigin } from "../key-context.js";
import { currentPerson } from "../people/context.js";
import type { Store } from "../store.js";

/**
 * R17-H: whose words a task carries. The shared board lets the owner's own work — a conversation, a
 * helper it started, a schedule the owner made — write cards. It never lets a chat sender, a
 * short-lived key, a household person, a lent conversation or another program (MCP, A2A, ACP) do it:
 * their words are somebody else's, and a card becomes a task when the owner presses Work on it.
 *
 * A chat task records no source of its own, so the "channel.inbound" mark written when it starts is
 * read along the whole chain of helpers and resumptions (as src/autonomy/origin.ts does for one task).
 */
export function fromChat(store: Pick<Store, "events">, runId: string): boolean {
  const seen = new Set<string>();
  const queue = [runId];
  while (queue.length && seen.size < 20) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const events = store.events(id);
    if (events.some((event) => event.kind === "channel.inbound")) return true;
    const started = events.find((event) => event.kind === "run.started")?.data ?? {};
    for (const next of [started.resumedFrom, started.parentRunId]) if (typeof next === "string") queue.push(next);
  }
  return false;
}

export function boardWriter(store: Pick<Store, "events" | "profiles">, runId: string): boolean {
  if (!runId || currentPerson() || !store.profiles.isOwner()) return false;
  const origin = runOrigin(store, runId);
  if (!["owner", "schedule"].includes(origin.source) || origin.shortLivedKey || origin.personProfileId || origin.lentTo) return false;
  return !fromChat(store, runId);
}
