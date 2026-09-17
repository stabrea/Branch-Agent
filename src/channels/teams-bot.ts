import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, headerOf, secretName, ShortIds } from "./parity-common.js";
import type { PostedChannel } from "./parity-switch.js";
import { SeenMessages } from "./seen.js";

/**
 * Microsoft Teams as a proper Bot Framework bot (the older "msteams" entry is an outgoing webhook
 * and cannot hold one-to-one chats). Written from Microsoft's Bot Connector documentation:
 * https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
 *
 * Every post from Teams carries `Authorization: Bearer <token>`, an RS256 JSON Web Token. It is
 * checked here with Microsoft's published keys (the OpenID document names where they are; they are
 * fetched once, and again only when a token names a key not seen yet): the signature, the issuer
 * `https://api.botframework.com`, the audience (this bot's app id), the time window with five
 * minutes' leeway, and that the token's `serviceUrl` is the one in the activity. The service
 * address must also be one of Microsoft's own hosts, so a forged post can never make Branch send
 * the bot's credentials anywhere else. Only then is the activity read.
 *
 * Replies are sent to `{serviceUrl}/v3/conversations/{id}/activities[/{replyToId}]` with a token
 * from Microsoft's sign-in service, obtained with the app id and password and kept until it expires.
 */
export interface TeamsBotOptions {
  id: string;
  appId: string;
  appPassword: string;
  tenant: string;
  openIdUrl: string;
  loginBase: string;
  /** Service hosts to accept besides Microsoft's own, as the owner wrote them. */
  allowServiceHosts: string[];
  appPasswordName?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const issuer = "https://api.botframework.com";
const microsoftHosts = [/\.botframework\.com$/, /^smba\.trafficmanager\.net$/, /\.trafficmanager\.net$/, /\.botframework\.us$/, /\.teams\.microsoft\.com$/];
const skewSeconds = 300;
/** A token naming an unknown key may make Branch fetch the keys again at most this often. */
const refetchFloorMs = 60_000;

const JwkSchema = z.object({ kid: z.string(), kty: z.literal("RSA"), n: z.string(), e: z.string(), endorsements: z.array(z.string()).optional() }).passthrough();
const ClaimsSchema = z.object({
  iss: z.string(), aud: z.string(), exp: z.number(), nbf: z.number().optional(), serviceUrl: z.string().optional(),
}).passthrough();
const ActivitySchema = z.object({
  type: z.string(),
  id: z.string().default(""),
  serviceUrl: z.string().url(),
  channelId: z.string().default(""),
  from: z.object({ id: z.string().min(1), name: z.string().optional(), aadObjectId: z.string().optional() }).passthrough(),
  recipient: z.object({ id: z.string().min(1), name: z.string().optional() }).passthrough(),
  conversation: z.object({ id: z.string().min(1), conversationType: z.string().optional(), isGroup: z.boolean().optional() }).passthrough(),
  text: z.string().default(""),
  entities: z.array(z.object({ type: z.string(), text: z.string().optional(), mentioned: z.object({ id: z.string() }).passthrough().optional() }).passthrough()).default([]),
}).passthrough();
type Activity = z.infer<typeof ActivitySchema>;

const part = (value: string): unknown => { try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown; } catch { return undefined; } };

/** True when a service address is Microsoft's own, or a host the owner named. */
export function allowedServiceUrl(address: string, extra: readonly string[]): boolean {
  let url: URL;
  try { url = new URL(address); } catch { return false; }
  const host = url.hostname.toLowerCase();
  if (extra.map((h) => h.toLowerCase()).includes(host)) return url.protocol === "https:" || url.protocol === "http:";
  return url.protocol === "https:" && microsoftHosts.some((pattern) => pattern.test(host));
}

