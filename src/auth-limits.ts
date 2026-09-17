import { audit } from "./audit.js";
import type { Store } from "./store.js";

/**
 * How many times in a row a wrong key, PIN or pairing code may be tried from one place before that
 * place is made to wait. It protects the local key, the phone PIN and the pairing code from being
 * guessed by something running on this computer or reachable over the private network. A correct
 * answer clears the count at once, so a person who mistypes twice is never held up.
 */
export interface LockoutState {
  /** Wrong tries counted so far for this source. */
  failures: number;
  /** When the wait ends, or null when nothing is waiting. */
  until: number | null;
}

export interface AuthLimitOptions {
  /** Wrong tries allowed before the wait starts. */
  attempts?: number;
  /** How long the wait lasts, in milliseconds. */
  lockoutMs?: number;
  /** How long a run of wrong tries is remembered when nothing else happens. */
  windowMs?: number;
}

export class AuthLimiter {
  private readonly sources = new Map<string, { failures: number; until: number; last: number }>();
  readonly attempts: number;
  readonly lockoutMs: number;
  readonly windowMs: number;
  constructor(options: AuthLimitOptions = {}) {
    this.attempts = options.attempts ?? 5;
    this.lockoutMs = options.lockoutMs ?? 5 * 60 * 1000;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
  }
  private entry(source: string, now: number): { failures: number; until: number; last: number } {
    const found = this.sources.get(source);
    if (found && now - found.last <= this.windowMs) return found;
    const fresh = { failures: 0, until: 0, last: now };
    this.sources.set(source, fresh);
    return fresh;
  }
  /** How long this source must wait before another try counts; 0 when it may try now. */
  waitMs(source: string, now = Date.now()): number {
    return Math.max(0, this.entry(source, now).until - now);
  }
  /** The plain-language refusal for a source that is waiting, or null when it may try. */
  refusal(source: string, what = "key", now = Date.now()): string | null {
    const wait = this.waitMs(source, now);
    if (wait <= 0) return null;
    return `Too many wrong tries. Wait ${Math.ceil(wait / 60000)} minute(s) before entering the ${what} again.`;
  }
  /** Counts one wrong try; returns the state, with `until` set once the wait has started. */
  fail(source: string, now = Date.now()): LockoutState {
    const entry = this.entry(source, now);
    entry.failures += 1;
    entry.last = now;
    if (entry.failures >= this.attempts) entry.until = now + this.lockoutMs;
    return { failures: entry.failures, until: entry.until || null };
  }
  /** A correct answer: the count goes back to nothing straight away. */
  succeed(source: string): void {
    this.sources.delete(source);
  }
}

/**
 * Counts one wrong try and, when that starts a wait, writes it into the record of what the
 * assistant was allowed to do, so the owner can see that someone was guessing.
 */
export function noteAuthFailure(
  limiter: AuthLimiter, store: Store, owner: string, source: string, what: string, now = Date.now(),
): LockoutState {
  const state = limiter.fail(source, now);
  if (state.until === now + limiter.lockoutMs)
    audit(store, owner, {
      action: "auth.refused", actor: source, subject: `${what} from ${source}`,
      reason: `${state.failures} wrong tries in a row; further tries are refused for ${Math.round(limiter.lockoutMs / 60000)} minute(s)`,
      source: "system", outcome: "refused",
    });
  return state;
}

/**
 * Which place a request came from, for counting wrong tries: the address the connection itself came
 * from, or "local" when there is none. Only the real connection counts. A header such as
 * `x-forwarded-for` is whatever the caller typed into it, so trusting it would let one guesser look
 * like a thousand different places and never be made to wait. Branch has no proxy in front of it:
 * the app's own listener is on this computer and the phone's listener is on the private network, so
 * in both cases the connection's own address is the true one.
 */
export function requestSource(remoteAddress: string | undefined | null, headers: Record<string, unknown> = {}): string {
  // R17-C integration review: the webhook door (src/personal/tunnel.ts) connects from this computer but
  // carries the internet, so what it passes on is counted on its own. The door always sets this mark
  // and drops one a caller sent; anything else sending it only puts itself in that stricter place.
  if (headers[tunnelMark] !== undefined) return "tunnel";
  return (remoteAddress || "local").replace(/^::ffff:/, "").slice(0, 60);
}
/** The header the webhook door puts on everything it passes on. */
export const tunnelMark = "x-branch-tunnel";
