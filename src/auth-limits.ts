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
  /**
   * The most senders counted at once. Each sender gets its own entry so that one of them waiting
   * never makes another wait (see `webhookLimitKey`), and a sender is whatever the caller posted
   * to, so the number of them is not the owner's to decide. The oldest entry is dropped when this
   * is passed, which can only ever end a wait early and never start one: buying five fresh tries
   * on one address costs a guesser this many tries on other addresses first.
   */
  maxEntries?: number;
}

export class AuthLimiter {
  private readonly sources = new Map<string, { failures: number; until: number; last: number }>();
  readonly attempts: number;
  readonly lockoutMs: number;
  readonly windowMs: number;
  readonly maxEntries: number;
  constructor(options: AuthLimitOptions = {}) {
    this.attempts = options.attempts ?? 5;
    this.lockoutMs = options.lockoutMs ?? 5 * 60 * 1000;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 2048;
  }
  private entry(source: string, now: number): { failures: number; until: number; last: number } {
    const found = this.sources.get(source);
    if (found && now - found.last <= this.windowMs) return found;
    const fresh = { failures: 0, until: 0, last: now };
    this.sources.set(source, fresh);
    this.forget(now);
    return fresh;
  }
  /**
   * Keeps the count of senders from growing without end. Anything older than the window is gone
   * anyway, so it goes first; if that is not enough, the least recently seen go until the list
   * fits. Dropping an entry can only drop a wait, never make one, so this cannot shut anybody out.
   */
  private forget(now: number): void {
    if (this.sources.size <= this.maxEntries) return;
    for (const [key, entry] of this.sources)
      if (now - entry.last > this.windowMs) this.sources.delete(key);
    if (this.sources.size <= this.maxEntries) return;
    const oldestFirst = [...this.sources].sort((a, b) => a[1].last - b[1].last);
    for (const [key] of oldestFirst.slice(0, this.sources.size - this.maxEntries)) this.sources.delete(key);
  }
  /** Every sender waiting right now, so the owner can be shown who is being turned away. */
  waiting(now = Date.now()): { source: string; until: number }[] {
    return [...this.sources].filter(([, entry]) => entry.until > now).map(([source, entry]) => ({ source, until: entry.until }));
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
 *
 * `about` says who the owner should read this as. The counting key may be a made-up thing —
 * "tunnel|chat:telegram" — which is right for keeping senders apart and wrong for a line a person
 * reads, so a caller that has a better name for the sender passes one.
 */
export function noteAuthFailure(
  limiter: AuthLimiter, store: Store, owner: string, source: string, what: string, now = Date.now(),
  about: { actor?: string; subject?: string } = {},
): LockoutState {
  const state = limiter.fail(source, now);
  if (state.until === now + limiter.lockoutMs)
    audit(store, owner, {
      action: "auth.refused", actor: about.actor ?? source, subject: about.subject ?? `${what} from ${source}`,
      reason: `${state.failures} wrong tries in a row; further tries are refused for ${Math.round(limiter.lockoutMs / 60000)} minute(s)`,
      source: "system", outcome: "refused",
    });
  return state;
}

/** The name given to everything the webhook door passes on, as one place among the counted ones. */
export const tunnelSource = "tunnel";
const loopback = (address: string): boolean =>
  address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");

/**
 * Which place a request came from, for counting wrong tries: the address the connection itself came
 * from, or "local" when there is none. Only the real connection counts. A header such as
 * `x-forwarded-for` is whatever the caller typed into it, so trusting it would let one guesser look
 * like a thousand different places and never be made to wait. Branch has no proxy in front of it:
 * the app's own listener is on this computer and the phone's listener is on the private network, so
 * in both cases the connection's own address is the true one.
 *
 * mac7/lockout: the webhook door (src/personal/tunnel.ts) connects from this computer but carries
 * the internet, so what it passes on is counted under its own name. The door always sets the mark
 * and drops one a caller sent — and the mark is only believed on a connection from this computer,
 * which is the only place the door can dial from. Somebody on the private network who writes the
 * mark onto their own request is counted under their own address instead, so the mark can never be
 * used to drop a request into somebody else's count.
 */
export function requestSource(remoteAddress: string | undefined | null, headers: Record<string, unknown> = {}): string {
  const address = (remoteAddress || "local").toLowerCase();
  if (headers[tunnelMark] !== undefined && loopback(address)) return tunnelSource;
  return (remoteAddress || "local").replace(/^::ffff:/, "").slice(0, 60);
}
/** The header the webhook door puts on everything it passes on. */
export const tunnelMark = "x-branch-tunnel";

/**
 * Who a webhook post is counted as, so that one chat service cannot make the others wait.
 *
 * Before this, everything arriving through the webhook door was counted as one sender called
 * "tunnel" — every chat service on the internet sharing a single five-minute wait. One service
 * retrying an address the owner had replaced, which happens by itself with nobody attacking, put
 * that one entry into a wait that turned away correctly addressed messages from every other
 * service. The owner's messages stopped arriving and nothing said why.
 *
 * So a sender is now **the place the connection came from, and the service the address names**.
 * Neither half is a header: the first is the connection's own address (or "tunnel", believed only
 * from this computer), and the second is the name in the path, which is the thing being posted to
 * rather than a claim about the poster. A stranger can post to somebody else's name — that is what
 * a name in an address is — but a wrong address can never turn away a right one, because a caller
 * that shows the word on the end of the address is not made to wait at all (`src/server.ts`).
 *
 * `proven` keeps the two apart for a second reason: a service that has proved the address and then
 * fails its signature must not leave a wait behind that an unproven caller could feel, or the 429
 * would say "a service really is connected under this name".
 */
export function webhookLimitKey(source: string, kind: string, channel: string, proven = false): string {
  return `${source}|${kind}:${channel.slice(0, 40)}${proven ? "|proven" : ""}`;
}
