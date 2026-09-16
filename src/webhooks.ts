import { randomUUID, createHmac } from "node:crypto";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { Store, SavedRecord } from "./store.js";
import type { NetworkPolicy } from "./network-policy.js";

/**
 * Outbound webhooks: the assistant notifies external endpoints when events occur.
 * Each webhook specifies a URL and optional secret. Delivery is JSON with an HMAC signature.
 * Failing deliveries are retried with exponential backoff, then auto-disabled.
 */
export const WebhookSchema = z
  .object({
    name: z.string().min(1).max(100),
    url: z.string().url().max(2000),
    secret: z.string().min(1).max(100).optional(),
    events: z.array(z.string().min(1).max(50)).min(1).max(20),
  })
  .strict();
export type WebhookConfig = z.infer<typeof WebhookSchema>;
export interface WebhookState {
  id: string;
  name: string;
  url: string;
  secret?: string | undefined;
  events: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  failureCount: number;
  disabledAt: string | null;
  disabledReason: string | null;
}

/** Pauses between delivery attempts, so three tries in all; overridable so tests wait no real seconds. */
export const defaultRetryDelays = [5000, 10000];
const maxConsecutiveFailures = 5;
const deliveryTimeoutMs = 10000;

export const webhookEvents = [
  "run.completed",
  "run.failed",
  "schedule.fired", "schedule.day_off",
  "delivery.failed",
  "trigger.fired",
  "approval.needed",
] as const;
export type WebhookEvent = (typeof webhookEvents)[number];
/** What the rest of the runtime calls to announce an event; a no-op when nothing is listening. */
export type WebhookNotifier = (event: WebhookEvent, payload: Record<string, unknown>) => void;

export class Webhooks {
  constructor(
    readonly store: Store,
    private readonly policy: NetworkPolicy,
    /** Pauses between attempts; one more attempt is made than there are pauses. */
    public retryDelays: number[] = defaultRetryDelays,
  ) {}

  /**
   * Notify every webhook listening for an event. Deliveries run in the background and their
   * failures are swallowed: announcing an event must never disturb the work that caused it.
   */
  notify(owner: string, event: WebhookEvent, payload: Record<string, unknown>): void {
    try {
      for (const webhook of this.list(owner))
        void this.deliver(owner, webhook.id, event, payload).catch(() => undefined);
    } catch {
      /* a webhook problem never affects the run that triggered it */
    }
  }

  /** A notifier bound to one owner, for the runtime and the delivery ledger to call. */
  notifier(owner: string): WebhookNotifier {
    return (event, payload) => this.notify(owner, event, payload);
  }

  /**
   * Create a new outbound webhook.
   */
  create(context: ToolContext, input: unknown): WebhookState {
    // Owner-only setting: the gate is the local session token, as for channels and teams.
    const definition = WebhookSchema.parse(input);
    const id = randomUUID();
    this.store.save("webhooks", context.owner, id, {
      name: definition.name,
      url: definition.url,
      events: definition.events,
      ...(definition.secret ? { secret: definition.secret } : {}),
      enabled: true,
      failureCount: 0,
      disabledAt: null,
      disabledReason: null,
    });
    return this.get(context.owner, id)!;
  }

  /**
   * Get a webhook by ID (owner-scoped).
   */
  get(owner: string, id: string): WebhookState | undefined {
    const record = this.store.get("webhooks", owner, id);
    return record ? hydrate(record) : undefined;
  }

  /**
   * List all webhooks for the owner.
   */
  list(owner: string): WebhookState[] {
    return this.store.list("webhooks", owner).map(hydrate);
  }

  /**
   * Remove a webhook.
   */
  remove(owner: string, id: string): void {
    if (!this.get(owner, id)) throw new Error("Webhook not found");
    this.store.delete("webhooks", owner, id);
  }

  /**
   * Test a webhook by sending a test payload straight away, without retries.
   */
  async test(owner: string, id: string): Promise<{ ok: boolean; message: string }> {
    const webhook = this.get(owner, id);
    if (!webhook) throw new Error("Webhook not found");
    const result = await this.send(webhook, { event: "webhook.test", timestamp: new Date().toISOString(), test: true });
    this.store.logWebhookDelivery(id, owner, "webhook.test", result.ok ? "success" : "failed", 1, null);
    return result;
  }

