import { z } from "zod";
import type { ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, PollingChannel, secretName } from "./parity-common.js";

/**
 * Reddit, through its official API with a "script" app made on the assistant's own account.
 * Branch reads the account's unread inbox: private messages are direct chats, and username
 * mentions and replies to the assistant's comments are group chats in their thread. Every answer is
 * a reply to the exact message or comment being answered.
 * API: https://www.reddit.com/dev/api/ and https://github.com/reddit-archive/reddit/wiki/OAuth2.
 */
const Token = z.object({ access_token: z.string().min(1).optional(), expires_in: z.number().optional(), error: z.string().optional() }).passthrough();
const Item = z.object({
  kind: z.string(),
  data: z.object({
    name: z.string(), author: z.string().nullish(), author_fullname: z.string().nullish(), body: z.string().nullish(),
    subject: z.string().nullish(), subreddit: z.string().nullish(),
  }).passthrough(),
}).passthrough();
const Listing = z.object({ data: z.object({ children: z.array(Item) }).passthrough() }).passthrough();
const Posted = z.object({
  json: z.object({
    errors: z.array(z.array(z.unknown())).default([]),
    data: z.object({ things: z.array(z.object({ data: z.object({ name: z.string() }).passthrough() }).passthrough()) }).partial().optional(),
  }).passthrough(),
}).passthrough();

export interface RedditOptions {
  id: string; clientId: string; clientSecret: string; username: string; password: string; userAgent: string;
  authBase?: string; apiBase?: string; secretNames?: { client: string; password: string }; pollMs?: number; fetch?: typeof fetch;
}

export class RedditChannel extends PollingChannel {
  readonly kind = "reddit";
  private readonly fetchImpl: typeof fetch;
  private token: { value: string; until: number } | null = null;
  private refused: string | null = null;
  /** Inbox items already looked at: the ones there at the start, and the ones handed over. */
  private readonly seen = new Set<string>();
  /** The last message or comment each chat asked, so later pieces of an answer reply to it too. */
  private readonly targets = new Map<string, string>();
  constructor(private readonly options: RedditOptions) {
    super(options.id, options.pollMs ?? 30000);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxTextLength = 3500;
  }
  botName(): string | null { return this.options.username; }
  override health(): ChannelHealth {
    return this.refused && this.state.state !== "connected" ? { state: "needs attention", reason: this.refused } : this.state;
  }
  private base(which: "auth" | "api"): string {
    const chosen = which === "auth" ? this.options.authBase ?? "https://www.reddit.com" : this.options.apiBase ?? "https://oauth.reddit.com";
    return chosen.replace(/\/+$/, "");
  }
  /** The password grant a script app uses. Reddit answers a wrong password with 200 and an error. */
  private async signIn(): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value;
    const names = this.options.secretNames ?? { client: "REDDIT_CLIENT_SECRET", password: "REDDIT_PASSWORD" };
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64");
    const answer = await callJson(this.fetchImpl, "Reddit", `${this.base("auth")}/api/v1/access_token`, {
      method: "POST", headers: { authorization: `Basic ${basic}`, "user-agent": this.options.userAgent },
      form: { grant_type: "password", username: this.options.username, password: this.options.password },
    }).catch((error: unknown) => {
      if (/\((400|401|403)\)$/.test(error instanceof Error ? error.message : ""))
        this.refused = `Reddit refused the app's client id or secret. Check the script app and save its secret as ${names.client}`;
      throw error;
    });
    const token = Token.parse(answer);
    if (!token.access_token) {
      this.refused = `Reddit refused the account's username or password. Save the password as ${names.password}`;
      throw new Error("Reddit refused the sign-in");
    }
    this.token = { value: token.access_token, until: Date.now() + Math.max(60, (token.expires_in ?? 3600) - 60) * 1000 };
    return token.access_token;
  }
  private async api(path: string, init: Parameters<typeof callJson>[3] = {}, retry = true): Promise<unknown> {
    const token = await this.signIn();
    return callJson(this.fetchImpl, "Reddit", `${this.base("api")}${path}`, {
      ...init, headers: { authorization: `Bearer ${token}`, "user-agent": this.options.userAgent },
    }).catch((error: unknown) => {
      if (!retry || !/\(401\)$/.test(error instanceof Error ? error.message : "")) throw error;
      this.token = null;
      return this.api(path, init, false);
    });
  }
  protected async poll(first: boolean): Promise<InboundMessage[]> {
    const listing = Listing.parse(await this.api("/message/unread?limit=100&raw_json=1"));
    this.refused = null;
    const messages: InboundMessage[] = [];
    for (const item of listing.data.children) {
      if (this.seen.has(item.data.name)) continue;
      this.note(item.data.name);
      // What was waiting before Branch started is left as it is, unread, and not answered.
      if (first) continue;
      const inbound = this.inbound(item);
      if (inbound) messages.push(inbound);
      await this.api("/api/read_message", { method: "POST", form: { id: item.data.name } }).catch(() => undefined);
    }
    return messages.reverse();
  }
  private note(name: string): void {
    this.seen.add(name);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
  }
  private inbound(item: z.infer<typeof Item>): InboundMessage | null {
    const { name, author, author_fullname: authorId, body, subject } = item.data;
    if (!author || author === "[deleted]" || author.toLowerCase() === this.options.username.toLowerCase()) return null;
    const direct = item.kind === "t4";
    if (!direct && item.kind !== "t1") return null;
    const own = new RegExp(`(^|\\s)/?u/${this.options.username.replace(/[^A-Za-z0-9_-]/g, "")}\\b[\\s,:]*`, "gi");
    const text = (body ?? "").replace(own, " ").trim();
    if (!text) return null;
    const chatId = direct ? this.ids.short(author, "user") : name;
    this.targets.set(chatId, name);
    if (this.targets.size > 1000) this.targets.delete(this.targets.keys().next().value!);
    return {
      channel: this.id, chatId, chatKind: direct ? "direct" : "group",
      ...(direct ? {} : { chatTitle: `${subject ?? "Reddit"}${item.data.subreddit ? ` in r/${item.data.subreddit}` : ""}` }),
      senderId: authorId ?? `u/${author}`, senderName: author, text, addressed: true, messageId: name,
    };
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    const fullname = /^t[14]_[a-z0-9]+$/i;
    const thing = replyToMessageId && fullname.test(replyToMessageId) ? replyToMessageId
      : this.targets.get(chatId) ?? (fullname.test(chatId) ? chatId : null);
    // Every answer is a reply; a private chat with nothing remembered to answer (after a restart) waits for its next message.
    if (!thing) throw new Error("There is no Reddit message to answer in that chat yet");
    const answer = await this.api("/api/comment", { method: "POST", form: { api_type: "json", thing_id: thing, text: text.slice(0, this.maxTextLength) } });
    const posted = Posted.parse(answer);
    if (posted.json.errors.length)
      throw new Error(`Reddit would not post it (${posted.json.errors.map((e) => String(e[0]).slice(0, 40)).join(", ")})`);
    return posted.json.data?.things?.[0]?.data.name;
  }
}

