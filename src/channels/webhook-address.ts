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
 *
 * mac7/channel-leaks: it stays true, and here is exactly what it is for. Version 0.15.0 shipped
 * `/webhooks/chat/<name>` with no word on the end at all; 0.16.0 put the word there. A copy that
 * connected a chat service while it was running 0.15.0 has that older address pasted into the chat
 * service's own settings, and turning this off by default would stop those messages arriving with
 * nothing said and nothing the owner could see. So the grace is kept — but it now costs something
 * the owner is told about on the Connections card, and `webhookAddressVerdict` refuses the old
 * shape outright while Branch is listening beyond this computer, whatever this says. The wider door
 * is the one moment when an address anybody can guess is worth more than the convenience.
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
  return storedWebhookSecret(store, owner, channel) ?? newSecret(store, owner, channel);
}
/**
 * This channel's random word if it already has one, and nothing at all if it does not. Nothing is
 * made here, which is what makes it safe to call on the way in: a post from the internet naming a
 * channel that does not exist must not leave a row behind it, or anyone at all could fill this
 * computer's settings with names they made up.
 */
export function storedWebhookSecret(store: Store, owner: string, channel: string): string | undefined {
  const saved = AddressSchema.safeParse(store.get("settings", owner, key(channel))?.data ?? {});
  return saved.success ? saved.data.secret : undefined;
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
 * The one sentence anybody who has not shown the word on the end of an address is ever told. It
 * says nothing about which chat services the owner has connected, because it is the same sentence
 * for every one of them and for every name nobody has ever used.
 */
export const wrongWebhookAddress = "No chat service is connected at that address";

/**
 * A word of the right shape that matches nothing, made once per launch. A name with no word of its
 * own is compared against this rather than skipped, so the time an answer takes does not say which
 * names exist. A faster "no such thing" is still an answer.
 */
const decoySecret = randomBytes(webhookSecretBytes).toString("hex");

/** What may be done with a post to this address, before a single byte of it has been believed. */
export type WebhookAddressVerdict =
  /** The word on the end is this channel's own: the caller holds a secret only the owner has. */
  | "proven"
  /** No word at all, and the grace for addresses saved before the word existed is still on. */
  | "old"
  /** Nothing else. */
  | "refused";

/**
 * What a post to this address may do. An address carrying the right word is proved; one carrying
 * the wrong word is refused; one carrying none is the old shape, allowed only while the grace lasts
 * and only while Branch is listening on this computer alone.
 *
 * Nothing is written here. This runs before anything has been checked, on a post that may have come
 * from anywhere, so a channel that has no word yet is simply one whose word does not match — never
 * a reason to make one and keep it. The word is made when the owner looks at the Connections card.
 */
export function webhookAddressVerdict(
  store: Store, owner: string, channel: string, supplied: string | undefined, beyondThisComputer = false,
): WebhookAddressVerdict {
  const stored = storedWebhookSecret(store, owner, channel);
  // Always compared, against the decoy when this name has no word of its own, and never short-cut
  // by an early return: the comparison is what makes the two cases take the same path.
  const matched = sameSecret(supplied ?? "", stored ?? decoySecret) && stored !== undefined;
  if (supplied !== undefined) return matched ? "proven" : "refused";
  if (beyondThisComputer) return "refused";
  return webhookAddressSettings(store, owner).acceptOldAddresses ? "old" : "refused";
}

/**
 * Why a post to this address is not answered, or null when it may be. Kept as the plain question
 * `webhookAddressVerdict` answers, for the places that only need a yes or a no.
 */
export function webhookAddressRefusal(
  store: Store, owner: string, channel: string, supplied: string | undefined, beyondThisComputer = false,
): string | null {
  return webhookAddressVerdict(store, owner, channel, supplied, beyondThisComputer) === "refused"
    ? wrongWebhookAddress : null;
}
