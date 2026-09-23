import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { errorText } from "./contracts.js";
import type { Store } from "./store.js";
import type { DeliveryHandler } from "./scheduler.js";

/**
 * A draft social post: written and, if the owner likes, given a time to go out — but it is only
 * ever sent once the owner has said yes. Preparing or scheduling a post never sends it; it sits in
 * the queue, due or not, until `approve` is called. A post the owner never gets to stays queued
 * forever, which is the point: nothing goes out that was not looked at first.
 */
export const SocialPostSchema = z.object({
  /** Which connected channel to send through, e.g. "bluesky" or "mastodon" (src/channels/). */
  platform: z.string().trim().min(1).max(40),
  /** The account, room or handle to post as, within that channel. Left blank for a channel with one obvious place. */
  target: z.string().trim().max(160).optional().default(""),
  text: z.string().trim().min(1).max(3000),
  /** When to send it, once approved. Left out means "as soon as the owner says yes". */
  scheduledFor: z.string().datetime().optional(),
  /** A short name for the queue list; falls back to the start of the text. */
  label: z.string().trim().max(120).optional(),
}).strict();
export type SocialPostInput = z.infer<typeof SocialPostSchema>;

export type SocialPostStatus = "queued" | "approved" | "posted" | "rejected";
export interface SocialPostRecord {
  id: string; platform: string; target: string; text: string; label: string;
  status: SocialPostStatus;
  scheduledFor: string | null;
  createdAt: string; approvedAt: string | null; postedAt: string | null;
  messageId: string | null; failure: string | null;
}

function toRecord(row: Record<string, unknown>): SocialPostRecord {
  return {
    id: String(row.id), platform: String(row.platform), target: String(row.target ?? ""),
    text: String(row.text), label: String(row.label ?? ""), status: String(row.status) as SocialPostStatus,
    scheduledFor: row.scheduled_for === null || row.scheduled_for === undefined ? null : String(row.scheduled_for),
    createdAt: String(row.created_at),
    approvedAt: row.approved_at === null || row.approved_at === undefined ? null : String(row.approved_at),
    postedAt: row.posted_at === null || row.posted_at === undefined ? null : String(row.posted_at),
    messageId: row.message_id === null || row.message_id === undefined ? null : String(row.message_id),
    failure: row.failure === null || row.failure === undefined ? null : String(row.failure),
  };
}

/**
 * Content scheduling behind an approval queue: a post is prepared and, optionally, given a time to
 * go out, but it is kept waiting — `queued`, never sent — until the owner authorizes it with
 * `approve`. Only an approved post can ever be sent, and only once its scheduled time (if any) has
 * come; `sweep` is what a regular beat calls to send whatever is due.
 */
export class SocialScheduler {
  private readonly db: DatabaseSync;
  constructor(private readonly store: Store, private readonly deliver?: DeliveryHandler) {
    this.db = store.sqlite;
    this.db.exec(`CREATE TABLE IF NOT EXISTS social_posts(id TEXT PRIMARY KEY, owner TEXT NOT NULL, platform TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      scheduled_for TEXT, created_at TEXT NOT NULL, approved_at TEXT, posted_at TEXT, message_id TEXT, failure TEXT);
      CREATE INDEX IF NOT EXISTS social_posts_owner ON social_posts(owner);`);
  }

  list(owner: string): SocialPostRecord[] {
    return this.db.prepare("SELECT * FROM social_posts WHERE owner=? ORDER BY created_at DESC LIMIT 200").all(owner).map(toRecord);
  }

  private one(owner: string, id: string): SocialPostRecord {
    const row = this.db.prepare("SELECT * FROM social_posts WHERE owner=? AND id=?").get(owner, id);
    if (!row) throw new Error("There is no social post with that number");
    return toRecord(row as Record<string, unknown>);
  }

  /** Writes a draft and, if a time was given, schedules it — but only ever into the approval queue. */
  prepare(owner: string, input: unknown, now = new Date()): SocialPostRecord {
    const value = SocialPostSchema.parse(input);
    const id = randomUUID();
    this.db.prepare(`INSERT INTO social_posts(id, owner, platform, target, text, label, status, scheduled_for,
      created_at, approved_at, posted_at, message_id, failure) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, owner, value.platform, value.target ?? "", value.text, value.label ?? value.text.slice(0, 120),
      "queued", value.scheduledFor ?? null, now.toISOString(), null, null, null, null);
    return this.one(owner, id);
  }

  private requireQueued(owner: string, id: string): SocialPostRecord {
    const row = this.one(owner, id);
    if (row.status !== "queued") throw new Error(`This post is already ${row.status}, not waiting for approval`);
    return row;
  }

  /**
   * The owner's yes. The post may now be sent — right away if its scheduled time has already come,
   * otherwise it waits, `approved`, for `sweep` to find it once that time arrives. A post that was
   * rejected or already sent cannot be approved again.
   */
  async approve(owner: string, id: string, now = new Date()): Promise<SocialPostRecord> {
    const row = this.requireQueued(owner, id);
    this.db.prepare("UPDATE social_posts SET status='approved', approved_at=? WHERE owner=? AND id=?")
      .run(now.toISOString(), owner, id);
    const due = !row.scheduledFor || Date.parse(row.scheduledFor) <= now.getTime();
    return due ? this.publish(owner, id, now) : this.one(owner, id);
  }

  /** Takes a still-queued post out of the queue for good, without ever sending it. */
  reject(owner: string, id: string): SocialPostRecord {
    this.requireQueued(owner, id);
    this.db.prepare("UPDATE social_posts SET status='rejected' WHERE owner=? AND id=?").run(owner, id);
    return this.one(owner, id);
  }

  /** Approved posts whose time has come and have not gone out yet — never a merely queued one. */
  due(owner: string, now = new Date()): SocialPostRecord[] {
    return this.list(owner).filter((post) =>
      post.status === "approved" && (!post.scheduledFor || Date.parse(post.scheduledFor) <= now.getTime()));
  }

  /** Sends an approved post through its channel. Refuses anything the owner has not authorized. */
  async publish(owner: string, id: string, now = new Date()): Promise<SocialPostRecord> {
    const row = this.one(owner, id);
    if (row.status === "posted") return row;
    if (row.status !== "approved") throw new Error("Only a post the owner has approved may be sent");
    if (!this.deliver) throw new Error("No channel is connected to send social posts");
    try {
      const result = await this.deliver(row.platform, row.target, row.text, `social:${id}`);
      this.db.prepare("UPDATE social_posts SET status='posted', posted_at=?, message_id=? WHERE owner=? AND id=?")
        .run(now.toISOString(), result.messageId ?? null, owner, id);
    } catch (error) {
      this.db.prepare("UPDATE social_posts SET failure=? WHERE owner=? AND id=?").run(errorText(error), owner, id);
      throw error;
    }
    return this.one(owner, id);
  }

  /** What a regular beat calls: sends every approved post whose time has come, and leaves the rest queued. */
  async sweep(owner: string, now = new Date()): Promise<SocialPostRecord[]> {
    const sent: SocialPostRecord[] = [];
    for (const post of this.due(owner, now)) {
      try { sent.push(await this.publish(owner, post.id, now)); }
      catch { /* left approved with its failure noted; the next beat tries again */ }
    }
    return sent;
  }
}
