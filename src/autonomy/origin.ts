import { runOrigin } from "../key-context.js";
import { currentPerson } from "../people/context.js";
import type { Store } from "../store.js";

/**
 * R17-B (integration review): whether a finished task was the owner's own, typed in the window, the
 * phone or the terminal. Only such a task may start an after-task order or procedure, or put a
 * "from now on" instruction or an assistant's proposal to the owner.
 *
 * A chat message's task, a short-lived key's, a household person's, a lent conversation's and anything
 * started by a schedule, trigger or another program are not: their words are somebody else's. A chat
 * task records no source of its own, so the "channel.inbound" mark it writes when it starts is read too.
 */
export function ownersOwnTask(store: Pick<Store, "events" | "profiles">, runId: string): boolean {
  if (!runId || currentPerson() || !store.profiles.isOwner()) return false;
  const origin = runOrigin(store, runId);
  if (origin.source !== "owner" || origin.shortLivedKey || origin.personProfileId || origin.lentTo || origin.parentRunId) return false;
  return !cameFromChat(store, runId);
}

function cameFromChat(store: Pick<Store, "events">, runId: string): boolean {
  const seen = new Set<string>();
  for (let id: unknown = runId; typeof id === "string" && !seen.has(id) && seen.size < 20;) {
    seen.add(id);
    const events = store.events(id);
    if (events.some((event) => event.kind === "channel.inbound")) return true;
    id = events.find((event) => event.kind === "run.started")?.data.resumedFrom;
  }
  return false;
}
