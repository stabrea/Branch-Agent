import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, PollingChannel, secretName, SendOnlyChannel } from "./parity-common.js";
import { callText, cutBytes } from "./threema.js";

/**
 * ntfy, a push notification service (ntfy.sh or a server the owner runs). Branch publishes to a
 * topic the owner's phone subscribes to. With a second "listen" topic, whatever is published there
 * reaches the assistant as a message from the owner, and the answer is published back to it.
 * A topic has no users: anybody who can publish to the listen topic is treated as that one person,
 * so the listen topic must be protected with an access token (or have a long unguessable name).
 * API: https://docs.ntfy.sh/publish/ and https://docs.ntfy.sh/subscribe/api/
 */
export interface NtfyOptions {
  id: string;
  server: string;
  topic: string;
  title: string;
  token?: string;
  tokenSecret?: string;
  listenTopic?: string;
  pollMs?: number;
  /** The first wait after a failed call, in milliseconds; it grows with each failure. */
  retryBaseMs?: number;
  fetch?: typeof fetch;
}

/** Every message Branch publishes carries this tag, so it never answers itself on the listen topic. */
export const ntfyOwnTag = "branch-assistant";
export const topicName = /^[-_A-Za-z0-9]{1,64}$/;
const NtfyEventSchema = z.object({
  id: z.string().min(1).max(64),
  event: z.string(),
  topic: z.string().default(""),
  message: z.string().default(""),
  tags: z.array(z.string()).default([]),
}).passthrough();
const PublishedSchema = z.object({ id: z.string().min(1).max(64) }).passthrough();

/** The publishing half, shared by the send-only and the two-way channel. */
class NtfyPublisher {
  readonly fetchImpl: typeof fetch;
  readonly base: string;
  readonly published = new Set<string>();
  problem: string | null = null;
  constructor(readonly options: NtfyOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.base = options.server.replace(/\/+$/, "");
  }
  headers(): Record<string, string> {
    return this.options.token ? { authorization: `Bearer ${this.options.token}` } : {};
  }
  noteRefusal(error: unknown): never {
    if (/\((401|403)\)/.test(error instanceof Error ? error.message : String(error)))
      this.problem = this.options.tokenSecret
        ? `ntfy refused the access token. Make a new one and save it as ${this.options.tokenSecret}`
        : "ntfy refused access to the topic. Make an access token and name it in the tokenSecret setting";
    throw error;
  }
  async publish(topic: string, text: string): Promise<string | undefined> {
    const answer = await callJson(this.fetchImpl, "ntfy", `${this.base}/`, {
      method: "POST", headers: this.headers(),
      json: { topic, message: cutBytes(text, 4000), title: this.options.title, tags: [ntfyOwnTag] },
    }).catch((error: unknown) => this.noteRefusal(error));
    this.problem = null;
    const sent = PublishedSchema.safeParse(answer);
    if (!sent.success) return undefined;
    this.published.add(sent.data.id);
    if (this.published.size > 500) this.published.delete(this.published.values().next().value!);
    return sent.data.id;
  }
}

/** Publishes only: the chat id is ignored and everything goes to the one topic. */
export class NtfyChannel extends SendOnlyChannel {
  readonly kind = "ntfy";
  readonly maxTextLength = 3500;
  private readonly publisher: NtfyPublisher;
  constructor(options: NtfyOptions) {
    super(options.id, "ntfy");
    this.publisher = new NtfyPublisher(options);
  }
  override health(): ChannelHealth {
    return this.publisher.problem ? { state: "needs attention", reason: this.publisher.problem } : super.health();
  }
  async send(_chatId: string, text: string): Promise<string | undefined> {
    return this.publisher.publish(this.publisher.options.topic, text);
  }
}

