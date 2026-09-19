import { lockedDown } from "./lockdown.js";
import { conversationCarrier } from "./outside-origin.js";
import type { Store } from "./store.js";
import type { ConversationKind } from "./trunks/conversations.js";

/**
 * phase2/rooms (integration review): whether Talk live may open on a conversation, in words, or
 * null. A live conversation's tools run as the owner's assistant and its sound goes to an outside
 * service, so it is refused:
 *   - under Lockdown (the sound would leave this computer),
 *   - while the window is switched to a household person,
 *   - in a room, or a conversation a Trunk answers in (it would step round the Trunk's own limits),
 *   - in a conversation that is held because it began outside Branch (a chat app, a schedule, a
 *     trigger, another program): talking in it must not turn that work into the owner's own.
 * It is asked where a live conversation really opens (`LiveConversations.start`, which every task's
 * socket reaches), not only by the route that hands out the task it hangs off.
 */
export interface LiveRefusalDeps {
  store: Store;
  owner: string;
  kind: (sessionId: string) => ConversationKind;
}

export function liveRefusal(deps: LiveRefusalDeps, sessionId: string): string | null {
  if (lockedDown(deps.store, deps.owner))
    return "Lockdown is on, so Talk live is off: it sends your voice to a service outside this computer. Turn Lockdown off in Settings to allow it again.";
  if (!deps.store.profiles.isOwner()) return "Talk live is for the owner of this computer. Switch back to the owner's profile to use it.";
  const kind = deps.kind(sessionId);
  if (kind === "room") return "Talk live works in a conversation with your assistant, not in a room of Trunks.";
  if (kind !== "plain")
    return "Talk live works in a conversation with your assistant, not with a Trunk. Start a new conversation to talk live.";
  if (conversationCarrier(deps.store, sessionId))
    return "Talk live works in conversations you started here. This one began outside Branch (a chat app, a schedule or another program). Start a new conversation to talk live.";
  return null;
}
