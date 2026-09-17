import { createHash } from "node:crypto";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, headerOf, sameSecret, secretName, ShortIds } from "./parity-common.js";
import type { PostedChannel } from "./parity-switch.js";
import { SeenMessages } from "./seen.js";

/**
 * Zalo, through a Zalo Official Account (OA API v3). Personal Zalo accounts are not supported: they
 * have no official API.
 *
 * Zalo posts each event to this computer's address and signs it in the `X-ZEvent-Signature` header
 * as `mac=<hex>`, where the hex is `sha256(app id + exact body + timestamp + OA secret key)`. That
 * rule is Zalo's own, from its webhook documentation
 * (https://developers.zalo.me/docs/api/official-account-api/webhook/su-kien-nguoi-dung-gui-tin-nhan-post-3720
 * and the Zalo developer community answer "Verify header X-ZEvent-Signature",
 * https://developers.zalo.me/community/detail/d14d09b635f3dcad85e2); OpenClaw's extensions/zalo uses the
 * separate Zalo Bot API and has no OA signing rule. The app id is the one in the settings, not the
 * one in the post. The timestamp only exists inside the body, so it alone is picked out of the raw
 * bytes with a narrow pattern to build the check; the body is not read as JSON until the check has
 * passed.
 *
 * Only `user_send_text` (a person writing to the OA) is answered; `oa_send_text`, the OA's own
 * messages, is not. Replies go to `POST /v3.0/oa/message/cs` with the access token in a header. An
 * access token lasts about a day: when Zalo refuses it as expired, a new one is asked for with the
 * refresh token, and since Zalo hands back a new refresh token each time and Branch cannot rewrite
 * the saved one, the health line then asks the owner to save the new pair.
 */
export interface ZaloOptions {
  id: string;
  appId: string;
  oaSecretKey: string;
  appSecret: string;
  accessToken: string;
  refreshToken: string;
  apiBase: string;
  oauthBase: string;
  names?: { accessToken: string; refreshToken: string };
  fetch?: typeof fetch;
}

const EventSchema = z.object({
  app_id: z.string().optional(),
  event_name: z.string(),
  sender: z.object({ id: z.string().min(1) }).passthrough().optional(),
  message: z.object({ text: z.string().default(""), msg_id: z.string().optional() }).passthrough().optional(),
}).passthrough();
const SendAnswerSchema = z.object({
  error: z.number(), message: z.string().optional(),
  data: z.object({ message_id: z.string().optional() }).passthrough().optional(),
}).passthrough();
const TokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1) }).passthrough();
/** Zalo's error numbers for an access token that is no longer good. */
const expiredToken = new Set([-124, -216]);

function readJson(raw: Buffer): unknown {
  try { return JSON.parse(raw.toString("utf8")) as unknown; } catch { return undefined; }
}

