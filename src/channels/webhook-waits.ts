import { z } from "zod";
import type { Store } from "../store.js";
import { storedWebhookSecret } from "./webhook-address.js";

/**
 * mac7/lockout: when a chat service is being turned away, the owner is told.
 *
 * A wait is invisible by design — the caller gets one sentence and goes away — so a service posting
 * to an address the owner has since replaced could be refused for five minutes at a time, for days,
 * with nothing anywhere saying so. The owner would only know that messages had stopped. Every wait
 * that starts is now written down here and shown on the Connections card beside that service's
 * address, next to the button that copies the address it should be using.
 *
 * Only a name the owner has actually made an address for is kept, so a stranger posting to names
 * they invented cannot fill this list. The record of refusals still gets its line either way.
 */
const WaitSchema = z.object({
  channel: z.string().max(40),
  /** When the wait ends, as a moment in time. */
  until: z.number(),
  /** Whether the caller had shown the word on the end of the address. */
  proven: z.boolean().default(false),
  at: z.string().max(40),
}).strict();
const ListSchema = z.object({ waits: z.array(WaitSchema).max(64).default([]) }).strict();
export type WebhookWait = z.infer<typeof WaitSchema>;
const waitsKey = "webhook-waits";
/** Kept for an hour after the wait ends, so a card looked at afterwards still explains the gap. */
const rememberMs = 60 * 60 * 1000;
const mostKept = 16;

function saved(store: Store, owner: string): WebhookWait[] {
  const row = ListSchema.safeParse(store.get("settings", owner, waitsKey)?.data ?? {});
  return row.success ? row.data.waits : [];
}

/** Writes down that posts to one chat service's address are being turned away for a while. */
export function noteWebhookWait(
  store: Store, owner: string, channel: string, until: number, proven: boolean, now = Date.now(),
): void {
  if (!storedWebhookSecret(store, owner, channel)) return;
  const kept = saved(store, owner)
    .filter((wait) => wait.channel !== channel && wait.until + rememberMs > now)
    .concat({ channel, until, proven, at: new Date(now).toISOString() })
    .slice(-mostKept);
  store.save("settings", owner, waitsKey, { waits: kept });
}

/** The waits worth showing: one per service, the ones still on first. */
export function webhookWaits(store: Store, owner: string, now = Date.now()): WebhookWait[] {
  return saved(store, owner).filter((wait) => wait.until + rememberMs > now)
    .sort((a, b) => b.until - a.until);
}
