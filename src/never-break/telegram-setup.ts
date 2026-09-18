import { z } from "zod";
import { FeatureModeSchema } from "../feature-switches.js";
import { ChannelPolicySchema, type ChannelRouter } from "../channels/router.js";
import { TelegramAdapter } from "../channels/telegram.js";
import type { Store } from "../store.js";
import { channelPosition } from "./channel-position.js";

/**
 * Telegram, set up from a card instead of a settings file: the owner makes a bot with BotFather,
 * pastes its token (which goes straight into the locker and is never shown again), and pairs their
 * own account with the six-digit code the bot sends back. Ships off; with the switch on (or when
 * needed) Branch connects the bot the next time it starts, unless the settings file already has one.
 */
export const telegramSecretName = "TELEGRAM_BOT_TOKEN";
const settingsKey = "telegram-setup";

export const TelegramSetupInputSchema = z.object({
  mode: FeatureModeSchema.optional(),
  /** BotFather's token: digits, a colon, then about 35 letters, digits, dashes or underscores. */
  token: z.string().trim().regex(/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/, "That does not look like a bot token from BotFather. It is a number, a colon, then a long run of letters and digits.").optional(),
}).strict();

type Router = Pick<ChannelRouter, "summary" | "attach">;
interface SecretsLike {
  list(owner: string, project: string): { name: string }[];
  put(owner: string, project: string, name: string, value: string, options: { expiresInDays: number }): Promise<unknown>;
  resolve(owner: string, project: string, names: string[], options: { purpose: "channel" }): Promise<Record<string, string | undefined>>;
}
const secretsOf = (store: Store): SecretsLike => store.secrets as unknown as SecretsLike;

export function telegramMode(store: Pick<Store, "get">, owner: string): z.infer<typeof FeatureModeSchema> {
  const parsed = FeatureModeSchema.safeParse(store.get("settings", owner, settingsKey)?.data.mode);
  return parsed.success ? parsed.data : "off";
}

export function telegramSetupView(store: Store, owner: string, router: Router): Record<string, unknown> {
  let tokenSaved = false;
  try { tokenSaved = secretsOf(store).list(owner, "default").some((secret) => secret.name === telegramSecretName); }
  catch { /* a locked locker says nothing about what it holds */ }
  const connected = router.summary().channels.find((channel) => channel.kind === "telegram");
  return { mode: telegramMode(store, owner), tokenSaved, connected: Boolean(connected), botName: connected?.botName ?? null,
    waiting: router.summary().pending.filter((pair) => pair.channel === connected?.id).length };
}

/** Saves the switch and, when given, the token. The token is never written anywhere but the locker. */
export async function saveTelegramSetup(store: Store, owner: string, input: unknown): Promise<void> {
  const parsed = TelegramSetupInputSchema.parse(input);
  if (parsed.token) await secretsOf(store).put(owner, "default", telegramSecretName, parsed.token, { expiresInDays: 0 });
  if (parsed.mode) store.save("settings", owner, settingsKey, { mode: parsed.mode, changedAt: new Date().toISOString() });
}

/**
 * Connects the bot set up on the card, at start. Answers why it did not, in a sentence, or null when
 * it connected. A Telegram channel from the settings file always wins, so one bot is never read twice.
 */
export async function connectGuidedTelegram(input: { store: Store; owner: string; router: Router; fetch: typeof fetch }): Promise<string | null> {
  if (telegramMode(input.store, input.owner) === "off") return "The Telegram card is switched off.";
  if (input.router.summary().channels.some((channel) => channel.kind === "telegram")) return "Telegram is already connected from the settings file.";
  let token: string | undefined;
  try { token = (await secretsOf(input.store).resolve(input.owner, "default", [telegramSecretName], { purpose: "channel" }))[telegramSecretName]; }
  catch { return "The locker is closed, so the bot token could not be read. Unlock Branch and restart it."; }
  if (!token) return "No bot token has been saved yet.";
  const position = channelPosition(input.store, "telegram", input.owner);
  const adapter = new TelegramAdapter({ id: "telegram", token, fetch: input.fetch, ...(position ? { position } : {}) });
  try { await input.router.attach(adapter, ChannelPolicySchema.parse({})); return null; }
  catch (error) {
    await adapter.stop().catch(() => undefined);
    return `Telegram did not connect: ${error instanceof Error ? error.message.replace(/bot[^/\s]*/g, "bot…") : "unknown problem"}`;
  }
}
