import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, FreshPosts, secretName, ShortIds } from "./parity-common.js";
import type { SignedQueryChannel } from "./signed-query.js";
import { decryptWechat, signatureMatches, xmlFields } from "./wechat-crypto.js";

/**
 * mac6/bucket-16: WeChat through the two official ways a program may take part in it.
 *
 * - **WeChat Official Account** (`wechat-mp`, 微信公众号): people write to the account; WeChat posts
 *   each message to this computer and Branch answers with the customer-service message API, which
 *   WeChat allows for 48 hours after the person last wrote.
 *   https://developers.weixin.qq.com/doc/offiaccount/en/Message_Management/Receiving_standard_messages.html
 * - **WeCom app** (`wecom-app`, 企业微信自建应用): colleagues write to a company's own app; WeCom posts
 *   each message and Branch answers with the app message API.
 *   https://developer.work.weixin.qq.com/document/path/90238
 *
 * Only "safe mode" is accepted: every post is encrypted and signed over its contents, so a post
 * copied off the wire cannot be given new words. Plain-text mode signs only the time and a random
 * word, not the message, so it is refused. Personal WeChat accounts (iLink, web or pad protocols)
 * are not supported: they are not an official API.
 */
interface WechatFlavour {
  kind: "wechat-mp" | "wecom-app";
  name: string;
  /** The app id (Official Account) or company id (WeCom) the messages are encrypted for. */
  receiveId: string;
  /** Asks the service for an access token. */
  token(): Promise<{ value: string; seconds: number }>;
  /** Sends one text; resolves to the service's error number (0 is success). */
  deliver(accessToken: string, to: string, text: string): Promise<number>;
  /** Tells a genuine message from anything else in the decrypted fields. */
  accept(fields: Record<string, string>): boolean;
  /** What the service expects back once a post has been taken in. */
  ok: string;
}
export interface WechatOptions {
  id: string;
  token: string;
  encodingAesKey: string;
  fetch?: typeof fetch;
  /** Saved secret names, for the health line. */
  names?: string;
}

const expired = new Set([40001, 40014, 42001]);
const refusedCodes = new Set([40001, 40013, 40125, 40164, 40091, 60020, 40056, 41004]);
const replyWindow = new Set([45015, 45047]);
const answerSchema = z.object({ errcode: z.number().optional(), errmsg: z.string().optional() }).passthrough();
const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number() }).passthrough();

