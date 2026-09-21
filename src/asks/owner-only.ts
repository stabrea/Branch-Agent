import type { ToolContext } from "../contracts.js";
import { chatOwnerOnly, runOrigin, startedFromChat, startedWithShortLivedKey } from "../key-context.js";
import type { Store } from "../store.js";

/**
 * For the asks parts that keep the owner's own records (forecasts, prospects): nobody but the owner, in
 * work the owner started, reads or changes them. Checked in each tool before anything is read, because
 * reading them is marked look-only, and look-only work is let through for outside work on purpose — a
 * schedule, a trigger, another program, a chat app or a household task would otherwise be handed the
 * owner's list once the part was switched on.
 */
export function ownerWorkOnly(store: Store, context: ToolContext, what: string): void {
  store.profiles.requireOwner(what);
  const origin = context.runId && store.run(context.runId) ? runOrigin(store, context.runId) : null;
  if (startedWithShortLivedKey() || origin?.shortLivedKey)
    throw new Error(`${what} is for the owner only, and a short-lived key cannot reach it. Use it in the Branch app.`);
  if (startedFromChat(context, store)) throw chatOwnerOnly(what);
  if (origin?.personProfileId || origin?.lentTo)
    throw new Error(`${what} is for the owner only, and this conversation belongs to somebody else.`);
  // Either one saying "not the owner" is enough: a manual run carries its source on the context and
  // nothing in the task's record, and a helper carries it in the record and nothing on the context.
  const outside = [origin?.source, context.source].find((source) => source !== undefined && source !== "owner");
  if (outside)
    throw new Error(`${what} is for work you started yourself, not for a ${outside}. Use it in the Branch app.`);
}
