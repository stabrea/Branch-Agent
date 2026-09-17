import { runOrigin, startedFromChat } from "../key-context.js";
import { currentPerson } from "../people/context.js";
import type { Store } from "../store.js";

/**
 * R17-H: whose words a task carries. The shared board lets the owner's own work — a conversation, a
 * helper it started, a schedule the owner made — write cards. It never lets a chat sender, a
 * short-lived key, a household person, a lent conversation or another program (MCP, A2A, ACP) do it:
 * their words are somebody else's, and a card becomes a task when the owner presses Work on it.
 *
 * A chat task carries source "channel" along its helpers and resumptions; src/key-context.ts also reads
 * the "channel.inbound" mark older chat tasks carry instead.
 */
export function fromChat(store: Pick<Store, "events">, runId: string): boolean {
  return startedFromChat({ runId }, store);
}

export function boardWriter(store: Pick<Store, "events" | "profiles">, runId: string): boolean {
  if (!runId || currentPerson() || !store.profiles.isOwner()) return false;
  const origin = runOrigin(store, runId);
  if (!["owner", "schedule"].includes(origin.source) || origin.shortLivedKey || origin.personProfileId || origin.lentTo) return false;
  return !fromChat(store, runId);
}