export class WechatChannel implements ChannelAdapter, SignedQueryChannel {
  readonly id: string;
  readonly kind: string;
  /** WeChat caps a text at 2048 bytes; Chinese takes three bytes a character. */
  readonly maxTextLength = 600;
  private readonly fresh = new FreshPosts();
  private readonly taken = new Map<string, number>();
  private readonly ids = new ShortIds();
  private access: { value: string; until: number } | null = null;
  private refused: string | null = null;
  private deliverTo: ((message: InboundMessage) => Promise<void>) | null = null;
  constructor(private readonly flavour: WechatFlavour, private readonly options: WechatOptions) {
    this.id = options.id;
    this.kind = flavour.kind;
  }
  botName(): string | null { return null; }
  health(): ChannelHealth {
    if (this.refused) return { state: "needs attention", reason: this.refused };
    return { state: "connected", reason: `Waiting for ${this.flavour.name} to post messages to this computer` };
  }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> { this.deliverTo = onMessage; }
  async stop(): Promise<void> { this.deliverTo = null; }
  async receiveSigned(method: string, query: URLSearchParams, raw: Buffer): Promise<string> {
    const read = (name: string) => query.get(name) ?? "";
    const [timestamp, nonce] = [read("timestamp"), read("nonce")];
    if (method === "GET") return this.verifyAddress(read, timestamp, nonce);
    if (method !== "POST") throw new Error(`${this.flavour.name} only posts messages`);
    if (this.kind === "wechat-mp" && read("encrypt_type") !== "aes")
      throw new Error("Only WeChat's safe mode is accepted; switch the server settings to safe mode (安全模式)");
    const encrypted = xmlFields(raw.toString("utf8")).Encrypt ?? "";
    const signature = read("msg_signature");
    if (!encrypted || !signatureMatches(signature, [this.options.token, timestamp, nonce, encrypted]))
      throw new Error(`The ${this.flavour.name} post is not signed with the saved token`);
    // A copy of a post already taken in is acknowledged and not read again; an old one is refused.
    try { this.fresh.admit(timestamp, `${signature}:${nonce}`, this.flavour.name); }
    catch (error) { if (/already taken in/.test(String(error))) return this.flavour.ok; throw error; }
    const fields = xmlFields(decryptWechat(this.options.encodingAesKey, encrypted, this.flavour.receiveId));
    const inbound = this.inbound(fields);
    if (inbound && this.deliverTo) void this.deliverTo(inbound).catch(() => undefined);
    return this.flavour.ok;
  }
  /** The one-off check both services make when the address is saved in their settings. */
  private verifyAddress(read: (name: string) => string, timestamp: string, nonce: string): string {
    const echo = read("echostr");
    if (!echo) throw new Error(`The ${this.flavour.name} address check carries nothing to echo`);
    if (this.kind === "wechat-mp") {
      if (!signatureMatches(read("signature"), [this.options.token, timestamp, nonce]))
        throw new Error("The WeChat address check is not signed with the saved token");
      return echo;
    }
    if (!signatureMatches(read("msg_signature"), [this.options.token, timestamp, nonce, echo]))
      throw new Error("The WeCom address check is not signed with the saved token");
    return decryptWechat(this.options.encodingAesKey, echo, this.flavour.receiveId);
  }
  private inbound(fields: Record<string, string>): InboundMessage | null {
    if (!this.flavour.accept(fields) || fields.MsgType !== "text") return null;
    const from = fields.FromUserName ?? "", text = (fields.Content ?? "").trim();
    const messageId = fields.MsgId ?? `${from}:${fields.CreateTime ?? ""}`;
    if (!from || !text || !this.firstTime(messageId)) return null;
    const chatId = this.ids.short(from, "user");
    return {
      channel: this.id, chatId, chatKind: "direct", senderId: chatId, senderName: from,
      text, addressed: true, messageId: this.ids.short(messageId, "msg"),
    };
  }
  /** WeChat posts a message again when the answer is slow; each one is taken in once. */
  private firstTime(messageId: string): boolean {
    const now = Date.now();
    for (const [key, until] of this.taken) if (until <= now) this.taken.delete(key);
    if (this.taken.has(messageId)) return false;
    this.taken.set(messageId, now + 10 * 60_000);
    if (this.taken.size > 5000) this.taken.delete(this.taken.keys().next().value!);
    return true;
  }
  private async accessToken(fresh = false): Promise<string> {
    if (!fresh && this.access && Date.now() < this.access.until) return this.access.value;
    const token = await this.flavour.token().catch((error: unknown) => {
      const code = Number(/\((\d+)\)/.exec(String(error))?.[1] ?? 0);
      if (refusedCodes.has(code)) this.refused = `${this.flavour.name} refused the saved app secret or this computer's address (${code}). Check ${this.options.names ?? "the saved secrets"} and the trusted IP list`;
      throw error;
    });
    this.refused = null;
    this.access = { value: token.value, until: Date.now() + Math.max(0, token.seconds - 300) * 1000 };
    return token.value;
  }
  async send(chatId: string, text: string): Promise<string | undefined> {
    const to = this.ids.long(chatId);
    let code = await this.flavour.deliver(await this.accessToken(), to, text.slice(0, this.maxTextLength));
    if (expired.has(code)) code = await this.flavour.deliver(await this.accessToken(true), to, text.slice(0, this.maxTextLength));
    if (replyWindow.has(code)) throw new Error(`Outside ${this.flavour.name}'s reply window: the person has to write again first`);
    if (code !== 0) throw new Error(`${this.flavour.name} refused the message (${code})`);
    return undefined;
  }
}

/** One call to a WeChat or WeCom API; an error number in the answer becomes an error. */
async function wechatCall(fetchImpl: typeof fetch, name: string, url: string, init: Parameters<typeof callJson>[3] = {}): Promise<unknown> {
  const answer = answerSchema.parse(await callJson(fetchImpl, name, url, init));
  if (answer.errcode) throw new Error(`${name} refused the request (${answer.errcode})`);
  return answer;
}
async function sendCode(fetchImpl: typeof fetch, name: string, url: string, json: unknown): Promise<number> {
  const answer = answerSchema.parse(await callJson(fetchImpl, name, url, { method: "POST", json }));
  return answer.errcode ?? 0;
}

const aesKeySecret = (fallback: string) => z.string().regex(secretName).default(fallback);

