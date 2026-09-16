import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { Store } from "./store.js";
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
    secret: z.string().min(0).max(100).optional(),
    events: z.array(z.string().min(1).max(50)).min(1).max(20),
    enabled: z.boolean().default(true),
  })
  .strict();
export type WebhookConfig = z.infer<typeof WebhookSchema>;
export interface WebhookState {
  id: string;
  name: string;
  url: string;
  secret?: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  failureCount: number;
  disabledAt: string | null;
  disabledReason: string | null;
}

const retryDelays = [5000, 10000, 30000]; // 5s, 10s, 30s
const maxAttempts = 3;
const maxConsecutiveFailures = 5;
const deliveryTimeoutMs = 10000;

export const webhookEvents = [
  "run.completed",
  "run.failed",
  "schedule.fired",
  "delivery.failed",
  "trigger.fired",
  "approval.needed",
] as const;
export type WebhookEvent = (typeof webhookEvents)[number];

export class Webhooks {
  constructor(
    readonly store: Store,
    private readonly policy: NetworkPolicy,
  ) {}

  /**
   * Notify all webhooks listening for an event. Delivers asynchronously in background.
   */
  notify(owner: string, event: WebhookEvent, payload: Record<string, unknown>): void {
    // Fire all deliveries asynchronously without blocking
    for (const webhook of this.list(owner)) {
      void this.deliver(owner, webhook.id, event, payload).catch(() => undefined);
    }
  }

  /**
   * Create a new outbound webhook.
   */
  create(context: ToolContext, input: unknown): WebhookState {
    if (!context.permissions.has("webhooks.manage"))
      throw new Error("Permission denied: webhooks.manage");

    const definition = WebhookSchema.parse(input);
    const id = randomUUID();
    const now = new Date().toISOString();

    const data: WebhookConfig = {
      name: definition.name,
      url: definition.url,
      secret: definition.secret,
      events: definition.events,
      enabled: true,
    };

    this.store.save("webhooks", context.owner, id, data);
    return { id, createdAt: now, updatedAt: now, failureCount: 0, disabledAt: null, disabledReason: null, ...data };
  }

  /**
   * Get a webhook by ID (owner-scoped).
   */
  get(owner: string, id: string): WebhookState | undefined {
    const record = this.store.get("webhooks", owner, id);
    if (!record) return undefined;
    const data = record.data as WebhookConfig;
    const disabledData = record.data as Record<string, unknown>;
    return {
      id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      failureCount: (disabledData.failureCount ?? 0) as number,
      disabledAt: (disabledData.disabledAt ?? null) as string | null,
      disabledReason: (disabledData.disabledReason ?? null) as string | null,
      ...data,
    };
  }

  /**
   * List all webhooks for the owner.
   */
  list(owner: string): WebhookState[] {
    return this.store
      .list("webhooks", owner)
      .map((record) => {
        const data = record.data as WebhookConfig;
        const disabledData = record.data as Record<string, unknown>;
        return {
          id: record.id,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          failureCount: (disabledData.failureCount ?? 0) as number,
          disabledAt: (disabledData.disabledAt ?? null) as string | null,
          disabledReason: (disabledData.disabledReason ?? null) as string | null,
          ...data,
        };
      });
  }

  /**
   * Remove a webhook.
   */
  remove(owner: string, id: string): void {
    const webhook = this.get(owner, id);
    if (!webhook) throw new Error("Webhook not found");
    this.store.delete("webhooks", owner, id);
  }

  /**
   * Test a webhook by sending a test payload.
   */
  async test(owner: string, id: string): Promise<{ ok: boolean; message: string }> {
    const webhook = this.get(owner, id);
    if (!webhook) throw new Error("Webhook not found");

    const payload = {
      event: "webhook.test",
      timestamp: new Date().toISOString(),
      test: true,
    };

    try {
      const result = await this.send(webhook, payload, 1);
      return result;
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get the webhook delivery log.
   */
  getLog(webhookId: string, owner: string): Array<{ id: number; eventType: string; status: string; attempt: number; nextRetryAt: string | null; createdAt: string }> {
    return this.store.getWebhookLog(webhookId, owner);
  }

  /**
   * Send a webhook payload with retry logic.
   */
  private async send(
    webhook: WebhookState,
    payload: Record<string, unknown>,
    attempt: number,
  ): Promise<{ ok: boolean; message: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), deliveryTimeoutMs);

    try {
      // Check network policy
      await this.policy.assertAllowed(new URL(webhook.url), "webhook");

      // Build the request
      const body = JSON.stringify(payload);
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };

      // Add HMAC signature if secret is provided
      if (webhook.secret) {
        const signature = createHmac("sha256", webhook.secret)
          .update(body)
          .digest("hex");
        headers["x-branch-signature"] = `sha256=${signature}`;
      }

      const response = await fetch(webhook.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      const success = response.ok;
      const message = `HTTP ${response.status}`;

      return { ok: success, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "The operation was aborted" || message.includes("aborted"))
        return { ok: false, message: "Timeout" };
      return { ok: false, message };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Deliver a webhook to an endpoint with retries and auto-disable on failure.
   */
  async deliver(owner: string, webhookId: string, event: WebhookEvent, payload: Record<string, unknown>): Promise<void> {
    const webhook = this.get(owner, webhookId);
    if (!webhook || !webhook.enabled) return;

    // Check if the webhook is interested in this event
    if (!webhook.events.includes(event)) return;

    const eventPayload = {
      event,
      timestamp: new Date().toISOString(),
      ...payload,
    };

    // Try to send immediately
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.send(webhook, eventPayload, attempt);

      if (result.ok) {
        this.store.logWebhookDelivery(webhookId, owner, event, "success", attempt, null);
        return;
      }

      // Log the failure
      const nextRetryAt = attempt < maxAttempts ? new Date(Date.now() + retryDelays[attempt - 1]).toISOString() : null;
      this.store.logWebhookDelivery(webhookId, owner, event, "failed", attempt, nextRetryAt);

      // Wait before retrying
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt - 1]));
      }
    }

    // All attempts failed - update failure count and possibly disable
    webhook.failureCount = (webhook.failureCount || 0) + 1;
    if (webhook.failureCount >= maxConsecutiveFailures) {
      webhook.enabled = false;
      webhook.disabledAt = new Date().toISOString();
      webhook.disabledReason = `Disabled after ${maxConsecutiveFailures} consecutive delivery failures`;
    }

    this.store.save("webhooks", owner, webhookId, {
      ...webhook,
      failureCount: webhook.failureCount,
      disabledAt: webhook.disabledAt,
      disabledReason: webhook.disabledReason,
    });
  }

  /**
   * Enable a webhook that was auto-disabled.
   */
  enable(owner: string, id: string): WebhookState {
    const webhook = this.get(owner, id);
    if (!webhook) throw new Error("Webhook not found");

    webhook.enabled = true;
    webhook.failureCount = 0;
    webhook.disabledAt = null;
    webhook.disabledReason = null;

    this.store.save("webhooks", owner, id, {
      ...webhook,
    });

    return this.get(owner, id)!;
  }
}
