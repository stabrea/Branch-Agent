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
import { loadWords, type Language } from "./terminal-words.js";
import { lockedDown } from "./lockdown.js";
import {
  type FetchLike, type PushSubscription, type StoredEcKey,
  ecKeyToStored, generateEcKeyPair, sendWebPush, storedEcKeyToRaw, toBase64Url,
} from "./web-push-crypto.js";

const VAPID_ID = "push-vapid";
/**
 * The two secrets Web Push needs — the VAPID private key and each device's auth secret — live in the
 * locker (src/locker.ts: encrypted at rest, never in a backup), not in the settings rows beside them.
 */
const LOCKER_PROJECT = "web-push";
const VAPID_SECRET = "VAPID_PRIVATE_KEY";
/** The locker keeps at most 64 names a project; one is the VAPID key. */
const MOST_DEVICES = 63;
/** How many devices are sent to at once; a household has a handful, and a long list is still bounded. */
const SEND_CONCURRENCY = 4;
const endpointHash = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex").slice(0, 32);
const subscriptionId = (endpoint: string) => `push-sub:${endpointHash(endpoint)}`;
const deviceSecret = (endpoint: string) => `DEVICE_${endpointHash(endpoint).toUpperCase()}`;

export const SubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(200) }),
  /** The language the device's page is in, so the notification is written in it. */
  language: z.enum(["en", "fr"]).optional(),
}).strict();
export type SubscribeInput = z.infer<typeof SubscribeSchema>;

interface SavedDevice { endpoint: string; p256dh: string; auth?: string; language?: Language; createdAt?: string }
interface Device extends PushSubscription { language: Language }
interface Note { completed: boolean; prompt: string; runId: string; sessionId: string }

/**
 * A device's registered subscription, and the one hook the rest of the app needs: `notify`, called
 * exactly where an outbound webhook would be (src/index.ts's `guardedNotify`), so a push is held
 * behind Lockdown exactly as a webhook is.
 */
export class WebPushService {
  private vapidPending: Promise<StoredEcKey> | undefined;
  constructor(
    private readonly store: Store,
    private readonly owner: string,
    /** The same address rule every other outbound request in this app is held to (src/network-policy.ts). */
    private readonly policy: NetworkPolicy,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  ) {}
  /** The longest one device's push service is waited on before it is given up on. */
  sendTimeoutMs = 10_000;

  /**
   * Moves secrets an older version kept in plain settings rows into the locker. Run once at start, so
   * a backup taken before anything is sent already leaves them out; every read runs it again too.
   */
  async migrate(): Promise<void> {
    const saved = this.store.get("settings", this.owner, VAPID_ID)?.data as Partial<StoredEcKey> | undefined;
    if (saved?.d && saved.x && saved.y) {
      await this.store.locker.set(this.owner, LOCKER_PROJECT, VAPID_SECRET, saved.d);
      this.store.save("settings", this.owner, VAPID_ID, { x: saved.x, y: saved.y });
    }
    for (const row of this.deviceRows()) {
      const { auth, ...rest } = row.data;
      if (!auth) continue;
      await this.store.locker.set(this.owner, LOCKER_PROJECT, deviceSecret(row.data.endpoint), auth);
      this.store.save("settings", this.owner, row.id, { ...rest });
    }
  }

  /** The server's VAPID keypair, made and saved the first time anything asks for it. */
  private vapidKey(): Promise<StoredEcKey> {
    this.vapidPending ??= this.loadVapidKey().catch((error: unknown) => { this.vapidPending = undefined; throw error; });
    return this.vapidPending;
  }
  private async loadVapidKey(): Promise<StoredEcKey> {
    await this.migrate();
    const saved = this.store.get("settings", this.owner, VAPID_ID)?.data as Partial<StoredEcKey> | undefined;
    if (saved?.x && saved.y && this.store.locker.exists(this.owner, LOCKER_PROJECT, VAPID_SECRET)) {
      const secret = await this.store.locker.resolve(this.owner, LOCKER_PROJECT, [VAPID_SECRET]);
      return { x: saved.x, y: saved.y, d: secret[VAPID_SECRET]! };
    }
    const { publicKeyRaw, privateKeyRaw } = generateEcKeyPair();
    const key = ecKeyToStored(publicKeyRaw, privateKeyRaw);
    await this.store.locker.set(this.owner, LOCKER_PROJECT, VAPID_SECRET, key.d);
    this.store.save("settings", this.owner, VAPID_ID, { x: key.x, y: key.y });
    return key;
  }
  /** The public half of the VAPID key, for the page to pass to `pushManager.subscribe`. */
  async vapidPublicKey(): Promise<string> {
    return toBase64Url(storedEcKeyToRaw(await this.vapidKey()).publicKeyRaw);
  }

