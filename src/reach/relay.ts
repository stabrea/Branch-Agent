import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "../channels/router.js";
import { readCapped } from "../interop/agent-market.js";
import { lockedDown } from "../lockdown.js";
import type { Store } from "../store.js";
import { reachMode, reachRecord, requireReach } from "./settings.js";

/**
 * R17-080: a relay that holds the owner's chat app accounts (a Telegram bot, a Slack app…) on a
 * machine of the owner's choosing, so this computer never keeps those credentials and never needs
 * an address of its own. Branch reaches the relay; the relay never reaches Branch.
 *
 * End-to-end: every message between the relay and this computer is sealed with AES-256-GCM under a
 * key derived (HKDF-SHA-256) from a pairing secret kept in the locker, and both ends' ids and the
 * time are bound into the seal. The relay's own storage and anything between see only sealed bytes.
 * A message is refused when it is not addressed to this computer, not from the paired relay, older
 * or newer than five minutes, a repeat, or does not open.
 *
 * Never an open relay: this computer only ever sends to a chat that first wrote to it through the
 * relay, on a chat app the owner allowed, and it never passes a message on to anywhere a message
 * names. Messages that arrive go through the ordinary chat door (src/channels/router.ts), so the
 * sender list, pairing codes and every other chat rule apply as for any chat app. Off by default:
 * nothing is polled or sent while the switch is off.
 *
 * The idea is Hermes Agent's relay connector (MIT); this is an independent implementation.
 */
export const RelaySettingsSchema = z.object({
  address: z.string().trim().max(2048).default(""),
  /** This computer's id at the relay; made once, never secret. */
  machineId: z.string().regex(/^[a-f0-9]{16}$/).or(z.literal("")).default(""),
  /** The relay's id, as the relay's own setup shows it. */
  relayId: z.string().trim().max(40).regex(/^[a-z0-9-]*$/).default(""),
  /** The locker entry holding the pairing secret (at least 32 random bytes, as hex or base64). */
  secret: z.string().trim().max(80).default("BRANCH_RELAY_SECRET"),
  /** The chat apps the relay may bring messages from. Empty means none. */
  platforms: z.array(z.string().trim().min(1).max(32).regex(/^[a-z0-9-]+$/)).max(20).default([]),
}).strict();
export type RelaySettings = z.infer<typeof RelaySettingsSchema>;
const settingsKey = "reach-relay-settings";
const chatsKey = "reach-relay-chats";
const ChatsSchema = z.object({ chats: z.array(z.string().max(120)).max(500).default([]) }).strict();

export function relaySettings(store: Store, owner: string): RelaySettings { return reachRecord(store, owner, settingsKey, RelaySettingsSchema); }
export function saveRelaySettings(store: Store, owner: string, input: unknown): RelaySettings {
  const next = RelaySettingsSchema.parse({ ...relaySettings(store, owner), ...(input as object ?? {}) });
  if (next.address && new URL(next.address).protocol !== "https:") throw new Error("The relay is reached over https only.");
  if (!next.machineId) next.machineId = randomBytes(8).toString("hex");
  store.save("settings", owner, settingsKey, next);
  return next;
}

const skewMs = 5 * 60_000;
export const EnvelopeSchema = z.object({
  v: z.literal(1), from: z.string().max(40), to: z.string().max(40), ts: z.number().int(),
  nonce: z.string().regex(/^[a-f0-9]{24}$/), body: z.string().max(200_000), tag: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
}).strict();
export type Envelope = z.infer<typeof EnvelopeSchema>;
const Id = z.string().min(1).max(120).regex(/^[^\u0000-\u001f]+$/);
export const InboundSchema = z.object({
  kind: z.literal("message"), platform: z.string().max(32), chatId: Id, chatKind: z.enum(["direct", "group"]),
  senderId: Id, senderName: z.string().max(120), text: z.string().max(16000), messageId: Id, addressed: z.boolean().default(true),
}).strict();
export type RelayInbound = z.infer<typeof InboundSchema>;

/** The key for one direction, bound to both ends' ids. */
export function relayKey(secret: string, from: string, to: string): Buffer {
  const raw = /^[a-f0-9]+$/i.test(secret) ? Buffer.from(secret, "hex") : Buffer.from(secret, "base64");
  if (raw.length < 32) throw new Error("The relay pairing secret must be at least 32 random bytes.");
  return Buffer.from(hkdfSync("sha256", raw, "branch-relay-v1", `${from}>${to}`, 32));
}
/** The bearer the relay knows this computer by: derived, so the pairing secret itself never travels. */
export function relayBearer(secret: string, machineId: string, relayId: string): string {
  return relayKey(secret, `auth:${machineId}`, relayId).toString("hex");
}
const aad = (e: Pick<Envelope, "v" | "from" | "to" | "ts" | "nonce">): Buffer => Buffer.from(`${e.v}|${e.from}|${e.to}|${e.ts}|${e.nonce}`);

