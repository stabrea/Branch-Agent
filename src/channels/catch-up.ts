import type { InboundMessage } from "./router.js";

/**
 * mac6/bucket-16: where a chat app's stream was read up to, for the services whose place is a word
 * rather than a number (a Matrix `since` token, a Guilded message id, a Mastodon notification id).
 * Telegram keeps a number in src/never-break/channel-position.ts; this is the same idea for the rest.
 *
 * After a restart the saved place is handed back, so messages that arrived while Branch was closed
 * are fetched and answered once. A place older than `freshForMs` (a day by default) is ignored and
 * the service takes stock from now instead, so a computer switched off for a month does not answer
 * a month of old messages in one go.
 */
export interface ChannelMark {
  /** The saved place, or null when there is none or it is too old to trust. */
  load(): string | null;
  save(value: string): void;
}

interface SettingsStore {
  get(table: "settings", owner: string, id: string): { data: Record<string, unknown> } | undefined;
  save(table: "settings", owner: string, id: string, data: Record<string, unknown>): unknown;
}

export const defaultMarkFreshMs = 24 * 60 * 60_000;

export function channelMark(
  store: unknown, channelId: string, owner = "local",
  options: { freshForMs?: number; now?: () => number } = {},
): ChannelMark | undefined {
  const saved = store as Partial<SettingsStore> | null;
  if (typeof saved?.get !== "function" || typeof saved.save !== "function") return undefined;
  const settings = saved as SettingsStore;
  const key = `channel-mark:${channelId}`;
  const now = options.now ?? Date.now;
  const fresh = options.freshForMs ?? defaultMarkFreshMs;
  return {
    load: () => {
      const data = settings.get("settings", owner, key)?.data;
      const value = typeof data?.value === "string" ? data.value : "";
      const at = Date.parse(String(data?.savedAt ?? ""));
      if (!value || value.length > 2000 || !Number.isFinite(at) || now() - at > fresh) return null;
      return value;
    },
    save: (value) => {
      if (!value || value.length > 2000) return;
      try { settings.save("settings", owner, key, { value, savedAt: new Date(now()).toISOString() }); }
      catch { /* a place that is not saved only means a message may be missed or fetched again */ }
    },
  };
}

/**
 * Saves a place only once every message read before it has been handled, and never moves it
 * backwards, so a crash in the middle of an answer means that message is fetched again.
 */
export class MarkKeeper {
  private sequence = 0;
  private savedSequence = 0;
  private readonly batches = new Map<number, { value: string; done: boolean }>();
  constructor(private readonly mark: ChannelMark | null | undefined) {}
  get enabled(): boolean { return !!this.mark; }
  load(): string | null { return this.mark?.load() ?? null; }
  /** `value` is the place after this batch; `handling` settles when every message in it is answered. */
  after(value: string | null | undefined, handling: Promise<unknown>[]): Promise<void> {
    if (!this.mark || !value) return Promise.resolve();
    const sequence = ++this.sequence;
    this.batches.set(sequence, { value, done: false });
    return Promise.allSettled(handling).then(() => {
      this.batches.get(sequence)!.done = true;
      this.advance();
    });
  }
  /** Saves the newest place whose batch, and every batch before it, has been handled. */
  private advance(): void {
    let latest: string | null = null;
    for (let next = this.batches.get(this.savedSequence + 1); next?.done; next = this.batches.get(this.savedSequence + 1)) {
      this.batches.delete(++this.savedSequence);
      latest = next.value;
    }
    if (latest) this.mark?.save(latest);
  }
}

// ---- mac6/bucket-16 integration: a cap on catching up ------------------------------------------
/** At most this many messages that arrived while Branch was closed are answered after a restart. */
export const catchUpLimit = 20;

/**
 * The first batch fetched from a saved place: every message is marked as caught up (a stranger's is
 * then let go without a pairing code) and only the last `limit`, in the order the service gave
 * them, are kept.
 */
export function catchUpBatch(batch: InboundMessage[], limit = catchUpLimit): InboundMessage[] {
  return batch.slice(-limit).map((message) => ({ ...message, caughtUp: true }));
}

/**
 * For services that replay missed messages one by one over a socket (Guilded, KOOK): for a short
 * while after a resumed connection opens, messages count as caught up, and those past the limit
 * are let go.
 */
export class CatchUpWindow {
  private until = 0;
  private count = 0;
  constructor(private readonly limit = catchUpLimit, private readonly ms = 15_000, private readonly now: () => number = Date.now) {}
  open(): void { this.until = this.now() + this.ms; this.count = 0; }
  close(): void { this.until = 0; }
  /** The message as it should be handed on, or null when the cap has been reached. */
  pass(message: InboundMessage | null): InboundMessage | null {
    if (!message || !this.until || this.now() > this.until) return message;
    return ++this.count > this.limit ? null : { ...message, caughtUp: true };
  }
}