export class TeamsBotChannel implements ChannelAdapter, PostedChannel {
  readonly kind = "msteams-bot";
  readonly id: string;
  readonly maxTextLength = 3500;
  private state: ChannelHealth = { state: "connected", reason: "Waiting for Teams to post a message" };
  private deliver: ((message: InboundMessage) => Promise<void>) | null = null;
  private keys = new Map<string, { key: KeyObject; endorsements?: string[] | undefined }>();
  private keysFetchedAt = 0;
  private token: { value: string; until: number } | null = null;
  private botLabel: string | null = null;
  /** Where each conversation's replies go, as Teams told us with its last message. */
  private readonly serviceUrls = new Map<string, string>();
  private readonly ids = new ShortIds();
  private readonly seen = new SeenMessages();
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: TeamsBotOptions) {
    this.id = options.id;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  botName(): string | null { return this.botLabel; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> { this.deliver = onMessage; }
  async stop(): Promise<void> { this.deliver = null; }

  async receivePost(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ accepted: number }> {
    const verified = await this.verifyToken(headerOf(headers, "authorization"));
    // Only now, with the token proved, is the activity read.
    const activity = ActivitySchema.safeParse(readJson(raw));
    if (!activity.success) throw new Error("The Teams activity could not be read");
    const a = activity.data;
    if (verified.claims.serviceUrl !== a.serviceUrl) throw new Error("The Teams token was made for a different service address");
    if (verified.endorsements && a.channelId && !verified.endorsements.includes(a.channelId))
      throw new Error("The Teams signing key is not endorsed for this channel");
    if (!allowedServiceUrl(a.serviceUrl, this.options.allowServiceHosts))
      throw new Error("The Teams activity named a service address that is not Microsoft's");
    if (a.type !== "message" || a.from.id === a.recipient.id || !this.deliver) return { accepted: 0 };
    const message = this.inbound(a);
    if (!message) return { accepted: 0 };
    void this.deliver(message).catch(() => undefined);
    return { accepted: 1 };
  }

  /** Checks the Bot Framework token and returns its claims and the key's endorsements. */
  private async verifyToken(authorization: string): Promise<{ claims: z.infer<typeof ClaimsSchema>; endorsements?: string[] | undefined }> {
    const token = /^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/i.exec(authorization.trim())?.[1];
    if (!token) throw new Error("The post carried no Teams token");
    const [head, body, signature] = token.split(".") as [string, string, string];
    const header = z.object({ alg: z.literal("RS256"), kid: z.string().min(1) }).passthrough().safeParse(part(head));
    if (!header.success) throw new Error("The Teams token uses an unexpected signing method");
    const key = await this.key(header.data.kid);
    if (!verify("RSA-SHA256", Buffer.from(`${head}.${body}`), key.key, Buffer.from(signature, "base64url")))
      throw new Error("The Teams token's signature did not match Microsoft's key");
    const claims = ClaimsSchema.safeParse(part(body));
    if (!claims.success) throw new Error("The Teams token is missing what it should say");
    const now = Math.floor(this.now() / 1000);
    if (claims.data.iss !== issuer) throw new Error("The Teams token was not issued by the Bot Framework");
    if (claims.data.aud !== this.options.appId) throw new Error("The Teams token was made for a different bot");
    if (claims.data.exp + skewSeconds < now) throw new Error("The Teams token has expired");
    if (claims.data.nbf !== undefined && claims.data.nbf - skewSeconds > now) throw new Error("The Teams token is not valid yet");
    return { claims: claims.data, endorsements: key.endorsements };
  }

  /** Microsoft's signing key by id, fetching the published list when the id is new. */
  private async key(kid: string): Promise<{ key: KeyObject; endorsements?: string[] | undefined }> {
    const known = this.keys.get(kid);
    if (known) return known;
    if (this.keysFetchedAt && this.now() - this.keysFetchedAt < refetchFloorMs) throw new Error("The Teams token names a signing key Microsoft has not published");
    this.keysFetchedAt = this.now();
    const openId = z.object({ jwks_uri: z.string().url() }).passthrough().parse(await callJson(this.fetchImpl, "Microsoft", this.options.openIdUrl));
    // The key list must live where the OpenID document itself does.
    if (new URL(openId.jwks_uri).host !== new URL(this.options.openIdUrl).host) throw new Error("Microsoft's key list is somewhere unexpected");
    const list = z.object({ keys: z.array(z.unknown()) }).passthrough().parse(await callJson(this.fetchImpl, "Microsoft", openId.jwks_uri));
    const keys = new Map<string, { key: KeyObject; endorsements?: string[] | undefined }>();
    for (const entry of list.keys) {
      const jwk = JwkSchema.safeParse(entry);
      if (!jwk.success) continue;
      try {
        keys.set(jwk.data.kid, { key: createPublicKey({ key: { kty: "RSA", n: jwk.data.n, e: jwk.data.e }, format: "jwk" }), endorsements: jwk.data.endorsements });
      } catch { /* a key Node cannot read is skipped */ }
    }
    this.keys = keys;
    const found = keys.get(kid);
    if (!found) throw new Error("The Teams token names a signing key Microsoft has not published");
    return found;
  }

  private inbound(a: Activity): InboundMessage | null {
    const group = a.conversation.conversationType ? a.conversation.conversationType !== "personal" : !!a.conversation.isGroup;
    const mentions = a.entities.filter((e) => e.type === "mention" && e.mentioned?.id === a.recipient.id);
    let text = a.text;
    for (const mention of mentions) if (mention.text) text = text.split(mention.text).join(" ");
    text = text.replace(/<at>(.*?)<\/at>/g, "$1").replace(/\s+/g, " ").trim();
    if (!text) return null;
    if (a.recipient.name) this.botLabel = a.recipient.name;
    this.serviceUrls.set(a.conversation.id, a.serviceUrl);
    if (this.serviceUrls.size > 1000) this.serviceUrls.delete(this.serviceUrls.keys().next().value!);
    const chatId = this.ids.short(a.conversation.id, "chat");
    const senderId = this.ids.short(a.from.aadObjectId ?? a.from.id, "who");
    const messageId = this.ids.short(a.id || `${this.now()}`, "msg");
    if (!this.seen.first(SeenMessages.key(messageId, senderId, chatId, text))) return null;
    return {
      channel: this.id, chatId, chatKind: group ? "group" : "direct", senderId, senderName: a.from.name ?? a.from.id,
      text, addressed: !group || mentions.length > 0, messageId,
    };
  }

  /** A sign-in token for the Bot Connector, kept until shortly before it runs out. */
  private async connectorToken(): Promise<string> {
    if (this.token && this.token.until > this.now()) return this.token.value;
    const url = `${this.options.loginBase.replace(/\/$/, "")}/${encodeURIComponent(this.options.tenant)}/oauth2/v2.0/token`;
    const answer = await callJson(this.fetchImpl, "Microsoft sign-in", url, {
      method: "POST",
      form: { grant_type: "client_credentials", client_id: this.options.appId, client_secret: this.options.appPassword, scope: "https://api.botframework.com/.default" },
    }).catch((error: unknown) => {
      if (/\((400|401|403)\)/.test(String(error)))
        this.state = { state: "needs attention", reason: `Microsoft refused the app id and password. Check the app id, and save a new password as ${this.options.appPasswordName ?? "MSTEAMS_APP_PASSWORD"}` };
      throw error;
    });
    const token = z.object({ access_token: z.string().min(1), expires_in: z.coerce.number().default(3600) }).passthrough().parse(answer);
    this.token = { value: token.access_token, until: this.now() + Math.max(60, token.expires_in - 300) * 1000 };
    return token.access_token;
  }

  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    const conversation = this.ids.long(chatId);
    const serviceUrl = this.serviceUrls.get(conversation);
    if (!serviceUrl) throw new Error("Teams has not said where this chat's replies go yet; it will once somebody there writes");
    if (!allowedServiceUrl(serviceUrl, this.options.allowServiceHosts)) throw new Error("That Teams service address is not Microsoft's");
    const replyTo = replyToMessageId ? this.ids.long(replyToMessageId) : undefined;
    const url = `${serviceUrl.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(conversation)}/activities${replyTo ? `/${encodeURIComponent(replyTo)}` : ""}`;
    const bearer = await this.connectorToken();
    try {
      const answer = await callJson(this.fetchImpl, "Teams", url, {
        method: "POST", headers: { authorization: `Bearer ${bearer}` },
        json: { type: "message", text: text.slice(0, this.maxTextLength), ...(replyTo ? { replyToId: replyTo } : {}) },
      });
      this.state = { state: "connected" };
      const sent = z.object({ id: z.string() }).passthrough().safeParse(answer);
      return sent.success ? this.ids.short(sent.data.id, "msg") : undefined;
    } catch (error) {
      if (/\((401|403)\)/.test(String(error))) this.token = null;
      throw error;
    }
  }
}

