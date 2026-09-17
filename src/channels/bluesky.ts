import { z } from "zod";
import type { ChannelHealth, InboundMessage } from "./router.js";
import { defineService, PollingChannel, secretName } from "./parity-common.js";

/**
 * Bluesky direct messages, through the official chat service. Branch signs in with the account's
 * handle and an app password (one allowed to reach direct messages), then reads the chat log and
 * answers in the same conversation. The chat calls go to the account's own server, which passes
 * them on to Bluesky's chat service because of the `atproto-proxy` header.
 * API: https://docs.bsky.app/docs/api/chat-bsky-convo-get-log and
 * https://docs.bsky.app/docs/api/com-atproto-server-create-session.
 */
const chatProxy = "did:web:api.bsky.chat#bsky_chat";
const Session = z.object({ accessJwt: z.string().min(1), refreshJwt: z.string().min(1), did: z.string().min(1), handle: z.string().optional() }).passthrough();
const Failure = z.object({ error: z.string().regex(/^[A-Za-z]{1,40}$/) }).passthrough();
const LogEntry = z.object({
  $type: z.string(), convoId: z.string().optional(),
  message: z.object({ id: z.string(), text: z.string().optional(), sender: z.object({ did: z.string() }).passthrough() }).passthrough().optional(),
}).passthrough();
const Log = z.object({ cursor: z.string().optional(), logs: z.array(LogEntry) }).passthrough();

type Auth = "access" | "refresh" | "none";
interface Call { method: "GET" | "POST"; query?: Record<string, string>; json?: unknown; auth: Auth; chat?: boolean }

export interface BlueskyOptions {
  id: string; handle: string; password: string; service?: string; passwordName?: string; pollMs?: number; fetch?: typeof fetch;
}

export class BlueskyChannel extends PollingChannel {
  readonly kind = "bluesky";
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private session: z.infer<typeof Session> | null = null;
  private cursor: string | null = null;
  private refused: string | null = null;
  constructor(private readonly options: BlueskyOptions) {
    super(options.id, options.pollMs ?? 10000);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.base = (options.service ?? "https://bsky.social").replace(/\/+$/, "");
    this.maxTextLength = 1000;
  }
  botName(): string | null { return this.options.handle; }
  override health(): ChannelHealth {
    return this.refused && this.state.state !== "connected" ? { state: "needs attention", reason: this.refused } : this.state;
  }
  /** One XRPC call. The body of a refusal is read for its error name only, never repeated whole. */
  private async raw(nsid: string, call: Call): Promise<{ status: number; body: unknown }> {
    const query = call.query ? `?${new URLSearchParams(call.query).toString()}` : "";
    const token = call.auth === "access" ? this.session?.accessJwt : call.auth === "refresh" ? this.session?.refreshJwt : undefined;
    const response = await this.fetchImpl(`${this.base}/xrpc/${nsid}${query}`, {
      method: call.method, redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { accept: "application/json", ...(call.json !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(call.chat ? { "atproto-proxy": chatProxy } : {}) },
      ...(call.json !== undefined ? { body: JSON.stringify(call.json) } : {}),
    });
    const text = await response.text();
    let body: unknown = {};
    try { body = text ? JSON.parse(text) as unknown : {}; } catch { body = {}; }
    return { status: response.status, body };
  }
  private async xrpc(nsid: string, call: Call): Promise<unknown> {
    let answer = await this.raw(nsid, call);
    if (call.auth === "access" && this.expired(answer)) {
      await this.renew();
      answer = await this.raw(nsid, call);
    }
    if (answer.status >= 200 && answer.status < 300) return answer.body;
    const failure = Failure.safeParse(answer.body);
    throw new Error(`Bluesky refused the request (${answer.status}${failure.success ? ` ${failure.data.error}` : ""})`);
  }
  private expired(answer: { status: number; body: unknown }): boolean {
    const failure = Failure.safeParse(answer.body);
    return (answer.status === 400 || answer.status === 401) && failure.success && failure.data.error === "ExpiredToken";
  }
  /** A spent access token is swapped with the refresh token; if that is spent too, sign in again. */
  private async renew(): Promise<void> {
    const answer = await this.raw("com.atproto.server.refreshSession", { method: "POST", auth: "refresh" });
    if (answer.status === 200) this.session = Session.parse(answer.body);
    else await this.signIn();
  }
  private async signIn(): Promise<void> {
    const answer = await this.raw("com.atproto.server.createSession", {
      method: "POST", auth: "none", json: { identifier: this.options.handle, password: this.options.password },
    });
    if (answer.status === 401 || answer.status === 403) {
      this.refused = `Bluesky refused the handle or app password. Make a new app password that may reach direct messages and save it as ${this.options.passwordName ?? "BLUESKY_APP_PASSWORD"}`;
      throw new Error("Bluesky refused the sign-in");
    }
    if (answer.status !== 200) throw new Error(`Bluesky refused the request (${answer.status})`);
    this.session = Session.parse(answer.body);
  }
  protected override async prepare(): Promise<void> { await this.signIn(); }
  protected async poll(first: boolean): Promise<InboundMessage[]> {
    if (!this.session) await this.signIn();
    const log = Log.parse(await this.xrpc("chat.bsky.convo.getLog", {
      method: "GET", auth: "access", chat: true, ...(this.cursor ? { query: { cursor: this.cursor } } : {}),
    }));
    this.refused = null;
    if (log.cursor) this.cursor = log.cursor;
    if (first) return [];
    return log.logs.flatMap((entry) => {
      const inbound = this.inbound(entry);
      return inbound ? [inbound] : [];
    });
  }
  private inbound(entry: z.infer<typeof LogEntry>): InboundMessage | null {
    const message = entry.message;
    if (entry.$type !== "chat.bsky.convo.defs#logCreateMessage" || !message || !entry.convoId) return null;
    if (message.sender.did === this.session?.did || !message.text?.trim()) return null;
    return {
      channel: this.id, chatId: this.ids.short(entry.convoId, "convo"), chatKind: "direct",
      senderId: this.ids.short(message.sender.did, "did"), senderName: message.sender.did,
      text: message.text, addressed: true, messageId: this.ids.short(message.id, "msg"),
    };
  }
  async send(chatId: string, text: string): Promise<string | undefined> {
    if (!this.session) await this.signIn();
    const answer = await this.xrpc("chat.bsky.convo.sendMessage", {
      method: "POST", auth: "access", chat: true,
      json: { convoId: this.ids.long(chatId), message: { text: text.slice(0, this.maxTextLength) } },
    });
    const sent = z.object({ id: z.string() }).passthrough().safeParse(answer);
    return sent.success ? this.ids.short(sent.data.id, "msg") : undefined;
  }
}

export const blueskyService = defineService({
  kind: "bluesky", name: "Bluesky", docs: "https://docs.bsky.app/docs/api/chat-bsky-convo-get-log",
  needs: ["The assistant account's Bluesky handle",
    "An app password for that account that is allowed to reach direct messages (Settings, Privacy and security, App passwords), saved as a secret"],
  receives: "polls",
  settings: z.object({
    handle: z.string().min(3).max(253),
    appPasswordSecret: z.string().regex(secretName).default("BLUESKY_APP_PASSWORD"),
    service: z.string().url().default("https://bsky.social"),
    pollSeconds: z.number().int().min(3).max(3600).default(10),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.service), "Bluesky server");
    return new BlueskyChannel({ id: deps.id, handle: settings.handle, password: await deps.secret(settings.appPasswordSecret),
      service: settings.service, passwordName: settings.appPasswordSecret, pollMs: settings.pollSeconds * 1000, fetch: deps.fetch });
  },
});