/** Publishes, and reads the listen topic every few seconds. */
export class NtfyListeningChannel extends PollingChannel {
  readonly kind = "ntfy";
  private readonly publisher: NtfyPublisher;
  private readonly listenTopic: string;
  private readonly seen = new Set<string>();
  private since: string | null = null;
  constructor(options: NtfyOptions & { listenTopic: string }) {
    super(options.id, options.pollMs ?? 5000, options.retryBaseMs ?? 1000);
    this.publisher = new NtfyPublisher(options);
    this.listenTopic = options.listenTopic;
  }
  botName(): string | null { return null; }
  override health(): ChannelHealth {
    return this.publisher.problem ? { state: "needs attention", reason: this.publisher.problem } : super.health();
  }
  private get chatId(): string { return this.ids.short(`topic:${this.listenTopic}`, "topic"); }
  // mac6/bucket-16: carry on after a restart from the saved place (src/channels/catch-up.ts).
  protected override placeMark(): string | null { return this.since; }
  protected override resumeFrom(mark: string): boolean {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(mark)) return false;
    this.since = mark;
    return true;
  }
  protected async poll(first: boolean): Promise<InboundMessage[]> {
    // The first call only asks for the newest message, to learn where the topic stands.
    const since = first ? "latest" : this.since ?? "all";
    const url = `${this.publisher.base}/${this.listenTopic}/json?${new URLSearchParams({ poll: "1", since })}`;
    const answer = await callText(this.publisher.fetchImpl, "ntfy", url, { headers: { accept: "application/x-ndjson", ...this.publisher.headers() } })
      .catch((error: unknown) => this.publisher.noteRefusal(error));
    this.publisher.problem = null;
    const out: InboundMessage[] = [];
    for (const line of answer.text.split("\n")) {
      const event = this.readLine(line);
      if (!event || this.seen.has(event.id)) continue;
      this.remember(event.id);
      this.since = event.id;
      if (first || event.event !== "message") continue;
      if (event.tags.includes(ntfyOwnTag) || this.publisher.published.has(event.id) || !event.message.trim()) continue;
      out.push({ channel: this.id, chatId: this.chatId, chatKind: "direct", senderId: this.chatId,
        senderName: `ntfy ${this.listenTopic}`, text: event.message, addressed: true, messageId: event.id });
    }
    // An empty topic has no id to start from, so the next call asks for anything from now on.
    if (first && !this.since) this.since = String(Math.floor(Date.now() / 1000));
    return out;
  }
  private readLine(line: string): z.infer<typeof NtfyEventSchema> | null {
    if (!line.trim()) return null;
    try {
      const parsed = NtfyEventSchema.safeParse(JSON.parse(line));
      return parsed.success && parsed.data.event === "message" ? parsed.data : null;
    } catch { return null; }
  }
  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
  }
  /** An answer goes back to the listen topic it came from; anything else goes to the main topic. */
  async send(chatId: string, text: string): Promise<string | undefined> {
    const topic = chatId === this.chatId ? this.listenTopic : this.publisher.options.topic;
    return this.publisher.publish(topic, text);
  }
}

export const ntfyService = defineService({
  kind: "ntfy", name: "ntfy", docs: "https://docs.ntfy.sh/publish/",
  needs: ["The ntfy server address (https://ntfy.sh, or your own)", "A topic your phone subscribes to",
    "Optionally, a second topic to write to the assistant from, protected with an access token saved as a secret"],
  receives: "polls",
  settings: z.object({
    server: z.string().url().default("https://ntfy.sh"),
    topic: z.string().regex(topicName),
    title: z.string().min(1).max(80).default("Branch"),
    tokenSecret: z.string().regex(secretName).optional(),
    listenTopic: z.string().regex(topicName).optional(),
    pollSeconds: z.number().int().min(2).max(300).default(5),
  }).strict(),
  async build(settings, deps): Promise<ChannelAdapter> {
    await deps.assertAllowed(new URL(settings.server), "ntfy server");
    const options: NtfyOptions = { id: deps.id, server: settings.server, topic: settings.topic, title: settings.title,
      pollMs: settings.pollSeconds * 1000, fetch: deps.fetch,
      ...(settings.tokenSecret ? { token: await deps.secret(settings.tokenSecret), tokenSecret: settings.tokenSecret } : {}) };
    return settings.listenTopic ? new NtfyListeningChannel({ ...options, listenTopic: settings.listenTopic }) : new NtfyChannel(options);
  },
});
