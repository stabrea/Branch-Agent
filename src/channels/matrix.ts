import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { handle } from "./email.js";
import { reconnectDelay } from "./ws-client.js";

/**
 * Matrix, over the ordinary client-server API with an access token. Matrix is not a webhook
 * service: nothing is posted to this computer. Instead one long request is held open asking "what
 * has happened since?", and when it answers the next one goes out. A dropped connection is retried
 * with a widening wait, and closing the channel stops the loop rather than leaving it retrying.
 *
 * **End-to-end encrypted rooms are not supported.** Messages in them arrive as `m.room.encrypted`
 * and Branch has no key to read them, so they are counted and reported in the channel's health
 * line rather than silently ignored. Invite the assistant to an unencrypted room.
 */
export interface MatrixOptions {
  id: string;
  /** The home server, for example https://matrix.org. */
  homeserver: string;
  /** An access token for the assistant's own Matrix account. */
  accessToken: string;
  /** The assistant's own user id (@branch:example.org), so its own posts are not answered. */
  userId: string;
  /** How long one "what has happened since?" request waits, in milliseconds. */
  syncTimeoutMs?: number;
  fetch?: typeof fetch;
  reconnectBaseMs?: number;
}
const eventSchema = z.object({
  type: z.string(), event_id: z.string().optional(), sender: z.string().optional(),
  content: z.object({ msgtype: z.string().optional(), body: z.string().optional() }).passthrough().optional(),
}).passthrough();
const syncSchema = z.object({
  next_batch: z.string(),
  rooms: z.object({
    join: z.record(z.string(), z.object({
      timeline: z.object({ events: z.array(eventSchema).default([]) }).passthrough().optional(),
    }).passthrough()).default({}),
  }).passthrough().optional(),
}).passthrough();

export class MatrixAdapter implements ChannelAdapter {
  readonly kind = "matrix";
  readonly id: string;
  /** Matrix has no hard limit, but a wall of text is unreadable; the ledger splits at this length. */
  readonly maxTextLength = 3500;
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private state: ChannelHealth = { state: "reconnecting", reason: "Connecting to Matrix" };
  private controller: AbortController | undefined;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private since: string | undefined;
  private encryptedSeen = 0;
  /** Room ids are longer than the delivery ledger allows, so long ones get a short handle. */
  private readonly rooms = new Map<string, string>();
  constructor(private readonly options: MatrixOptions) {
    this.id = options.id;
    this.base = options.homeserver.replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  botName(): string | null { return this.options.userId; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.loop = this.run(onMessage);
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.controller?.abort();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }
  /** Asks again and again what has happened, waiting longer each time the server will not answer. */
  private async run(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt++) {
      try {
        const batch = await this.sync();
        this.state = { state: "connected", ...(this.encryptedSeen ? { reason: `${this.encryptedSeen} message(s) arrived in an encrypted room, which this assistant cannot read` } : {}) };
        attempt = -1;
        for (const message of batch) { if (this.stopping) return; await onMessage(message).catch(() => undefined); }
        continue;
      } catch (error) {
        if (this.stopping) return;
        const reason = error instanceof Error ? error.message : String(error);
        this.state = { state: "reconnecting", reason: `Lost the Matrix connection: ${reason}` };
      }
      if (this.stopping) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.reconnectBaseMs ?? 1000)));
    }
  }
  /** One long request. Returns the messages worth answering and remembers where we got to. */
  private async sync(): Promise<InboundMessage[]> {
    const wait = this.options.syncTimeoutMs ?? 30000;
    const address = new URL(`${this.base}/_matrix/client/v3/sync`);
    address.searchParams.set("timeout", String(wait));
    if (this.since) address.searchParams.set("since", this.since);
    this.controller = new AbortController();
    const response = await this.fetch(address.href, {
      headers: { authorization: `Bearer ${this.options.accessToken}` },
      redirect: "error", signal: this.controller.signal,
    });
    if (!response.ok) throw new Error(`Matrix would not answer (${response.status})`);
    const body = syncSchema.parse(await response.json());
    const first = this.since === undefined;
    this.since = body.next_batch;
    const messages: InboundMessage[] = [];
    for (const [roomId, room] of Object.entries(body.rooms?.join ?? {}))
      for (const event of room.timeline?.events ?? []) {
        if (event.type === "m.room.encrypted") { this.encryptedSeen++; continue; }
        const inbound = this.inbound(roomId, event);
        // The first answer carries whatever was already there; answering it would reply to history.
        if (inbound && !first) messages.push(inbound);
      }
    return messages;
  }
  private inbound(roomId: string, event: z.infer<typeof eventSchema>): InboundMessage | null {
    if (event.type !== "m.room.message" || event.content?.msgtype !== "m.text") return null;
    const text = event.content.body ?? "", sender = event.sender ?? "";
    if (!text || !sender || sender === this.options.userId) return null;
    const chatId = handle(roomId, "room");
    if (chatId !== roomId) this.rooms.set(chatId, roomId);
    const name = this.options.userId.split(":")[0]!.replace(/^@/, "");
    return {
      channel: this.id, chatId, chatKind: "group", chatTitle: roomId,
      senderId: handle(sender, "who"), senderName: sender, text,
      addressed: text.includes(this.options.userId) || text.includes(name),
      messageId: handle(event.event_id ?? randomUUID(), "msg"),
    };
  }
  async send(chatId: string, text: string): Promise<string | undefined> {
    const roomId = this.rooms.get(chatId) ?? chatId;
    const address = `${this.base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${randomUUID()}`;
    const response = await this.fetch(address, {
      method: "PUT", headers: { authorization: `Bearer ${this.options.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "m.text", body: text.slice(0, this.maxTextLength) }),
      redirect: "error", signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Matrix refused the message (${response.status})`);
    const parsed = z.object({ event_id: z.string().optional() }).passthrough().safeParse(await response.json().catch(() => ({})));
    return parsed.success && parsed.data.event_id ? handle(parsed.data.event_id, "msg") : undefined;
  }
}