export const redditService = defineService({
  kind: "reddit", name: "Reddit", docs: "https://www.reddit.com/dev/api/",
  needs: ["A Reddit account for the assistant, and a \"script\" app made on it at reddit.com/prefs/apps",
    "The app's client id (in the settings) and its secret, saved as a secret", "The account's password, saved as a secret"],
  receives: "polls",
  settings: z.object({
    username: z.string().regex(/^[A-Za-z0-9_-]{3,20}$/),
    clientId: z.string().regex(/^[A-Za-z0-9_-]{10,40}$/),
    clientSecretSecret: z.string().regex(secretName).default("REDDIT_CLIENT_SECRET"),
    passwordSecret: z.string().regex(secretName).default("REDDIT_PASSWORD"),
    /** Reddit asks every program to say what it is and who runs it. */
    userAgent: z.string().min(10).max(200).optional(),
    authBase: z.string().url().default("https://www.reddit.com"),
    apiBase: z.string().url().default("https://oauth.reddit.com"),
    pollSeconds: z.number().int().min(10).max(3600).default(30),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.authBase), "Reddit sign-in");
    await deps.assertAllowed(new URL(settings.apiBase), "Reddit API");
    return new RedditChannel({
      id: deps.id, clientId: settings.clientId, username: settings.username,
      clientSecret: await deps.secret(settings.clientSecretSecret), password: await deps.secret(settings.passwordSecret),
      userAgent: settings.userAgent ?? `desktop:branch-agent:1.0 (by /u/${settings.username})`,
      authBase: settings.authBase, apiBase: settings.apiBase, pollMs: settings.pollSeconds * 1000, fetch: deps.fetch,
      secretNames: { client: settings.clientSecretSecret, password: settings.passwordSecret },
    });
  },
});
