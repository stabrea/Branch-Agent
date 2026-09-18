import { z } from "zod";
import type { ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, PollingChannel, secretName } from "./parity-common.js";

/**
 * Discourse forums. Branch signs in as the assistant's forum account with an API key, reads its
 * notifications, and answers private messages (direct) and mentions or replies (group, in their
 * topic) with a new post in the same topic.
 * API: https://docs.discourse.org/ (notifications, posts, topics).
 */
const types = { mentioned: 1, replied: 2, privateMessage: 6 } as const;
const Note = z.object({
  id: z.number(), notification_type: z.number(), read: z.boolean().optional(),
  topic_id: z.number().nullish(), post_number: z.number().nullish(),
  data: z.object({ original_post_id: z.union([z.number(), z.string()]).optional() }).passthrough().nullish(),
}).passthrough();
const Notes = z.object({ notifications: z.array(Note) }).passthrough();
const Post = z.object({
  id: z.number(), user_id: z.number(), username: z.string(), raw: z.string().optional(),
  topic_id: z.number(), post_number: z.number(), name: z.string().nullish(), topic_title: z.string().nullish(),
}).passthrough();
const TopicPosts = z.object({ post_stream: z.object({ posts: z.array(z.object({ id: z.number(), post_number: z.number() }).passthrough()) }).passthrough() }).passthrough();

export interface DiscourseOptions {
  id: string; forum: string; username: string; apiKey: string; keyName?: string; pollMs?: number; fetch?: typeof fetch;
}

export class DiscourseChannel extends PollingChannel {
  readonly kind = "discourse";
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private lastId: number | null = null;
  private refused: string | null = null;
  /** Topics known to be private messages, and the post number of each post handed over. */
  private readonly privateTopics = new Set<number>();
  private readonly postNumbers = new Map<string, number>();
  constructor(private readonly options: DiscourseOptions) {
    super(options.id, options.pollMs ?? 30000);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.base = options.forum.replace(/\/+$/, "");
    this.maxTextLength = 3500;
  }
  botName(): string | null { return this.options.username; }
  override health(): ChannelHealth {
    return this.refused && this.state.state !== "connected" ? { state: "needs attention", reason: this.refused } : this.state;
  }
  private call(path: string, init: Parameters<typeof callJson>[3] = {}): Promise<unknown> {
    return callJson(this.fetchImpl, "Discourse", `${this.base}${path}`, {
      ...init, headers: { "api-key": this.options.apiKey, "api-username": this.options.username },
    }).catch((error: unknown) => {
      if (/\((401|403)\)$/.test(error instanceof Error ? error.message : ""))
        this.refused = `The forum refused the API key for ${this.options.username}. Make a new one in the admin API keys page and save it as ${this.options.keyName ?? "DISCOURSE_API_KEY"}`;
      throw error;
    });
  }
  // mac6/bucket-16: carry on after a restart from the saved place (src/channels/catch-up.ts).
  protected override placeMark(): string | null { return this.lastId === null ? null : String(this.lastId); }
  protected override resumeFrom(mark: string): boolean {
    if (!/^\d{1,15}$/.test(mark)) return false;
    this.lastId = Number(mark);
    return true;
  }
  protected async poll(first: boolean): Promise<InboundMessage[]> {
    const notes = Notes.parse(await this.call("/notifications.json")).notifications;
    this.refused = null;
    const previous = this.lastId;
    for (const note of notes) this.lastId = Math.max(this.lastId ?? 0, note.id);
    if (first) return [];
    const fresh = notes.filter((note) => note.id > (previous ?? 0) && !note.read
      && (Object.values(types) as number[]).includes(note.notification_type));
    const messages: InboundMessage[] = [];
    for (const note of fresh.sort((a, b) => a.id - b.id)) {
      const inbound = await this.inbound(note);
      if (inbound) messages.push(inbound);
      await this.call("/notifications/mark-read.json", { method: "PUT", json: { id: note.id } }).catch(() => undefined);
    }
    return messages;
  }
  /** The post a notification points at, with its raw words. */
  private async post(note: z.infer<typeof Note>): Promise<z.infer<typeof Post> | null> {
    let postId = note.data?.original_post_id !== undefined ? Number(note.data.original_post_id) : NaN;
    if (!Number.isInteger(postId) && note.topic_id && note.post_number) {
      const topic = TopicPosts.parse(await this.call(`/t/${note.topic_id}/${note.post_number}.json`));
      postId = topic.post_stream.posts.find((p) => p.post_number === note.post_number)?.id ?? NaN;
    }
    return Number.isInteger(postId) ? Post.parse(await this.call(`/posts/${postId}.json`)) : null;
  }
  private async inbound(note: z.infer<typeof Note>): Promise<InboundMessage | null> {
    const post = await this.post(note);
    if (!post || post.username.toLowerCase() === this.options.username.toLowerCase()) return null;
    if (note.notification_type === types.privateMessage) this.privateTopics.add(post.topic_id);
    const direct = this.privateTopics.has(post.topic_id);
    const own = new RegExp(`(^|\\s)@${this.options.username.replace(/[^A-Za-z0-9_.-]/g, "").replace(/\./g, "\\.")}\\b[\\s,:]*`, "gi");
    const text = (post.raw ?? "").replace(own, " ").trim();
    if (!text) return null;
    this.postNumbers.set(String(post.id), post.post_number);
    if (this.postNumbers.size > 1000) this.postNumbers.delete(this.postNumbers.keys().next().value!);
    return {
      channel: this.id, chatId: String(post.topic_id), chatKind: direct ? "direct" : "group",
      ...(direct ? {} : { chatTitle: post.topic_title ?? `Topic ${post.topic_id}` }),
      senderId: String(post.user_id), senderName: post.name || post.username,
      text, addressed: true, messageId: String(post.id),
    };
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    const topic = Number(chatId);
    if (!Number.isInteger(topic) || topic <= 0) throw new Error("That is not a forum topic");
    const replyTo = replyToMessageId ? this.postNumbers.get(replyToMessageId) : undefined;
    const answer = await this.call("/posts.json", {
      method: "POST", json: { topic_id: topic, raw: text.slice(0, this.maxTextLength), ...(replyTo ? { reply_to_post_number: replyTo } : {}) },
    });
    const posted = z.object({ id: z.number() }).passthrough().safeParse(answer);
    return posted.success ? String(posted.data.id) : undefined;
  }
}

export const discourseService = defineService({
  kind: "discourse", name: "Discourse", docs: "https://docs.discourse.org/",
  needs: ["The address of the forum, and a forum account for the assistant",
    "An API key for that account (forum admin, API, New API key), saved as a secret"],
  receives: "polls",
  settings: z.object({
    forum: z.string().url(),
    username: z.string().regex(/^[A-Za-z0-9_.-]{2,60}$/),
    apiKeySecret: z.string().regex(secretName).default("DISCOURSE_API_KEY"),
    pollSeconds: z.number().int().min(10).max(3600).default(30),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.forum), "Discourse forum");
    return new DiscourseChannel({ id: deps.id, forum: settings.forum, username: settings.username,
      apiKey: await deps.secret(settings.apiKeySecret), keyName: settings.apiKeySecret,
      pollMs: settings.pollSeconds * 1000, fetch: deps.fetch });
  },
});