export const wechatOfficialService = defineService({
  kind: "wechat-mp", name: "WeChat Official Account",
  docs: "https://developers.weixin.qq.com/doc/offiaccount/en/Basic_Information/Access_Overview.html",
  needs: ["A verified WeChat Official Account (the customer-service message API needs verification)",
    "Its AppID, and its AppSecret saved as a secret",
    "Server settings in safe mode: the address shown under Connections, a Token and an EncodingAESKey, both saved as secrets",
    "This computer's public address on the account's IP allowlist"],
  receives: "posted",
  settings: z.object({
    appId: z.string().regex(/^wx[a-z0-9]{14,18}$/),
    appSecretSecret: z.string().regex(secretName).default("WECHAT_MP_APP_SECRET"),
    tokenSecret: z.string().regex(secretName).default("WECHAT_MP_TOKEN"),
    encodingAesKeySecret: aesKeySecret("WECHAT_MP_AES_KEY"),
    apiBase: z.string().url().regex(/^https?:\/\//).default("https://api.weixin.qq.com"),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.apiBase), "WeChat API");
    const base = settings.apiBase.replace(/\/$/, "");
    const appSecret = await deps.secret(settings.appSecretSecret);
    return new WechatChannel({
      kind: "wechat-mp", name: "WeChat", receiveId: settings.appId, ok: "success",
      token: async () => {
        const json = { grant_type: "client_credential", appid: settings.appId, secret: appSecret };
        const answer = tokenSchema.parse(await wechatCall(deps.fetch, "WeChat", `${base}/cgi-bin/stable_token`, { method: "POST", json }));
        return { value: answer.access_token, seconds: answer.expires_in };
      },
      deliver: (token, to, content) => sendCode(deps.fetch, "WeChat", `${base}/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`,
        { touser: to, msgtype: "text", text: { content } }),
      accept: (fields) => /^[\w-]{6,64}$/.test(fields.FromUserName ?? ""),
    }, {
      id: deps.id, token: await deps.secret(settings.tokenSecret), encodingAesKey: await deps.secret(settings.encodingAesKeySecret),
      fetch: deps.fetch, names: `${settings.appSecretSecret}`,
    });
  },
});

export const wecomAppService = defineService({
  kind: "wecom-app", name: "WeCom app", docs: "https://developer.work.weixin.qq.com/document/path/90238",
  needs: ["A self-built app in your WeCom admin console, with its AgentId, and its Secret saved as a secret",
    "Your company's CorpID",
    "Receive messages turned on with the address shown under Connections, a Token and an EncodingAESKey, both saved as secrets",
    "This computer's public address on the app's trusted IP list"],
  receives: "posted",
  settings: z.object({
    corpId: z.string().regex(/^w[a-zA-Z0-9]{9,30}$/),
    agentId: z.number().int().min(1).max(1e10),
    corpSecretSecret: z.string().regex(secretName).default("WECOM_APP_SECRET"),
    tokenSecret: z.string().regex(secretName).default("WECOM_APP_TOKEN"),
    encodingAesKeySecret: aesKeySecret("WECOM_APP_AES_KEY"),
    apiBase: z.string().url().regex(/^https?:\/\//).default("https://qyapi.weixin.qq.com"),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.apiBase), "WeCom API");
    const base = settings.apiBase.replace(/\/$/, "");
    const corpSecret = await deps.secret(settings.corpSecretSecret);
    return new WechatChannel({
      kind: "wecom-app", name: "WeCom", receiveId: settings.corpId, ok: "",
      token: async () => {
        // WeCom only takes the secret in the address; callJson never repeats an address in an error.
        const query = new URLSearchParams({ corpid: settings.corpId, corpsecret: corpSecret });
        const answer = tokenSchema.parse(await wechatCall(deps.fetch, "WeCom", `${base}/cgi-bin/gettoken?${query}`));
        return { value: answer.access_token, seconds: answer.expires_in };
      },
      deliver: (token, to, content) => sendCode(deps.fetch, "WeCom", `${base}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
        { touser: to, msgtype: "text", agentid: settings.agentId, text: { content } }),
      accept: (fields) => fields.ToUserName === settings.corpId && fields.AgentID === String(settings.agentId),
    }, {
      id: deps.id, token: await deps.secret(settings.tokenSecret), encodingAesKey: await deps.secret(settings.encodingAesKeySecret),
      fetch: deps.fetch, names: `${settings.corpSecretSecret}`,
    });
  },
});