export function seal(secret: string, from: string, to: string, payload: unknown, now = Date.now()): Envelope {
  const head = { v: 1 as const, from, to, ts: now, nonce: randomBytes(12).toString("hex") };
  const cipher = createCipheriv("aes-256-gcm", relayKey(secret, from, to), Buffer.from(head.nonce, "hex"));
  cipher.setAAD(aad(head));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return { ...head, body: body.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

/** Opens one envelope for this computer, or says in one sentence why not. Repeats are caught by `seen`. */
export function openEnvelope(secret: string, me: string, relay: string, input: unknown, seen: Map<string, number>, now = Date.now()): unknown {
  const e = EnvelopeSchema.parse(input);
  if (e.to !== me) throw new Error("Not addressed to this computer, so it was not passed on anywhere.");
  if (!safeEqual(e.from, relay)) throw new Error("Not from the paired relay.");
  if (Math.abs(now - e.ts) > skewMs) throw new Error("Too old or from the future.");
  for (const [nonce, at] of seen) if (now - at > 2 * skewMs) seen.delete(nonce);
  if (seen.has(e.nonce)) throw new Error("Already received once.");
  const decipher = createDecipheriv("aes-256-gcm", relayKey(secret, e.from, e.to), Buffer.from(e.nonce, "hex"));
  decipher.setAAD(aad(e));
  decipher.setAuthTag(Buffer.from(e.tag, "base64"));
  let text: string;
  try { text = Buffer.concat([decipher.update(Buffer.from(e.body, "base64")), decipher.final()]).toString("utf8"); }
  catch { throw new Error("Does not open with the pairing secret."); }
  seen.set(e.nonce, now);
  return JSON.parse(text);
}
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface RelayDeps { store: Store; owner: string; fetcher: typeof fetch; secret: (name: string) => Promise<string>; pollMs?: number; now?: () => number }

/** The relay as a chat app. Chat ids here are `platform:chat id`. */
export class RelayAdapter implements ChannelAdapter {
  readonly id = "relay";
  readonly kind = "relay";
  readonly maxTextLength = 4000;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly seen = new Map<string, number>();
  private state: ChannelHealth = { state: "connected" };
  refused = 0;
  constructor(private readonly deps: RelayDeps) {}

  botName(): string | null { return "Relay"; }
  health(): ChannelHealth { return this.state; }
  /** Off, or Lockdown on (integration review): the relay is neither asked nor sent to. */
  private on(): boolean { return reachMode(this.deps.store, this.deps.owner, "relay") !== "off" && !lockedDown(this.deps.store, this.deps.owner); }
  private settings(): RelaySettings { return relaySettings(this.deps.store, this.deps.owner); }
  private now(): number { return this.deps.now?.() ?? Date.now(); }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.timer = setInterval(() => void this.poll(onMessage).catch(() => undefined), this.deps.pollMs ?? 5000);
    this.timer.unref();
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private async call(path: string, init: RequestInit, s: RelaySettings, secret: string): Promise<Response> {
    const response = await this.deps.fetcher(new URL(path, s.address), { ...init, redirect: "error", signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${relayBearer(secret, s.machineId, s.relayId)}`, "content-type": "application/json" } });
    if (!response.ok) throw new Error(`The relay answered ${response.status}`);
    return response;
  }

  /** One look at the relay's inbox. Does nothing while the switch is off or the relay is not set up. */
  async poll(onMessage: (message: InboundMessage) => Promise<void>): Promise<number> {
    const s = this.settings();
    if (!this.on() || !s.address || !s.relayId || !s.machineId) return 0;
    const secret = await this.deps.secret(s.secret);
    let body: unknown;
    try {
      const response = await this.call(`/v1/inbox?to=${s.machineId}`, { method: "GET" }, s, secret);
      body = JSON.parse((await readCapped(response, 2 * 1024 * 1024)).toString("utf8"));
      this.state = { state: "connected" };
    } catch (error) {
      this.state = { state: "reconnecting", reason: error instanceof Error ? error.message : String(error) };
      return 0;
    }
    const envelopes = z.object({ envelopes: z.array(z.unknown()).max(100) }).safeParse(body);
    let taken = 0;
    for (const raw of envelopes.success ? envelopes.data.envelopes : []) {
      const message = this.accept(raw, s, secret);
      if (message) { taken++; await onMessage(message); }
    }
    return taken;
  }

  private accept(raw: unknown, s: RelaySettings, secret: string): InboundMessage | null {
    try {
      const m = InboundSchema.parse(openEnvelope(secret, s.machineId, s.relayId, raw, this.seen, this.now()));
      if (!s.platforms.includes(m.platform)) throw new Error("A chat app the owner did not allow.");
      this.remember(`${m.platform}:${m.chatId}`);
      return { channel: this.id, chatId: `${m.platform}:${m.chatId}`, chatKind: m.chatKind, senderId: `${m.platform}:${m.senderId}`,
        senderName: m.senderName, text: m.text, addressed: m.addressed, messageId: m.messageId };
    } catch { this.refused++; return null; }
  }

  private remember(chat: string): void {
    const { chats } = reachRecord(this.deps.store, this.deps.owner, chatsKey, ChatsSchema);
    if (!chats.includes(chat)) this.deps.store.save("settings", this.deps.owner, chatsKey, { chats: [...chats, chat].slice(-500) });
  }
  knownChats(): string[] { return reachRecord(this.deps.store, this.deps.owner, chatsKey, ChatsSchema).chats; }

  /** Sends only to a chat that wrote first through the relay, on an allowed chat app. */
  async send(chatId: string, text: string, replyTo?: string): Promise<string | undefined> {
    if (lockedDown(this.deps.store, this.deps.owner)) throw new Error("Lockdown is on, so nothing is sent through the relay.");
    requireReach(this.deps.store, this.deps.owner, "relay");
    const s = this.settings();
    const platform = chatId.split(":")[0] ?? "";
    if (!s.platforms.includes(platform) || !this.knownChats().includes(chatId))
      throw new Error("The relay only answers chats that wrote to Branch through it first.");
    const secret = await this.deps.secret(s.secret);
    const envelope = seal(secret, s.machineId, s.relayId, { kind: "send", platform, chatId: chatId.slice(platform.length + 1), text, replyTo: replyTo ?? null }, this.now());
    const response = await this.call("/v1/outbox", { method: "POST", body: JSON.stringify({ envelope }) }, s, secret);
    const answer = await response.json().catch(() => ({})) as { messageId?: unknown };
    return typeof answer.messageId === "string" ? answer.messageId.slice(0, 120) : undefined;
  }
}