function readJson(raw: Buffer): unknown {
  try { return JSON.parse(raw.toString("utf8")) as unknown; } catch { return undefined; }
}

export const teamsBotService = defineService({
  kind: "msteams-bot", name: "Microsoft Teams (bot)",
  docs: "https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication",
  needs: [
    "An Azure Bot registration with the Teams channel turned on, and its messaging endpoint set to the address Branch shows",
    "The bot's Microsoft app id", "A client secret (app password) for that app, saved as a secret",
    "For a single-tenant app, the tenant id",
  ],
  receives: "posted",
  settings: z.object({
    appId: z.string().min(1).max(100),
    appPasswordSecret: z.string().regex(secretName).default("MSTEAMS_APP_PASSWORD"),
    tenant: z.string().regex(/^[A-Za-z0-9.-]{1,100}$/).default("botframework.com"),
    allowServiceHosts: z.array(z.string().regex(/^[A-Za-z0-9.-]{1,253}$/)).max(20).default([]),
    openIdUrl: z.string().url().default("https://login.botframework.com/v1/.well-known/openidconfiguration"),
    loginBase: z.string().url().default("https://login.microsoftonline.com"),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.openIdUrl), "Microsoft key address");
    await deps.assertAllowed(new URL(settings.loginBase), "Microsoft sign-in address");
    return new TeamsBotChannel({
      id: deps.id, appId: settings.appId, tenant: settings.tenant, openIdUrl: settings.openIdUrl,
      loginBase: settings.loginBase, allowServiceHosts: settings.allowServiceHosts, fetch: deps.fetch,
      appPasswordName: settings.appPasswordSecret, appPassword: await deps.secret(settings.appPasswordSecret),
    });
  },
});
