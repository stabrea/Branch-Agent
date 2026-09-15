import { randomInt } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";
import type { Runtime } from "../runtime.js";

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
  send(chatId: string, text: string, replyToMessageId?: string): Promise<void>;
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
export const replyLimit = 3500;

export class ChannelRouter {
  private readonly adapters = new Map<string, { adapter: ChannelAdapter; policy: ChannelPolicy }>();
  constructor(private readonly store: Store, private readonly runtime: Runtime) {}
  async attach(adapter: ChannelAdapter, policy: ChannelPolicy): Promise<void> {
    if (this.adapters.has(adapter.id)) throw new Error(`Channel ${adapter.id} is already attached`);
    this.adapters.set(adapter.id, { adapter, policy: ChannelPolicySchema.parse(policy) });
    await adapter.start((message) => this.handle(message).then(() => undefined));
  }
  async detachAll(): Promise<void> {
    const stops = [...this.adapters.values()].map(({ adapter }) => adapter.stop());
    this.adapters.clear();
    await Promise.allSettled(stops);
  }
  summary() {
    const owner = this.runtime.owner;
    return {
      channels: [...this.adapters.values()].map(({ adapter, policy }) => ({ id: adapter.id, kind: adapter.kind, botName: adapter.botName(), ...policy })),
      pending: this.pairs(owner).filter((p) => p.status === "pending"),
      approved: this.pairs(owner).filter((p) => p.status === "approved"),
    };
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
    return this.answer(adapter, message);
  }
  private async answer(adapter: ChannelAdapter, message: InboundMessage): Promise<Outcome> {
    const owner = this.runtime.owner, key = `channel-session:${message.channel}:${message.chatId}`;
    const saved = this.store.get("settings", owner, key)?.data as { sessionId?: string } | undefined;
    const sessionId = saved?.sessionId && this.store.ownsSession(owner, saved.sessionId) ? saved.sessionId : undefined;
    const prompt = message.chatKind === "group" ? `[${message.senderName} in ${message.chatTitle ?? "a group"}] ${message.text}` : message.text;
    try {
      const run = await this.runtime.run({
        prompt, ...(sessionId ? { sessionId } : {}),
        permissions: this.runtime.registry.permissions().filter((p) => p !== "shell.execute"),
      });
      this.store.save("settings", owner, key, { sessionId: run.sessionId, channel: message.channel, chatId: message.chatId, updatedAt: run.updatedAt });
      const text = run.status === "completed" ? run.output || "(no reply)" : `I could not finish that (${run.status}).`;
      await adapter.send(message.chatId, text.length > replyLimit ? text.slice(0, replyLimit - 1) + "…" : text, message.messageId);
      return run.status === "completed" ? "replied" : "failed";
    } catch (error) {
      await adapter.send(message.chatId, "Something went wrong on my side; the owner can see the details in Activity.", message.messageId).catch(() => undefined);
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
