import { z } from "zod";
import type { Store } from "../store.js";
import type { WebhookNotifier } from "../webhooks.js";

/**
 * The delivery ledger: every outbound channel message is written down before it is sent, split
 * into ordered chunks with stable keys, so a message survives an unavailable channel and is sent
 * in order after reconnect without duplicates. A chunk that keeps failing is kept as a dead letter
 * the owner can see and retry.
 */
export const DeliverySchema = z.object({
  key: z.string().min(1).max(200),
  channel: z.string().min(1).max(64),
  chatId: z.string().min(1).max(64),
  seq: z.number().int().min(0),
  /** Position in the queue; later messages never overtake earlier ones. */
  order: z.number().int().min(0).default(0),
  text: z.string().min(1).max(4096),
  replyTo: z.string().max(64).nullable().default(null),
  status: z.enum(["pending", "sent", "dead"]),
  attempts: z.number().int().min(0),
  nextAt: z.string(),
  lastError: z.string().max(500).nullable().default(null),
  messageId: z.string().max(64).nullable().default(null),
  sentAt: z.string().nullable().default(null),
}).strict();
export type Delivery = z.infer<typeof DeliverySchema> & { id: string; createdAt: string; updatedAt: string };
export type Sender = (chatId: string, text: string, replyTo?: string) => Promise<string | undefined>;

export const chunkLimit = 3500;
export const maxAttempts = 5;
const keepSentDays = 7;

/** Splits long text at line or space boundaries so every chunk fits a channel message. */
export function chunkText(text: string, limit = chunkLimit): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > limit / 2 ? cut : limit;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest.length || !chunks.length) chunks.push(rest || "(empty message)");
  return chunks;
}
/** Retry delay after `attempts` failures: 5 s, 10 s, 20 s, 40 s ... capped at ten minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(600000, 5000 * 2 ** Math.max(0, attempts - 1));
}

export class Deliveries {
  private next: number | undefined;
  /** Announces a given-up chunk to outbound webhooks; a no-op until `createBranch` connects them. */
  notifyEvent: WebhookNotifier = () => undefined;
  constructor(private readonly store: Store, private readonly owner: string, public now: () => Date = () => new Date()) {}
  private nextOrder(): number {
    this.next ??= this.list().reduce((max, d) => Math.max(max, d.order + 1), 0);
    return this.next++;
  }
  /** Records the chunks of one message; a key seen before is not queued again. */
  enqueue(channel: string, chatId: string, text: string, key: string, replyTo?: string): Delivery[] {
    const chunks = chunkText(text);
    const rows: Delivery[] = [];
    for (const [seq, chunk] of chunks.entries()) {
      const id = `${key}#${seq}`;
      const existing = this.get(id);
      if (existing) { rows.push(existing); continue; }
      const data = DeliverySchema.parse({ key, channel, chatId, seq, order: this.nextOrder(), text: chunk, replyTo: seq === 0 ? replyTo ?? null : null,
        status: "pending", attempts: 0, nextAt: this.now().toISOString() });
      rows.push(this.save(id, data));
    }
    return rows;
  }
  /**
   * Sends what is due on one channel, chat by chat and in order. A failure stops that chat for
   * now so later chunks never overtake earlier ones; the fifth failure parks the chunk as dead.
   */
  async flush(channel: string, send: Sender): Promise<{ sent: number; failed: number; dead: number }> {
    const due = this.now().toISOString();
    const totals = { sent: 0, failed: 0, dead: 0 };
    const byChat = new Map<string, Delivery[]>();
    for (const row of this.list().filter((d) => d.channel === channel && d.status === "pending"))
      byChat.set(row.chatId, [...(byChat.get(row.chatId) ?? []), row]);
    for (const rows of byChat.values()) {
      rows.sort((a, b) => a.order - b.order);
      if (rows[0]!.nextAt > due) continue;
      for (const row of rows) {
        const outcome = await this.attempt(row, send);
        totals[outcome]++;
        if (outcome !== "sent") break;
      }
    }
    this.prune();
    return totals;
  }
  private async attempt(row: Delivery, send: Sender): Promise<"sent" | "failed" | "dead"> {
    try {
      const messageId = await send(row.chatId, row.text, row.replyTo ?? undefined);
      this.save(row.id, { ...this.data(row), status: "sent", messageId: messageId ?? null, sentAt: this.now().toISOString(), lastError: null });
      return "sent";
    } catch (error) {
      const attempts = row.attempts + 1, dead = attempts >= maxAttempts;
      const lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      this.save(row.id, { ...this.data(row), status: dead ? "dead" : "pending", attempts, lastError,
        nextAt: new Date(this.now().getTime() + backoffMs(attempts)).toISOString() });
      if (dead) this.notifyEvent("delivery.failed", { deliveryId: row.id, channel: row.channel, chatId: row.chatId, attempts, error: lastError });
      return dead ? "dead" : "failed";
    }
  }
  /** Puts a dead or waiting chunk back at the front of the line. */
  retry(id: string): Delivery {
    const row = this.get(id);
    if (!row) throw new Error("No such delivery");
    if (row.status === "sent") throw new Error("That message was already sent");
    return this.save(id, { ...this.data(row), status: "pending", attempts: 0, nextAt: this.now().toISOString(), lastError: null });
  }
  /** Chunks that are waiting or gave up, oldest first. */
  outstanding(): Delivery[] {
    return this.list().filter((d) => d.status !== "sent").sort((a, b) => a.order - b.order);
  }
  list(): Delivery[] {
    return this.store.list("deliveries", this.owner).flatMap((record) => {
      const parsed = DeliverySchema.safeParse(record.data);
      return parsed.success ? [{ ...parsed.data, id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt }] : [];
    });
  }
  private get(id: string): Delivery | undefined {
    const record = this.store.get("deliveries", this.owner, id);
    const parsed = record && DeliverySchema.safeParse(record.data);
    return parsed && parsed.success ? { ...parsed.data, id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt } : undefined;
  }
  private save(id: string, data: z.infer<typeof DeliverySchema>): Delivery {
    const record = this.store.save("deliveries", this.owner, id, data);
    return { ...data, id, createdAt: record.createdAt, updatedAt: record.updatedAt };
  }
  private data(row: Delivery): z.infer<typeof DeliverySchema> {
    const { id, createdAt, updatedAt, ...data } = row;
    void id; void createdAt; void updatedAt;
    return data;
  }
  private prune(): void {
    const cutoff = new Date(this.now().getTime() - keepSentDays * 86400000).toISOString();
    for (const row of this.list()) if (row.status === "sent" && (row.sentAt ?? row.updatedAt) < cutoff) this.store.delete("deliveries", this.owner, row.id);
  }
}
