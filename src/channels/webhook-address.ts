import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";

/**
 * The address a chat service posts to. It used to be `/webhooks/chat/<name you chose>`, which is a
 * name a person picks and so a name somebody else can guess: "telegram", "slack", "work". Guessing
 * it does not let anyone in — every post still has to be signed by the service — but it does let
 * anyone on the internet find the door and knock on it, which is a thing they should not be able to
 * do. So each channel now gets a long random word of its own on the end of its address, made on
 * this computer and never guessable, and the address is shown once on the Connections card with a
 * button that copies it.
 *
 * Nothing about the signature check changes: the word is a harder door to find, not a way in.
 */
const secretPattern = /^[a-f0-9]{32}$/;
/** 16 random bytes: 128 bits, written as the 32 characters that go in an address. */
export const webhookSecretBytes = 16;

const AddressSchema = z.object({
  secret: z.string().regex(secretPattern),
  madeAt: z.string().max(40),
}).strict();

/**
 * Whether an address with no random word on the end is still answered. It starts true, so a copy
 * that is updated keeps working while the owner goes round their chat services pasting in the new
 * addresses, and the note beside it says when that stops.
 */
export const WebhookAddressSettingsSchema = z.object({
  acceptOldAddresses: z.boolean().default(true),
  /**
   * The day the old shape stops being answered, written down when this copy first made an address,
   * so the Connections card can say "old addresses stop working on <date>" rather than "soon".
   */
  oldAddressesEndOn: z.string().max(40).default(""),
}).strict();
export type WebhookAddressSettings = z.infer<typeof WebhookAddressSettingsSchema>;
/** One release's worth of grace, so the owner is never cut off without warning. */
export const oldAddressGraceDays = 30;

const key = (channel: string): string => `webhook-address:${channel}`;
const settingsKey = "webhook-addresses";

export function webhookAddressSettings(store: Store, owner: string): WebhookAddressSettings {
  const saved = WebhookAddressSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : WebhookAddressSettingsSchema.parse({});
}
export function saveWebhookAddressSettings(store: Store, owner: string, input: unknown): WebhookAddressSettings {
  const value = WebhookAddressSettingsSchema.parse({ ...webhookAddressSettings(store, owner), ...(input as object ?? {}) });
  store.save("settings", owner, settingsKey, value);
  return value;
}

/**
 * This channel's random word, made the first time it is asked for. Asking twice gives the same one,
 * so the address on the Connections card is the address the service is already posting to.
 */
export function webhookSecret(store: Store, owner: string, channel: string): string {
  const saved = AddressSchema.safeParse(store.get("settings", owner, key(channel))?.data ?? {});
  if (saved.success) return saved.data.secret;
  return newSecret(store, owner, channel);
}
/** A fresh word, for when the owner thinks somebody else has seen the address. */
export function rotateWebhookSecret(store: Store, owner: string, channel: string): string {
  return newSecret(store, owner, channel);
}
function newSecret(store: Store, owner: string, channel: string): string {
  const secret = randomBytes(webhookSecretBytes).toString("hex");
  store.save("settings", owner, key(channel), { secret, madeAt: new Date().toISOString() });
  // The first address ever made starts the clock on the old shape, so the card can give a date.
  const settings = webhookAddressSettings(store, owner);
  if (!settings.oldAddressesEndOn)
    saveWebhookAddressSettings(store, owner, {
      oldAddressesEndOn: new Date(Date.now() + oldAddressGraceDays * 86_400_000).toISOString().slice(0, 10),
    });
  return secret;
}

/** The whole address, as it is pasted into the chat service's own settings. */
export const webhookAddress = (kind: "chat" | "whatsapp", channel: string, secret: string): string =>
  `/webhooks/${kind}/${channel}/${secret}`;

/** Two words compared without letting the time it takes say how much of one was right. */
export function sameSecret(supplied: string, expected: string): boolean {
  if (!secretPattern.test(supplied) || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

/**
 * Why a post to this address is not answered, or null when it may be. An address carrying the right
 * word is always answered; one carrying the wrong word never is; one carrying none is answered only
 * while the owner is still being given time to paste the new addresses in.
 */
export function webhookAddressRefusal(
  store: Store, owner: string, channel: string, supplied: string | undefined,
): string | null {
  const expected = webhookSecret(store, owner, channel);
  if (supplied !== undefined) return sameSecret(supplied, expected) ? null : "No chat service is connected at that address";
  if (webhookAddressSettings(store, owner).acceptOldAddresses) return null;
  return "No chat service is connected at that address";
}
