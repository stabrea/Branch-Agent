import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { reconnectDelay, type WebSocketConnect, type WebSocketConnection } from "./ws-client.js";
import { defineService } from "./parity-common.js";

/**
 * SimpleX Chat, through the `simplex-chat` program the owner runs themselves with its WebSocket API
 * switched on (`simplex-chat -p 5225`). Written from the SimpleX bot API documentation
 * (https://github.com/simplex-chat/simplex-chat/tree/stable/bots/api): each command is
 * `{"corrId", "cmd"}`, its answer carries the same corrId, and new messages arrive as
 * `newChatItems` events. The event handling follows the shape used by Hermes Agent's SimpleX
 * adapter (MIT).
 *
 * Replies use the documented `/_send <chat ref> json [...]` command, which names the chat by its
 * number (`@12` for a contact, `#3` for a group) rather than by display name, so a name with spaces
 * or quotes can never be misread and the words travel as JSON, never as command text.
 *
 * The program's API has no password, so Branch only connects to it on this computer unless the
 * owner explicitly allows another address.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const member = z.object({ memberId: z.string().min(1).max(64), localDisplayName: z.string().optional() }).passthrough();
const chatItemSchema = z.object({
  chatInfo: z.object({
    type: z.string(),
    contact: z.object({ contactId: z.number(), localDisplayName: z.string().optional() }).passthrough().optional(),
    groupInfo: z.object({ groupId: z.number(), localDisplayName: z.string().optional() }).passthrough().optional(),
  }).passthrough(),
  chatItem: z.object({
    chatDir: z.object({ type: z.string(), groupMember: member.optional() }).passthrough(),
    meta: z.object({ itemId: z.number(), userMention: z.boolean().optional() }).passthrough(),
    content: z.object({ type: z.string(), msgContent: z.object({ type: z.string(), text: z.string().optional() }).passthrough().optional() }).passthrough(),
  }).passthrough(),
}).passthrough();
const eventSchema = z.object({ corrId: z.string().optional(), resp: z.record(z.string(), z.unknown()).optional() }).passthrough();

type Response = Record<string, unknown>;

export interface SimplexOptions {
  id: string;
  address: string;
  connect: WebSocketConnect;
  /** The assistant's display name, used to spot a mention when the program does not mark one. */
  displayName?: string;
  retryBaseMs?: number;
  timeoutMs?: number;
}