  /**
   * Get the webhook delivery log.
   */
  getLog(webhookId: string, owner: string): ReturnType<Store["getWebhookLog"]> {
    return this.store.getWebhookLog(webhookId, owner);
  }

  /**
   * Send one request. Never throws: a refused address or a dead endpoint is a failed result.
   */
  private async send(webhook: WebhookState, payload: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), deliveryTimeoutMs);
    try {
      await this.policy.assertAllowed(new URL(webhook.url), "webhook address");
      const body = JSON.stringify(payload);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (webhook.secret)
        headers["x-branch-signature"] = `sha256=${createHmac("sha256", webhook.secret).update(body).digest("hex")}`;
      const response = await fetch(webhook.url, { method: "POST", headers, body, signal: controller.signal, redirect: "error" });
      return { ok: response.ok, message: `HTTP ${response.status}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: controller.signal.aborted ? "Timed out" : message };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Deliver one event to one endpoint, retrying with growing pauses. When every attempt fails the
   * failure count grows, and a webhook that fails five times in a row switches itself off.
   */
  async deliver(owner: string, webhookId: string, event: string, payload: Record<string, unknown>): Promise<void> {
    const webhook = this.get(owner, webhookId);
    if (!webhook || !webhook.enabled || !webhook.events.includes(event)) return;
    const body = { event, timestamp: new Date().toISOString(), ...payload };

    for (let attempt = 1; attempt <= this.retryDelays.length + 1; attempt++) {
      const result = await this.send(webhook, body);
      if (result.ok) {
        this.store.logWebhookDelivery(webhookId, owner, event, "success", attempt, null);
        if (webhook.failureCount) this.saveState(owner, webhookId, { ...webhook, failureCount: 0 });
        return;
      }
      const pause = this.retryDelays[attempt - 1];
      const nextRetryAt = pause === undefined ? null : new Date(Date.now() + pause).toISOString();
      this.store.logWebhookDelivery(webhookId, owner, event, "failed", attempt, nextRetryAt);
      if (pause !== undefined) await new Promise((resolve) => setTimeout(resolve, pause));
    }
    this.recordFailure(owner, webhookId);
  }

  /** Counts one giving-up delivery and switches the webhook off once failures pile up. */
  private recordFailure(owner: string, webhookId: string): void {
    const current = this.get(owner, webhookId);
    if (!current) return;
    const failureCount = current.failureCount + 1;
    const off = failureCount >= maxConsecutiveFailures;
    this.saveState(owner, webhookId, {
      ...current,
      failureCount,
      enabled: !off,
      disabledAt: off ? new Date().toISOString() : current.disabledAt,
      disabledReason: off ? `Switched off after ${maxConsecutiveFailures} consecutive delivery failures` : current.disabledReason,
    });
  }

  /**
   * Turn a webhook back on after it switched itself off.
   */
  enable(owner: string, id: string): WebhookState {
    const webhook = this.get(owner, id);
    if (!webhook) throw new Error("Webhook not found");
    this.saveState(owner, id, { ...webhook, enabled: true, failureCount: 0, disabledAt: null, disabledReason: null });
    return this.get(owner, id)!;
  }

  /** Writes only the stored fields; the row's own id and timestamps never go into the blob. */
  private saveState(owner: string, id: string, state: WebhookState): void {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...data } = state;
    this.store.save("webhooks", owner, id, data);
  }
}

/** Row columns win over the stored blob, so a stale copy inside the blob can never leak out. */
function hydrate(record: SavedRecord): WebhookState {
  const data = record.data as Partial<WebhookState>;
  return {
    name: String(data.name ?? ""),
    url: String(data.url ?? ""),
    ...(data.secret ? { secret: data.secret } : {}),
    events: data.events ?? [],
    enabled: data.enabled !== false,
    failureCount: data.failureCount ?? 0,
    disabledAt: data.disabledAt ?? null,
    disabledReason: data.disabledReason ?? null,
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