  /**
   * A well-formed endpoint is saved here; whether it is one this server may actually reach is
   * checked again on every send (`deliverAll`), the same way a webhook's address is (src/webhooks.ts
   * `send()`) — so a subscription made before the owner's network settings changed is held to the
   * settings in force right now, not the ones in force when the phone first subscribed.
   */
  async subscribe(input: SubscribeInput): Promise<void> {
    const id = subscriptionId(input.endpoint);
    if (!this.store.get("settings", this.owner, id) && this.deviceRows().length >= MOST_DEVICES)
      throw new WebPushHttpError(409, `Push notifications are already on for ${MOST_DEVICES} devices. Turn them off on one you no longer use, then try again.`);
    // The secret first, so a device row never exists without the secret it is sent with.
    await this.store.locker.set(this.owner, LOCKER_PROJECT, deviceSecret(input.endpoint), input.keys.auth);
    this.store.save("settings", this.owner, id, {
      endpoint: input.endpoint, p256dh: input.keys.p256dh, ...(input.language ? { language: input.language } : {}),
      createdAt: new Date().toISOString(),
    });
  }
  unsubscribe(endpoint: string): void {
    this.store.delete("settings", this.owner, subscriptionId(endpoint));
    this.store.locker.remove(this.owner, LOCKER_PROJECT, deviceSecret(endpoint));
  }
  private deviceRows(): { id: string; data: SavedDevice }[] {
    return this.store.list("settings", this.owner)
      .filter((row) => row.id.startsWith("push-sub:"))
      .map((row) => ({ id: row.id, data: row.data as unknown as SavedDevice }));
  }
  private async devices(): Promise<Device[]> {
    await this.migrate();
    const found: Device[] = [];
    for (const { data } of this.deviceRows()) {
      const name = deviceSecret(data.endpoint);
      // A row whose secret is gone cannot be sent to; it is skipped rather than guessed at.
      if (!this.store.locker.exists(this.owner, LOCKER_PROJECT, name)) continue;
      const auth = (await this.store.locker.resolve(this.owner, LOCKER_PROJECT, [name]))[name]!;
      found.push({ endpoint: data.endpoint, p256dh: data.p256dh, auth, language: data.language === "fr" ? "fr" : "en" });
    }
    return found;
  }

  /**
   * Wired as a `WebhookNotifier`. Only a top-level, non-isolated run the owner (or a channel
   * standing in for them) actually started gets a push — never a grader, a heartbeat check-in, a
   * delegated sub-task, or an evaluation's or a study's own task (`measured`). The devices here are
   * the owner's, so a household person's task, a lent conversation's and a short-lived key's never
   * reach them either: those words are somebody else's (the rule src/autonomy/origin.ts keeps).
   */
  notify(event: string, payload: Record<string, unknown>): void {
    if (event !== "run.completed" && event !== "run.failed") return;
    if (payload.top !== true || payload.isolated === true || payload.measured === true) return;
    if (!["owner", "channel"].includes(String(payload.source ?? "owner"))) return;
    if (payload.personProfileId || payload.lentTo || payload.shortLivedKey === true) return;
    // R17-S17's own rule (public/comfort.js): "This window only" means no OS-level notification
    // ever comes from this computer, and a push notification is exactly that, so it is skipped too.
    const notifySettings = readComfort(this.store, this.owner, "notify");
    if (notifySettings.method === "window") return;
    const runId = String(payload.runId ?? "");
    // What the owner asked shows on a lock screen only when they said it may.
    const prompt = notifySettings.lockScreenText && runId
      ? (this.store.run(runId)?.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 160) : "";
    const note: Note = { completed: payload.status === "completed", prompt, runId, sessionId: String(payload.sessionId ?? "") };
    void this.deliverAll(note).catch(() => undefined);
  }

  private async deliverAll(note: Note): Promise<void> {
    const queue = await this.devices();
    if (!queue.length) return;
    const vapidKey = await this.vapidKey();
    // A few devices at a time, each with its own time limit, so one that never answers holds up nobody.
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await this.deliverOne(next, vapidKey, pushMessage(note, next.language));
    };
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, queue.length) }, worker));
  }

  private async deliverOne(subscription: PushSubscription, vapidKey: StoredEcKey, body: Buffer): Promise<void> {
    try {
      await this.policy.assertAllowed(new URL(subscription.endpoint), "push address");
      if (lockedDown(this.store, this.owner)) return;
      const signal = AbortSignal.timeout(this.sendTimeoutMs);
      const response = await sendWebPush(this.fetchImpl, subscription, vapidKey, body, { signal });
      // RFC 8030 §7: the push service says the subscription is gone; keeping it would just fail again.
      if (response.status === 404 || response.status === 410) this.unsubscribe(subscription.endpoint);
    } catch {
      /* one device unreachable, slow, redirecting, or refused by the owner's network settings never disturbs the run that finished, or the next device */
    }
  }
}

/** What one device is shown, in its own language; the task's own words only when the owner allowed them. */
export function pushMessage(note: Note, language: Language): Buffer {
  const words = loadWords(language);
  const title = note.completed ? words.t("push.note.finishedTitle", "Task finished") : words.t("push.note.failedTitle", "Task needs attention");
  const generic = note.completed ? words.t("push.note.finishedBody", "A task finished.") : words.t("push.note.failedBody", "A task did not finish.");
  return Buffer.from(JSON.stringify({
    title, body: note.prompt || generic, tag: note.runId || "branch-task", runId: note.runId, sessionId: note.sessionId,
  }));
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
    return { key: await deps.webPush.vapidPublicKey() };
  }
  if (path === "/api/push/subscribe") {
    if (deps.method !== "POST") throw new WebPushHttpError(405, "Use POST");
    const parsed = SubscribeSchema.safeParse(await deps.readBody());
    if (!parsed.success) throw new WebPushHttpError(400, "That is not a push subscription.");
    await deps.webPush.subscribe(parsed.data);
    return { subscribed: true };
  }
  // /api/push/unsubscribe
  if (deps.method !== "POST") throw new WebPushHttpError(405, "Use POST");
  const body = z.object({ endpoint: z.string().max(2000) }).safeParse(await deps.readBody());
  if (!body.success) throw new WebPushHttpError(400, "That is not a push endpoint.");
  deps.webPush.unsubscribe(body.data.endpoint);
  return { unsubscribed: true };
}
