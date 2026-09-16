import { errorText } from "./contracts.js";

/**
 * How each model connection has actually been behaving: when it last answered, how long it took,
 * what it last complained about, and how close it is to the limit the service imposes. Everything
 * here is recorded from real calls, never guessed, so the screen can say "this one is struggling"
 * with something behind it.
 */
export interface RateLimitReading {
  /** Requests or tokens the service allows in the current window, when it says. */
  limit: number | null;
  remaining: number | null;
  /** Seconds until the allowance refills, when the service says. */
  resetSeconds: number | null;
}
export interface ConnectionHealth {
  id: string;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastStatus: number | null;
  /** How long the last answer took, in milliseconds. */
  latencyMs: number | null;
  consecutiveFailures: number;
  rateLimit: RateLimitReading | null;
  /** One sentence for the Settings card. */
  summary: string;
}

const empty = (id: string): ConnectionHealth => ({
  id, lastOkAt: null, lastErrorAt: null, lastError: null, lastStatus: null,
  latencyMs: null, consecutiveFailures: 0, rateLimit: null,
  summary: "Not used yet, so there is nothing to report.",
});

const numberFrom = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Number(value.replace(/s$/, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

/** The allowance a service reports, in whichever of the usual header spellings it uses. */
export function readRateLimit(headers: Headers): RateLimitReading | null {
  const pick = (...names: string[]): string | null => {
    for (const name of names) { const value = headers.get(name); if (value !== null) return value; }
    return null;
  };
  const limit = numberFrom(pick("x-ratelimit-limit-requests", "x-ratelimit-limit", "ratelimit-limit"));
  const remaining = numberFrom(pick("x-ratelimit-remaining-requests", "x-ratelimit-remaining", "ratelimit-remaining"));
  const reset = numberFrom(pick("x-ratelimit-reset-requests", "x-ratelimit-reset", "ratelimit-reset", "retry-after"));
  if (limit === null && remaining === null && reset === null) return null;
  return { limit, remaining, resetSeconds: reset };
}

export class ProviderHealth {
  private readonly records = new Map<string, ConnectionHealth>();
  constructor(private readonly now: () => number = Date.now, private readonly limit = 64) {}

  get(id: string): ConnectionHealth {
    return this.records.get(id) ?? empty(id);
  }
  list(): ConnectionHealth[] {
    return [...this.records.values()];
  }
  /** True when the last few calls all failed, which is what "this one is struggling" means. */
  failing(id: string): boolean {
    return this.get(id).consecutiveFailures > 0;
  }
  private put(record: ConnectionHealth): ConnectionHealth {
    if (!this.records.has(record.id) && this.records.size >= this.limit)
      this.records.delete(this.records.keys().next().value as string);
    this.records.set(record.id, record);
    return record;
  }
  recordSuccess(id: string, latencyMs: number, headers?: Headers): ConnectionHealth {
    const previous = this.get(id);
    return this.put({
      ...previous, id, latencyMs, consecutiveFailures: 0,
      lastOkAt: new Date(this.now()).toISOString(), lastStatus: 200,
      rateLimit: headers ? readRateLimit(headers) ?? previous.rateLimit : previous.rateLimit,
      summary: describe({ ...previous, latencyMs, consecutiveFailures: 0 }, true),
    });
  }
  recordFailure(id: string, error: unknown, latencyMs?: number, headers?: Headers): ConnectionHealth {
    const previous = this.get(id);
    const status = (error as { status?: number }).status ?? null;
    const record: ConnectionHealth = {
      ...previous, id,
      lastErrorAt: new Date(this.now()).toISOString(),
      lastError: errorText(error).slice(0, 200),
      lastStatus: typeof status === "number" ? status : null,
      latencyMs: latencyMs ?? previous.latencyMs,
      consecutiveFailures: previous.consecutiveFailures + 1,
      rateLimit: headers ? readRateLimit(headers) ?? previous.rateLimit : previous.rateLimit,
      summary: "",
    };
    return this.put({ ...record, summary: describe(record, false) });
  }
  /**
   * A fetch that writes down what happened on every call made through it. The connection's own
   * fetch is wrapped once when it is built, so nothing at the call sites has to remember to report.
   */
  watch(id: string, base: typeof fetch = globalThis.fetch): typeof fetch {
    const health = this;
    return async function watched(input: string | URL | Request, init?: RequestInit) {
      const started = Date.now();
      try {
        const response = await base(input, init);
        const took = Date.now() - started;
        if (response.ok) health.recordSuccess(id, took, response.headers);
        else health.recordFailure(id, Object.assign(new Error(`Provider HTTP ${response.status}`), { status: response.status }), took, response.headers);
        return response;
      } catch (error) {
        health.recordFailure(id, error, Date.now() - started);
        throw error;
      }
    } as typeof fetch;
  }
}

function describe(record: ConnectionHealth, ok: boolean): string {
  if (ok) {
    const speed = record.latencyMs === null ? "" : ` in ${Math.round(record.latencyMs)} ms`;
    return `Answered${speed} the last time it was used.`;
  }
  const times = record.consecutiveFailures === 1 ? "once" : `${record.consecutiveFailures} times in a row`;
  return `Has failed ${times}. Last complaint: ${record.lastError ?? "no reason given"}`;
}

/** The fallback sentence for the "why this model" line, when the first choice was skipped. */
export function fallbackReason(health: ProviderHealth, skipped: string[], chosen: string): string | null {
  if (!skipped.length) return null;
  const troubles = skipped.map((id) => `${id} (${health.get(id).lastError ?? "resting after a failure"})`);
  return `${troubles.join(", ")} ${skipped.length > 1 ? "were" : "was"} skipped, so ${chosen} took it`;
}
