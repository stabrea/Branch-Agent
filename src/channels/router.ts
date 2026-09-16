import { randomInt } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";
import type { Runtime } from "../runtime.js";
import { Deliveries } from "./deliveries.js";

/**
 * Messaging channels (Telegram first) deliver messages from chats into conversations. Each chat
 * keeps its own conversation; unknown senders must pair once with a code the owner approves;
 * group chats answer only when addressed unless configured otherwise. Channel tasks never get
 * host command execution.
 */
export interface InboundMessage {
  channel: string;
  chatId: string;
  chatKind: "direct" | "group";
  chatTitle?: string;
  senderId: string;
  senderName: string;
  text: string;
  addressed: boolean;
  messageId: string;
}
export interface ChannelAdapter {
  readonly id: string;
  readonly kind: string;
  botName(): string | null;
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined>;
  stop(): Promise<void>;
}
export const ChannelPolicySchema = z.object({
  activation: z.enum(["mention", "always"]).default("mention"),
  pairing: z.boolean().default(true),
  allowlist: z.array(z.string().min(1).max(64)).max(64).default([]),
}).strict();
export type ChannelPolicy = z.infer<typeof ChannelPolicySchema>;
export type Outcome = "replied" | "ignored" | "pairing" | "rejected" | "failed";
const pairSchema = z.object({
  status: z.enum(["pending", "approved"]), code: z.string().length(6), name: z.string().max(120),
  requestedAt: z.string(), approvedAt: z.string().optional(),
}).strict();
type Pair = z.infer<typeof pairSchema>;

