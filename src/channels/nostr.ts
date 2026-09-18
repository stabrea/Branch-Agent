import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { reconnectDelay, type WebSocketConnect, type WebSocketConnection } from "./ws-client.js";
import { defineService, secretName } from "./parity-common.js";
import { nip04Decrypt, nip04Encrypt, publicKeyOf, readPrivateKey, signEvent, verifyEvent, type NostrEvent } from "./nostr-crypto.js";

/**
 * Nostr direct messages, written from NIP-01 (events and relays) and NIP-04 (encrypted direct
 * messages): https://github.com/nostr-protocol/nips. The assistant has its own key pair; the
 * private key is a saved secret (64 hex characters or `nsec1…`).
 *
 * Several relays are used at once. Each is asked for kind-4 events addressed to the assistant
 * since the moment Branch started, so nothing older is answered. Every event is checked (its id
 * and its signature) before it is believed, and the same event arriving from several relays is
 * handled once. A reply is encrypted to the sender, signed, and published to every relay.
 *
 * The person's public key (64 hex characters) is both the chat and the sender, so the owner can
 * put it straight into an allowlist.
 */
const hex64 = /^[0-9a-f]{64}$/;
const eventSchema = z.object({
  id: z.string(), pubkey: z.string(), created_at: z.number().int(), kind: z.number().int(),
  tags: z.array(z.array(z.string())), content: z.string().max(200_000), sig: z.string(),
});

export interface NostrOptions {
  id: string;
  relays: string[];
  secretKey: Uint8Array;
  connect: WebSocketConnect;
  now?: () => number;
  retryBaseMs?: number;
  publishTimeoutMs?: number;
}

export class NostrChannel implements ChannelAdapter {
  readonly id: string;
  readonly kind = "nostr";
  readonly maxTextLength = 3500;
  readonly publicKey: string;
  private readonly open = new Map<string, WebSocketConnection>();
  private readonly seen = new Set<string>();
  private readonly accepted = new Map<string, () => void>();
  private stopping = false;
  private loops: Promise<void>[] = [];
  private since = 0;
  private lastProblem = "Connecting to the relays";
  private onMessage: (message: InboundMessage) => Promise<void> = async () => undefined;
  constructor(private readonly options: NostrOptions) {
    this.id = options.id;
    this.publicKey = publicKeyOf(options.secretKey).toString("hex");
  }
  botName(): string | null { return `nostr:${this.publicKey.slice(0, 12)}`; }
  health(): ChannelHealth {
    if (this.open.size) return { state: "connected", ...(this.open.size < this.options.relays.length ? { reason: `${this.open.size} of ${this.options.relays.length} relays connected` } : {}) };
    return { state: "reconnecting", reason: this.lastProblem };
  }
  private now(): number { return Math.floor((this.options.now ?? Date.now)() / 1000); }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.stopping = false;
    this.onMessage = onMessage;
    this.since = this.now();
    this.loops = this.options.relays.map((relay) => this.run(relay));
    await Promise.race([Promise.all(this.loops), new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    for (const socket of this.open.values()) socket.close();
    await Promise.all(this.loops.map((loop) => loop.catch(() => undefined)));
    this.loops = [];
  }

  /** Keeps one relay connected, asking again for new messages each time it reconnects. */
  private async run(relay: string): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt++) {
      try {
        const socket = await this.options.connect(relay, { onMessage: (text) => this.onText(text) });
        this.open.set(relay, socket);
        // mac7/linux-fixes: a stop that arrived while this was still being opened found nothing to
        // close, and the loop then waited for a close nobody would ask for. Let it go straight away.
        if (this.stopping) socket.close();
        const filter = { kinds: [4], "#p": [this.publicKey], since: this.since };
        socket.send(JSON.stringify(["REQ", "branch-dm", filter]));
        await socket.closed;
        attempt = 0;
      } catch (error) {
        this.lastProblem = `Could not reach ${new URL(relay).hostname}: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.open.delete(relay);
      if (this.stopping) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.retryBaseMs ?? 1000)));
    }
  }

  private onText(text: string): void {
    let frame: unknown;
    try { frame = JSON.parse(text); } catch { return; }
    if (!Array.isArray(frame)) return;
    if (frame[0] === "EVENT" && frame[1] === "branch-dm") {
      const inbound = this.inbound(frame[2]);
      if (inbound) void this.onMessage(inbound).catch(() => undefined);
    } else if (frame[0] === "OK" && typeof frame[1] === "string" && frame[2] === true) {
      this.accepted.get(frame[1])?.();
    }
  }
  private inbound(raw: unknown): InboundMessage | null {
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) return null;
    const event = parsed.data;
    if (event.kind !== 4 || event.pubkey === this.publicKey || event.created_at < this.since || this.seen.has(event.id)) return null;
    if (!event.tags.some((tag) => tag[0] === "p" && tag[1] === this.publicKey)) return null;
    // Checked before it is remembered, so a forged copy cannot hide the real one.
    if (!verifyEvent(event)) return null;
    this.remember(event.id);
    let text: string;
    try { text = nip04Decrypt(this.options.secretKey, event.pubkey, event.content); } catch { return null; }
    if (!text.trim()) return null;
    return {
      channel: this.id, chatId: event.pubkey, chatKind: "direct", senderId: event.pubkey,
      senderName: `nostr:${event.pubkey.slice(0, 12)}`, text, addressed: true, messageId: event.id,
    };
  }
  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);
  }

  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    if (!hex64.test(chatId)) throw new Error("That is not a Nostr public key");
    if (!this.open.size) throw new Error("No Nostr relay is connected, so the message could not be sent");
    const tags = [["p", chatId], ...(replyToMessageId && hex64.test(replyToMessageId) ? [["e", replyToMessageId]] : [])];
    const event: NostrEvent = signEvent({
      created_at: this.now(), kind: 4, tags,
      content: nip04Encrypt(this.options.secretKey, chatId, text.slice(0, this.maxTextLength)),
    }, this.options.secretKey);
    this.remember(event.id);
    const stored = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.accepted.delete(event.id); reject(new Error("No Nostr relay accepted the message")); }, this.options.publishTimeoutMs ?? 10000);
      this.accepted.set(event.id, () => { clearTimeout(timer); this.accepted.delete(event.id); resolve(); });
    });
    for (const socket of this.open.values()) socket.send(JSON.stringify(["EVENT", event]));
    await stored;
    return event.id;
  }
}

export const nostrService = defineService({
  kind: "nostr", name: "Nostr", docs: "https://github.com/nostr-protocol/nips/blob/master/04.md",
  needs: ["A Nostr key pair for the assistant; its private key (hex or nsec) saved as a secret (NOSTR_PRIVATE_KEY)",
    "One or more relay addresses (wss://…)"],
  receives: "socket",
  settings: z.object({
    relays: z.array(z.string().max(300).regex(/^wss?:\/\/[^\s]+$/)).min(1).max(10),
    privateKeySecret: z.string().regex(secretName).default("NOSTR_PRIVATE_KEY"),
  }).strict(),
  async build(settings, deps) {
    for (const relay of settings.relays) await deps.assertAllowed(new URL(relay.replace(/^ws/, "http")), "Nostr relay");
    let secretKey: Buffer;
    try { secretKey = readPrivateKey(await deps.secret(settings.privateKeySecret)); } catch (error) {
      // The message names the problem, never the value.
      throw new Error(`The secret ${settings.privateKeySecret} is not a usable Nostr private key: ${error instanceof Error ? error.message : "unreadable"}`);
    }
    return new NostrChannel({ id: deps.id, relays: settings.relays, secretKey, connect: deps.connectWs });
  },
});
