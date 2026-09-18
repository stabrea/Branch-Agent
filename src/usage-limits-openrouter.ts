import { z } from "zod";
import { isOpenRouterEndpoint } from "./model-savings/openrouter.js";
import type { LimitWindow, PolledReading } from "./usage-limits.js";

/**
 * mac7/usage-bar: the one source Branch ever asks a question of, and the only one it ever will
 * without a new decision.
 *
 * OpenRouter documents `GET /api/v1/key`: with the ordinary key the owner already gave Branch, it
 * answers how much of that key's allowance is left. That is the whole reason it is here — exactly
 * one provider in this space lets Branch find out before spending, and it says so in its own
 * published reference.
 *
 * **Never a plan account.** A subscription's allowance is spent by the act of asking about it, so a
 * probe would consume the very thing it measures. That is not a preference; `askable()` below will
 * not return an address for a sign-in pool at all, so no plan account can reach the fetch.
 *
 * Nothing is asked at start-up, nothing is asked while the owner is not looking, and a refusal from
 * this bookkeeping call is never written into `ProviderHealth` — a connection doing real work
 * perfectly well must not be made to look sick by a question about its accounting.
 */

const KeySchema = z.object({
  data: z.object({
    label: z.string().optional(),
    usage: z.number().nullable().optional(),
    limit: z.number().nullable().optional(),
    limit_remaining: z.number().nullable().optional(),
    limit_reset: z.string().nullable().optional(),
    is_free_tier: z.boolean().optional(),
    free_model_daily_requests: z.object({
      used: z.number().nullable().optional(),
      limit: z.number().nullable().optional(),
      remaining: z.number().nullable().optional(),
    }).optional(),
  }),
});

/** Where a connection's key allowance may be asked for, or null when it may never be asked. */
export function askable(preset: {
  id: string;
  provider: { audio?: () => { endpoint: string; apiKey: string } | null };
}, poolKind: string | null): { url: string; apiKey: string } | null {
  /* A sign-in pool is refused here, before anything else, so a plan account cannot be polled. */
  if (poolKind !== null && poolKind !== "api-key") return null;
  let route: { endpoint: string; apiKey: string } | null = null;
  try { route = preset.provider.audio?.() ?? null; } catch { return null; }
  if (!route || !route.apiKey || !isOpenRouterEndpoint(route.endpoint)) return null;
  return { url: new URL("/api/v1/key", route.endpoint).toString(), apiKey: route.apiKey };
}

/** OpenRouter's documented answer, turned into rows. Credits are money, so never a share. */
export function windowsFromKey(body: unknown, now: number): LimitWindow[] {
  const parsed = KeySchema.safeParse(body);
  if (!parsed.success) return [];
  const data = parsed.data.data;
  const at = new Date(now).toISOString();
  const from = "from OpenRouter's documented key endpoint";
  const windows: LimitWindow[] = [];
  if (data.limit !== null && data.limit !== undefined)
    windows.push({ id: "credits", title: "Credit on this key", kind: "money", limit: data.limit,
      remaining: data.limit_remaining ?? null, resetAt: data.limit_reset ?? null,
      measuredAt: at, state: "measured", from });
  const free = data.free_model_daily_requests;
  if (free && (free.limit ?? null) !== null)
    windows.push({ id: "free-daily", title: "Free models today", kind: "requests", limit: free.limit ?? null,
      remaining: free.remaining ?? null, resetAt: null, measuredAt: at, state: "measured", from });
  return windows;
}

/** How long to wait before asking again, from the same few signals CodexBar uses and no others. */
export function nextDelayMs(input: { panelOpenedAgoMs: number | null; workingAgoMs: number | null; onBattery: boolean }): number {
  if (input.onBattery) return 30 * 60_000;
  const opened = input.panelOpenedAgoMs;
  if (opened !== null && opened <= 5 * 60_000) return 2 * 60_000;
  if (opened !== null && opened <= 60 * 60_000) return 5 * 60_000;
  if (input.workingAgoMs !== null && input.workingAgoMs <= 5 * 60_000) return 5 * 60_000;
  if (opened !== null && opened <= 4 * 60 * 60_000) return 15 * 60_000;
  return 30 * 60_000;
}

/** After a refusal: the service's own Retry-After, else a minute doubling to an hour, with jitter. */
export function backoffMs(attempt: number, retryAfterMs: number | null, jitter = Math.random): number {
  if (retryAfterMs !== null && retryAfterMs > 0) return Math.min(retryAfterMs, 60 * 60_000);
  const step = Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 60 * 60_000);
  return Math.round(step * (0.8 + 0.4 * jitter()));
}

export interface KeyReaderDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * What the last ask found, per connection, kept in memory with the time it was read. A restart
 * starts empty on purpose: "last seen two hours ago" is honest, and showing a number from before
 * the restart as if it were current is not.
 */
export class OpenRouterKeyReader {
  private readonly last = new Map<string, PolledReading & { at: number }>();
  private readonly waitingUntil = new Map<string, number>();
  private readonly attempts = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  constructor(private readonly deps: KeyReaderDeps = {}) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** True when enough time has passed to ask again. Nothing is ever asked at start-up but this. */
  due(connection: string, delayMs: number): boolean {
    const found = this.last.get(connection);
    return found === undefined || this.now() - found.at >= delayMs;
  }

  /** What was last read for this connection, with its real age. Null until something was read. */
  reading(connection: string): PolledReading | null {
    const found = this.last.get(connection);
    return found ? { windows: found.windows, note: found.note } : null;
  }

  /**
   * Ask, once, for one connection. Returns false without touching the network when the connection
   * may not be asked, when a refusal's wait is not over, or when an ask is already in flight.
   */
  async refresh(connection: string, target: { url: string; apiKey: string } | null): Promise<boolean> {
    if (!target || this.inFlight.has(connection)) return false;
    const now = this.now();
    if ((this.waitingUntil.get(connection) ?? 0) > now) return false;
    this.inFlight.add(connection);
    try {
      const call = this.deps.fetchImpl ?? globalThis.fetch;
      const response = await call(target.url, { headers: { authorization: `Bearer ${target.apiKey}` } });
      if (!response.ok) { this.holdOff(connection, response); return false; }
      const windows = windowsFromKey(await response.json(), this.now());
      this.attempts.delete(connection);
      this.waitingUntil.delete(connection);
      this.last.set(connection, { windows, note: windows.length ? "" : "OpenRouter answered, but said nothing about a limit on this key.", at: this.now() });
      return true;
    } catch {
      this.holdOff(connection, null);
      return false;
    } finally { this.inFlight.delete(connection); }
  }

  /** A refusal keeps the last reading with its real age and says why it could not be refreshed. */
  private holdOff(connection: string, response: Response | null): void {
    const attempt = (this.attempts.get(connection) ?? 0) + 1;
    this.attempts.set(connection, attempt);
    const header = response?.headers.get("retry-after");
    const wait = backoffMs(attempt, header !== null && header !== undefined && Number.isFinite(Number(header)) ? Number(header) * 1000 : null);
    this.waitingUntil.set(connection, this.now() + wait);
    const found = this.last.get(connection);
    const why = response?.status === 429
      ? "could not refresh — the service asked us to wait"
      : "could not refresh just now; this is the last reading";
    if (found) this.last.set(connection, { ...found, note: why });
  }
}