export class SimplexChannel implements ChannelAdapter {
  readonly id: string;
  readonly kind = "simplex";
  readonly maxTextLength = 3500;
  private state: ChannelHealth = { state: "reconnecting", reason: "Connecting to simplex-chat" };
  private socket: WebSocketConnection | null = null;
  private name: string | null;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private counter = 0;
  private readonly pending = new Map<string, (response: Response | null) => void>();
  private onMessage: (message: InboundMessage) => Promise<void> = async () => undefined;
  constructor(private readonly options: SimplexOptions) {
    this.id = options.id;
    this.name = options.displayName ?? null;
  }
  botName(): string | null { return this.name; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.stopping = false;
    this.onMessage = onMessage;
    this.loop = this.run();
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.socket?.close();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  private async run(): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt++) {
      try {
        const socket = await this.options.connect(this.options.address, { onMessage: (text) => this.onText(text) });
        this.socket = socket;
        // mac7/linux-fixes: a stop that arrived while this was still being opened found nothing to
        // close, and the loop then waited for a close nobody would ask for. Let it go straight away.
        if (this.stopping) socket.close();
        this.state = { state: "connected" };
        void this.learnName();
        await socket.closed;
        attempt = 0;
        if (!this.stopping) this.state = { state: "reconnecting", reason: "simplex-chat closed the connection" };
      } catch (error) {
        if (this.stopping) return;
        this.state = { state: "reconnecting", reason: `Could not reach simplex-chat at ${this.options.address}. Is it running with -p? (${error instanceof Error ? error.message : String(error)})` };
      }
      this.socket = null;
      for (const done of this.pending.values()) done(null);
      this.pending.clear();
      if (this.stopping) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.retryBaseMs ?? 1000)));
    }
  }
  /** Asks the program who the assistant is, so a mention by name is recognised. */
  private async learnName(): Promise<void> {
    const answer = await this.command("/user").catch(() => null);
    const user = answer?.user as { localDisplayName?: unknown; profile?: { displayName?: unknown } } | undefined;
    const name = user?.localDisplayName ?? user?.profile?.displayName;
    if (typeof name === "string" && name) this.name = name;
  }
  private command(cmd: string): Promise<Response | null> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("simplex-chat is not connected, so the message could not be sent"));
    const corrId = `branch-${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(corrId); reject(new Error("simplex-chat did not answer in time")); }, this.options.timeoutMs ?? 15000);
      this.pending.set(corrId, (response) => {
        clearTimeout(timer);
        if (response) resolve(response); else reject(new Error("simplex-chat closed the connection before answering"));
      });
      socket.send(JSON.stringify({ corrId, cmd }));
    });
  }

  private onText(text: string): void {
    let event: z.infer<typeof eventSchema>;
    try { event = eventSchema.parse(JSON.parse(text)); } catch { return; }
    // Usually {"corrId", "resp": {...}}; some versions put the fields at the top level.
    const resp = (event.resp ?? event) as Response;
    if (event.corrId && this.pending.has(event.corrId)) {
      this.pending.get(event.corrId)!(resp);
      this.pending.delete(event.corrId);
      return;
    }
    if (event.corrId || resp.type !== "newChatItems" || !Array.isArray(resp.chatItems)) return;
    for (const raw of resp.chatItems) {
      const parsed = chatItemSchema.safeParse(raw);
      const inbound = parsed.success ? this.inbound(parsed.data) : null;
      if (inbound) void this.onMessage(inbound).catch(() => undefined);
    }
  }
  private inbound(item: z.infer<typeof chatItemSchema>): InboundMessage | null {
    const { chatInfo, chatItem } = item;
    const text = chatItem.content.msgContent?.text ?? "";
    // Only messages somebody else sent: the assistant's own ("directSnd", "groupSnd") are skipped.
    if (chatItem.content.type !== "rcvMsgContent" || !text.trim()) return null;
    const messageId = String(chatItem.meta.itemId);
    if (chatInfo.type === "direct" && chatInfo.contact && chatItem.chatDir.type === "directRcv") {
      const { contactId, localDisplayName } = chatInfo.contact;
      return { channel: this.id, chatId: `@${contactId}`, chatKind: "direct", senderId: `contact:${contactId}`,
        senderName: localDisplayName || `contact ${contactId}`, text, addressed: true, messageId };
    }
    const sender = chatItem.chatDir.groupMember;
    if (chatInfo.type !== "group" || !chatInfo.groupInfo || chatItem.chatDir.type !== "groupRcv" || !sender) return null;
    const mention = this.name ? `@${this.name.toLowerCase()}` : null;
    const lower = text.toLowerCase();
    const leading = !!mention && lower.startsWith(mention);
    const words = leading ? text.slice(mention!.length).replace(/^[\s:,]+/, "") : text;
    return {
      channel: this.id, chatId: `#${chatInfo.groupInfo.groupId}`, chatKind: "group",
      chatTitle: chatInfo.groupInfo.localDisplayName || `group ${chatInfo.groupInfo.groupId}`,
      senderId: `member:${sender.memberId}`, senderName: sender.localDisplayName || "member",
      text: words || text, addressed: chatItem.meta.userMention === true || (!!mention && lower.includes(mention)), messageId,
    };
  }

  async send(chatId: string, text: string): Promise<string | undefined> {
    if (!/^[@#]\d{1,18}$/.test(chatId)) throw new Error("That is not a SimpleX chat Branch can send to");
    const messages = [{ msgContent: { type: "text", text: text.slice(0, this.maxTextLength) }, mentions: {} }];
    const answer = await this.command(`/_send ${chatId} json ${JSON.stringify(messages)}`);
    if (answer?.type === "chatCmdError") throw new Error("simplex-chat would not send it");
    const items = Array.isArray(answer?.chatItems) ? answer.chatItems : [];
    const first = chatItemSchema.safeParse(items[0]);
    return first.success ? String(first.data.chatItem.meta.itemId) : undefined;
  }
}

/** True when the address points at this computer. */
export function isLoopback(address: string): boolean {
  try { return LOOPBACK.has(new URL(address).hostname); } catch { return false; }
}

export const simplexService = defineService({
  kind: "simplex", name: "SimpleX Chat", docs: "https://github.com/simplex-chat/simplex-chat/tree/stable/bots",
  needs: ["The simplex-chat program running on this computer with its API on, for example: simplex-chat -p 5225",
    "A SimpleX profile for the assistant, set up in that program"],
  receives: "socket",
  settings: z.object({
    address: z.string().regex(/^wss?:\/\/[^\s]+$/).default("ws://127.0.0.1:5225"),
    /** The API has no password: only allow another computer's address on a network you trust. */
    allowRemote: z.boolean().default(false),
    displayName: z.string().min(1).max(64).optional(),
  }).strict(),
  async build(settings, deps) {
    if (!settings.allowRemote && !isLoopback(settings.address))
      throw new Error("SimpleX's API has no password, so Branch only connects to it on this computer. Set allowRemote to use another address");
    await deps.assertAllowed(new URL(settings.address.replace(/^ws/, "http")), "SimpleX Chat program");
    return new SimplexChannel({ id: deps.id, address: settings.address, connect: deps.connectWs,
      ...(settings.displayName ? { displayName: settings.displayName } : {}) });
  },
});
