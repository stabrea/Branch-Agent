/**
 * FQ-surfaces.mobile-push: the product side of Web Push — keeping the owner's subscribed devices,
 * and delivering "your task finished" while the app is backgrounded or closed. The crypto is
 * src/web-push-crypto.ts; this file is where a subscription is kept, and where the runtime's
 * `notifyEvent` (src/webhooks.ts's `WebhookNotifier` shape) turns into an actual push.
 *
 * Routes live here too, in the same one-file style as src/webhooks.ts, and are wired into
 * src/server.ts the same way src/devices/api.ts is: `handlesWebPushPath` gates the block,
 * `WebPushHttpError` carries the status back out to the generic `HttpError` the server answers with.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { readComfort } from "./comfort/settings.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { Store } from "./store.js";
import {
  type FetchLike, type PushSubscription, type StoredEcKey,
  ecKeyToStored, generateEcKeyPair, sendWebPush, storedEcKeyToRaw, toBase64Url,
} from "./web-push-crypto.js";

const VAPID_ID = "push-vapid";
/** How many devices are sent to at once; a household has a handful, and a long list is still bounded. */
const SEND_CONCURRENCY = 4;
const subscriptionId = (endpoint: string) => `push-sub:${createHash("sha256").update(endpoint).digest("hex").slice(0, 32)}`;

export const SubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(200) }),
}).strict();
export type SubscribeInput = z.infer<typeof SubscribeSchema>;

/**
 * A device's registered subscription, and the one hook the rest of the app needs: `notify`, called
 * exactly where an outbound webhook would be (src/index.ts's `guardedNotify`), so a push is held
 * behind Lockdown exactly as a webhook is.
 */
export class WebPushService {
  constructor(
    private readonly store: Store,
    private readonly owner: string,
    /** The same address rule every other outbound request in this app is held to (src/network-policy.ts). */
    private readonly policy: NetworkPolicy,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  ) {}
  /** The longest one device's push service is waited on before it is given up on. */
  sendTimeoutMs = 10_000;

  /** Generates and saves the server's VAPID keypair the first time anything asks for it. */
  private vapidKey(): StoredEcKey {
    const saved = this.store.get("settings", this.owner, VAPID_ID)?.data as Partial<StoredEcKey> | undefined;
    if (saved?.d && saved.x && saved.y) return saved as StoredEcKey;
    const { publicKeyRaw, privateKeyRaw } = generateEcKeyPair();
    const key = ecKeyToStored(publicKeyRaw, privateKeyRaw);
    this.store.save("settings", this.owner, VAPID_ID, { ...key });
    return key;
  }
  /** The public half of the VAPID key, for the page to pass to `pushManager.subscribe`. */
  vapidPublicKey(): string {
    return toBase64Url(storedEcKeyToRaw(this.vapidKey()).publicKeyRaw);
  }

  /**
   * A well-formed endpoint is saved here; whether it is one this server may actually reach is
   * checked again on every send (`deliverAll`), the same way a webhook's address is (src/webhooks.ts
   * `send()`) — so a subscription made before the owner's network settings changed is held to the
   * settings in force right now, not the ones in force when the phone first subscribed.
   */
  subscribe(input: SubscribeInput): void {
    this.store.save("settings", this.owner, subscriptionId(input.endpoint),
      { endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, createdAt: new Date().toISOString() });
  }
  unsubscribe(endpoint: string): void {
    this.store.delete("settings", this.owner, subscriptionId(endpoint));
  }
  private subscriptions(): PushSubscription[] {
    return this.store.list("settings", this.owner)
      .filter((row) => row.id.startsWith("push-sub:"))
      .map((row) => row.data as unknown as PushSubscription);
  }

  /**
   * Wired as a `WebhookNotifier`. Only a top-level, non-isolated run the owner (or a channel
   * standing in for them) actually started gets a push — never a grader, a heartbeat check-in, a
   * delegated sub-task, or an internal evaluation/study task (the `top`/`isolated`/`source` fields
   * runtime.ts's `finish()` adds to the payload alongside the ones every webhook already gets).
   */
  notify(event: string, payload: Record<string, unknown>): void {
    if (event !== "run.completed" && event !== "run.failed") return;
    if (payload.top !== true || payload.isolated === true) return;
    if (!["owner", "channel"].includes(String(payload.source ?? "owner"))) return;
    // R17-S17's own rule (public/comfort.js): "This window only" means no OS-level notification
    // ever comes from this computer, and a push notification is exactly that, so it is skipped too.
    if (readComfort(this.store, this.owner, "notify").method === "window") return;
    const runId = String(payload.runId ?? "");
    const run = runId ? this.store.run(runId) : undefined;
    const completed = payload.status === "completed";
    const prompt = (run?.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    const message = {
      title: completed ? "Task finished" : "Task needs attention",
      body: prompt || (completed ? "Your task is done." : "Your task did not finish."),
      tag: runId || "branch-task", runId, sessionId: String(payload.sessionId ?? ""),
    };
    void this.deliverAll(message).catch(() => undefined);
  }

  private async deliverAll(message: Record<string, unknown>): Promise<void> {
    const queue = this.subscriptions();
    if (!queue.length) return;
    const vapidKey = this.vapidKey();
    const body = Buffer.from(JSON.stringify(message));
    // A few devices at a time, each with its own time limit, so one that never answers holds up nobody.
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await this.deliverOne(next, vapidKey, body);
    };
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, queue.length) }, worker));
  }

  private async deliverOne(subscription: PushSubscription, vapidKey: StoredEcKey, body: Buffer): Promise<void> {
    try {
      await this.policy.assertAllowed(new URL(subscription.endpoint), "push address");
      const signal = AbortSignal.timeout(this.sendTimeoutMs);
      const response = await sendWebPush(this.fetchImpl, subscription, vapidKey, body, { signal });
      // RFC 8030 §7: the push service says the subscription is gone; keeping it would just fail again.
      if (response.status === 404 || response.status === 410) this.unsubscribe(subscription.endpoint);
    } catch {
      /* one device unreachable, slow, redirecting, or refused by the owner's network settings never disturbs the run that finished, or the next device */
    }
  }
}

/* ---------- the /api/push/* routes ---------- */
export class WebPushHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const handlesWebPushPath = (path: string): boolean => path === "/api/push/vapid-key" || path === "/api/push/subscribe" || path === "/api/push/unsubscribe";

export interface WebPushHttpDeps { webPush: WebPushService; method: string; readBody: () => Promise<unknown> }
export async function webPushApi(deps: WebPushHttpDeps, path: string): Promise<unknown> {
  if (path === "/api/push/vapid-key") {
    if (deps.method !== "GET") throw new WebPushHttpError(405, "Use GET");
    return { key: deps.webPush.vapidPublicKey() };
  }
  if (path === "/api/push/subscribe") {
    if (deps.method !== "POST") throw new WebPushHttpError(405, "Use POST");
    const parsed = SubscribeSchema.safeParse(await deps.readBody());
    if (!parsed.success) throw new WebPushHttpError(400, "That is not a push subscription.");
    deps.webPush.subscribe(parsed.data);
    return { subscribed: true };
  }
  // /api/push/unsubscribe
  if (deps.method !== "POST") throw new WebPushHttpError(405, "Use POST");
  const body = z.object({ endpoint: z.string().max(2000) }).safeParse(await deps.readBody());
  if (!body.success) throw new WebPushHttpError(400, "That is not a push endpoint.");
  deps.webPush.unsubscribe(body.data.endpoint);
  return { unsubscribed: true };
}