export class ChannelRouter {
  private readonly adapters = new Map<string, { adapter: ChannelAdapter; policy: ChannelPolicy }>();
  readonly deliveries: Deliveries;
  private pump: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> = Promise.resolve();
  constructor(private readonly store: Store, private readonly runtime: Runtime, public pumpMs = 10000) {
    this.deliveries = new Deliveries(store, runtime.owner);
  }
  async attach(adapter: ChannelAdapter, policy: ChannelPolicy): Promise<void> {
    if (this.adapters.has(adapter.id)) throw new Error(`Channel ${adapter.id} is already attached`);
    this.adapters.set(adapter.id, { adapter, policy: ChannelPolicySchema.parse(policy) });
    await adapter.start((message) => this.handle(message).then(() => undefined));
    if (!this.pump) { this.pump = setInterval(() => void this.flush(), this.pumpMs); this.pump.unref(); }
    await this.flush();
  }
  async detachAll(): Promise<void> {
    if (this.pump) clearInterval(this.pump);
    this.pump = undefined;
    const stops = [...this.adapters.values()].map(({ adapter }) => adapter.stop());
    this.adapters.clear();
    await Promise.allSettled(stops);
  }
  /** Sends every due chunk on every connected channel, one flush at a time. */
  flush(): Promise<void> {
    return (this.flushing = this.flushing.then(async () => {
      for (const [id, { adapter }] of this.adapters)
        await this.deliveries.flush(id, (chatId, text, replyTo) => adapter.send(chatId, text, replyTo)).catch(() => undefined);
    }));
  }
  /** Outbound messages that are waiting or gave up, for the owner to see and retry. */
  outstanding() {
    return this.deliveries.outstanding().map((d) => ({ id: d.id, channel: d.channel, chatId: d.chatId, status: d.status, attempts: d.attempts,
      lastError: d.lastError, nextAt: d.nextAt, preview: d.text.slice(0, 120), createdAt: d.createdAt }));
  }
  async retryDelivery(id: string) {
    const row = this.deliveries.retry(id);
    await this.flush();
    return this.deliveries.list().find((d) => d.id === row.id) ?? row;
  }
  summary() {
    const owner = this.runtime.owner;
    return {
      channels: [...this.adapters.values()].map(({ adapter, policy }) => ({ id: adapter.id, kind: adapter.kind, botName: adapter.botName(), ...policy })),
      pending: this.pairs(owner).filter((p) => p.status === "pending"),
      approved: this.pairs(owner).filter((p) => p.status === "approved"),
      chats: this.chats(owner),
    };
  }
  /**
   * Queues text for a chat and sends it if the channel is up. The key makes a repeat call a no-op,
   * so a task finished while the channel was down is delivered once, in order, after reconnect.
   */
  async deliver(channel: string, chatId: string, text: string, key = `delivery:${Date.now()}:${randomInt(1e9)}`, replyTo?: string): Promise<{ messageId?: string | undefined; queued: number }> {
    if (!this.adapters.has(channel)) throw new Error(`Channel ${channel} is not connected`);
    this.deliveries.enqueue(channel, chatId, text, key, replyTo);
    await this.flush();
    const now = this.deliveries.list().filter((d) => d.key === key);
    const first = now.find((d) => d.seq === 0);
    if (first?.status === "dead") throw new Error(`Could not deliver to ${channel}: ${first.lastError ?? "unknown error"}`);
    return { messageId: first?.messageId ?? undefined, queued: now.filter((d) => d.status === "pending").length };
  }
  /** Chats that have talked to the assistant, usable as delivery targets. */
  chats(owner: string) {
    return this.store.list("settings", owner).flatMap((record) => {
      if (!record.id.startsWith("channel-session:")) return [];
      const data = record.data as { channel?: string; chatId?: string; title?: string; updatedAt?: string };
      return data.channel && data.chatId ? [{ channel: data.channel, chatId: data.chatId, title: data.title ?? data.chatId, updatedAt: data.updatedAt ?? record.updatedAt }] : [];
    });
  }
  async handle(message: InboundMessage): Promise<Outcome> {
    const entry = this.adapters.get(message.channel);
    if (!entry) return "ignored";
    const { adapter, policy } = entry;
    if (message.chatKind === "group" && policy.activation === "mention" && !message.addressed) return "ignored";
    const access = this.access(message, policy);
    if (access !== "allowed") {
      const text = access === "pairing"
        ? `I don't know you yet. Ask my owner to approve code ${this.pairingCode(message)} under Settings → Channels, then message me again.`
        : "This assistant is private.";
      await adapter.send(message.chatId, text, message.messageId);
      return access;
    }
    return this.answer(message);
  }
  private async answer(message: InboundMessage): Promise<Outcome> {
    const owner = this.runtime.owner, key = `channel-session:${message.channel}:${message.chatId}`;
    const saved = this.store.get("settings", owner, key)?.data as { sessionId?: string } | undefined;
    const sessionId = saved?.sessionId && this.store.ownsSession(owner, saved.sessionId) ? saved.sessionId : undefined;
    const prompt = message.chatKind === "group" ? `[${message.senderName} in ${message.chatTitle ?? "a group"}] ${message.text}` : message.text;
    try {
      const run = await this.runtime.run({
        prompt, ...(sessionId ? { sessionId } : {}),
        permissions: this.runtime.registry.permissions().filter((p) => p !== "shell.execute"),
        onTextDelta: () => undefined, // stream so a silent model is noticed
      });
      this.store.save("settings", owner, key, { sessionId: run.sessionId, channel: message.channel, chatId: message.chatId,
        title: message.chatKind === "group" ? (message.chatTitle ?? message.chatId) : message.senderName, updatedAt: run.updatedAt });
      const text = run.status === "completed" ? run.output || "(no reply)" : run.status === "needs_input" ? run.output : `I could not finish that (${run.status}).`;
      await this.deliver(message.channel, message.chatId, text, `reply:${run.id}`, message.messageId).catch(() => undefined);
      return run.status === "completed" || run.status === "needs_input" ? "replied" : "failed";
    } catch (error) {
      await this.deliver(message.channel, message.chatId, "Something went wrong on my side; the owner can see the details in Activity.", `reply-error:${message.channel}:${message.messageId}`, message.messageId).catch(() => undefined);
      void error;
      return "failed";
    }
  }
  private access(message: InboundMessage, policy: ChannelPolicy): "allowed" | "pairing" | "rejected" {
    if (policy.allowlist.includes(message.senderId)) return "allowed";
    if (this.pair(message.channel, message.senderId)?.status === "approved") return "allowed";
    return policy.pairing ? "pairing" : "rejected";
  }
  private pairingCode(message: InboundMessage): string {
    const existing = this.pair(message.channel, message.senderId);
    if (existing?.status === "pending") return existing.code;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.store.save("settings", this.runtime.owner, `channel-pair:${message.channel}:${message.senderId}`,
      { status: "pending", code, name: message.senderName.slice(0, 120), requestedAt: new Date().toISOString() } satisfies Pair);
    return code;
  }
  /** The owner approves a pending sender by typing the code the sender was shown. */
  approve(owner: string, input: unknown) {
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).strict().parse(input);
    const match = this.pairs(owner).find((p) => p.status === "pending" && p.code === code);
    if (!match) throw new Error("No pending request has that code");
    const approved: Pair = { status: "approved", code: match.code, name: match.name, requestedAt: match.requestedAt, approvedAt: new Date().toISOString() };
    this.store.save("settings", owner, `channel-pair:${match.channel}:${match.senderId}`, approved);
    return { ...approved, channel: match.channel, senderId: match.senderId };
  }
  remove(owner: string, input: unknown) {
    const { channel, senderId } = z.object({ channel: z.string().min(1).max(64), senderId: z.string().min(1).max(64) }).strict().parse(input);
    return { removed: this.store.delete("settings", owner, `channel-pair:${channel}:${senderId}`) };
  }
  private pair(channel: string, senderId: string): Pair | undefined {
    const parsed = pairSchema.safeParse(this.store.get("settings", this.runtime.owner, `channel-pair:${channel}:${senderId}`)?.data);
    return parsed.success ? parsed.data : undefined;
  }
  private pairs(owner: string) {
    return this.store.list("settings", owner).flatMap((record) => {
      if (!record.id.startsWith("channel-pair:")) return [];
      const parsed = pairSchema.safeParse(record.data);
      if (!parsed.success) return [];
      const [, channel, ...rest] = record.id.split(":");
      return [{ ...parsed.data, channel: channel!, senderId: rest.join(":") }];
    });
  }
}