export class ZaloChannel implements ChannelAdapter, PostedChannel {
  readonly kind = "zalo";
  readonly id: string;
  /** Zalo's customer-service message holds at most 2000 characters. */
  readonly maxTextLength = 2000;
  private state: ChannelHealth = { state: "connected", reason: "Waiting for Zalo to post a message" };
  private deliver: ((message: InboundMessage) => Promise<void>) | null = null;
  private accessToken: string;
  private refreshToken: string;
  private readonly ids = new ShortIds();
  private readonly seen = new SeenMessages();
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: ZaloOptions) {
    this.id = options.id;
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
  botName(): string | null { return null; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> { this.deliver = onMessage; }
  async stop(): Promise<void> { this.deliver = null; }

  async receivePost(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ accepted: number }> {
    const signature = headerOf(headers, "x-zevent-signature").replace(/^\s*mac\s*=\s*/i, "").trim().toLowerCase();
    const timestamp = /"timestamp"\s*:\s*"?(\d{1,20})"?/.exec(raw.toString("utf8"))?.[1];
    if (!signature || !timestamp) throw new Error("The post carried no Zalo signature");
    const expected = createHash("sha256")
      .update(this.options.appId).update(raw).update(timestamp).update(this.options.oaSecretKey).digest("hex");
    if (!sameSecret(signature, expected)) throw new Error("The Zalo signature did not match");
    // Only now, with the signature proved, is the post itself read.
    const event = EventSchema.safeParse(readJson(raw));
    if (!event.success || event.data.event_name !== "user_send_text" || !this.deliver) return { accepted: 0 };
    if (event.data.app_id !== undefined && event.data.app_id !== this.options.appId) return { accepted: 0 };
    const message = this.inbound(event.data);
    if (!message) return { accepted: 0 };
    void this.deliver(message).catch(() => undefined);
    return { accepted: 1 };
  }

  private inbound(event: z.infer<typeof EventSchema>): InboundMessage | null {
    const text = event.message?.text.trim() ?? "";
    if (!event.sender || !text) return null;
    const chatId = this.ids.short(event.sender.id, "chat");
    const senderId = this.ids.short(event.sender.id, "who");
    const messageId = this.ids.short(event.message?.msg_id ?? `${Date.now()}`, "msg");
    if (!this.seen.first(SeenMessages.key(messageId, senderId, chatId, text))) return null;
    return { channel: this.id, chatId, chatKind: "direct", senderId, senderName: event.sender.id, text, addressed: true, messageId };
  }

  async send(chatId: string, text: string): Promise<string | undefined> {
    const body = { recipient: { user_id: this.ids.long(chatId) }, message: { text: text.slice(0, this.maxTextLength) } };
    let answer = await this.post(body);
    if (expiredToken.has(answer.error)) {
      await this.renew();
      answer = await this.post(body);
    }
    if (answer.error !== 0) throw new Error(`Zalo refused the message (error ${answer.error})`);
    return answer.data?.message_id ? this.ids.short(answer.data.message_id, "msg") : undefined;
  }

  private async post(body: unknown): Promise<z.infer<typeof SendAnswerSchema>> {
    const answer = await callJson(this.fetchImpl, "Zalo", `${this.options.apiBase.replace(/\/$/, "")}/v3.0/oa/message/cs`, {
      method: "POST", headers: { access_token: this.accessToken }, json: body,
    });
    return SendAnswerSchema.parse(answer);
  }

  /** Asks Zalo for a new access token with the refresh token. */
  private async renew(): Promise<void> {
    const names = this.options.names ?? { accessToken: "ZALO_OA_ACCESS_TOKEN", refreshToken: "ZALO_OA_REFRESH_TOKEN" };
    const answer = await callJson(this.fetchImpl, "Zalo", `${this.options.oauthBase.replace(/\/$/, "")}/v4/oa/access_token`, {
      method: "POST", headers: { secret_key: this.options.appSecret },
      form: { refresh_token: this.refreshToken, app_id: this.options.appId, grant_type: "refresh_token" },
    }).catch(() => undefined);
    const token = TokenSchema.safeParse(answer);
    if (!token.success) {
      this.state = { state: "needs attention", reason: `The Zalo access token has expired and could not be renewed. Make a new pair in the Zalo developer console and save them as ${names.accessToken} and ${names.refreshToken}` };
      throw new Error("Zalo refused the saved access token, and a new one could not be had");
    }
    this.accessToken = token.data.access_token;
    this.refreshToken = token.data.refresh_token;
    this.state = { state: "needs attention", reason: `Branch renewed the Zalo access token, but Zalo has replaced the refresh token and the new one is only kept until Branch restarts. Make a new pair in the Zalo developer console and save them as ${names.accessToken} and ${names.refreshToken}` };
  }
}

export const zaloService = defineService({
  kind: "zalo", name: "Zalo Official Account", docs: "https://developers.zalo.me/docs/api/official-account-api/webhook/su-kien-nguoi-dung-gui-tin-nhan-post-3720",
  needs: [
    "A Zalo Official Account linked to an app at developers.zalo.me, with its webhook set to the address Branch shows",
    "The app id", "The app secret and the OA secret key, saved as secrets",
    "An OA access token and its refresh token, saved as secrets",
  ],
  receives: "posted",
  settings: z.object({
    appId: z.string().regex(/^\d{1,30}$/),
    oaSecretKeySecret: z.string().regex(secretName).default("ZALO_OA_SECRET_KEY"),
    appSecretSecret: z.string().regex(secretName).default("ZALO_APP_SECRET"),
    accessTokenSecret: z.string().regex(secretName).default("ZALO_OA_ACCESS_TOKEN"),
    refreshTokenSecret: z.string().regex(secretName).default("ZALO_OA_REFRESH_TOKEN"),
    apiBase: z.string().url().default("https://openapi.zalo.me"),
    oauthBase: z.string().url().default("https://oauth.zaloapp.com"),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.apiBase), "Zalo address");
    await deps.assertAllowed(new URL(settings.oauthBase), "Zalo sign-in address");
    return new ZaloChannel({
      id: deps.id, appId: settings.appId, apiBase: settings.apiBase, oauthBase: settings.oauthBase, fetch: deps.fetch,
      names: { accessToken: settings.accessTokenSecret, refreshToken: settings.refreshTokenSecret },
      oaSecretKey: await deps.secret(settings.oaSecretKeySecret),
      appSecret: await deps.secret(settings.appSecretSecret),
      accessToken: await deps.secret(settings.accessTokenSecret),
      refreshToken: await deps.secret(settings.refreshTokenSecret),
    });
  },
});
