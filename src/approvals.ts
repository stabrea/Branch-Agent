import { errorText } from "./contracts.js";
import type { PolicyRemember, RunSource } from "./policy.js";
import type { SandboxChoice } from "./sandbox.js";

/**
 * The runtime side of the approval policy: the questions a paused task is waiting on, the answers
 * remembered for the rest of a conversation, the per-conversation pace limits, and the two small
 * guardrails that go with them (a dry run's simulated results, and a warning when a file the
 * assistant just wrote is not valid JSON after all).
 */
export interface PendingApproval {
  runId: string;
  sessionId: string;
  tool: string;
  target: string;
  /** What is about to happen, in plain language. */
  label: string;
  question: string;
  source: RunSource;
  /** What the rule suggests remembering if the person says yes. */
  remember: PolicyRemember;
  /** How tightly the rule wants the program held, when it said; shown on the card before the yes. */
  sandbox?: SandboxChoice;
  askedAt: string;
  /**
   * The exact bytes of the request, with saved passwords and keys taken out, as shown on screen,
   * and a fingerprint of them. A yes is bound to that fingerprint: change the command and the
   * assistant has to ask again.
   */
  bytes?: string;
  fingerprint?: string;
}

/** A yes kept for the rest of a conversation, and when it stops counting. */
export interface SessionGrant {
  tool: string;
  target: string;
  decision: "allow" | "deny";
  /** The request this answer was given for; null when it was given without one. */
  fingerprint: string | null;
  grantedAt: string;
  expiresAt: string;
  /** Plain words for the "What is allowed right now" list. */
  label: string;
}

/** How long a "yes, for this conversation" lasts unless the conversation ends or Branch locks first. */
export const sessionGrantMs = 60 * 60 * 1000;

const answerKey = (tool: string, target: string): string => `${tool}\u0000${target}`;

/**
 * Whether two questions are the same one. The fingerprint of the exact bytes is what says so; two
 * questions with neither fingerprint fall back to the tool and what it is about, which is what a
 * question with no exact bytes was ever known by.
 */
const sameQuestion = (a: PendingApproval, b: PendingApproval): boolean =>
  a.fingerprint !== undefined || b.fingerprint !== undefined
    ? a.fingerprint === b.fingerprint
    : a.tool === b.tool && a.target === b.target;

/** The refusal a "deny" rule gives back, in the one wording the whole app uses. */
export const refusedByPolicy = (label: string): string =>
  `Your settings do not allow this: ${label}. Tell the person what you wanted to do, and why.`;
/** The question a tool call that needs a yes is put as, in the one wording the whole app uses. */
export const approvalQuestion = (label: string, target: string): string =>
  `Before I go ahead: ${label}${target ? " (" + target + ")" : ""}. Is that all right?`;

/**
 * Raised when something that is not a model's turn — a saved workflow's tool step, a step of a
 * procedure being replayed — reaches a tool the approval policy says to ask about first. Whoever
 * called decides how the question is put: a conversation pauses, a workflow stops where it is.
 */
/** Raised in the same places when the settings refuse the tool outright: trying again cannot help. */
export class PolicyRefusedError extends Error {
  override name = "PolicyRefusedError";
  constructor(readonly tool: string, readonly label: string) {
    super(refusedByPolicy(label));
  }
}

export class ApprovalRequiredError extends Error {
  override name = "ApprovalRequiredError";
  constructor(
    readonly tool: string,
    readonly target: string,
    readonly label: string,
    readonly remember: PolicyRemember = "session",
    /**
     * The fingerprint of the exact bytes the step asked for. A yes given later is bound to it, so a
     * saved step whose arguments changed in between is asked about again rather than let past.
     */
    readonly fingerprint?: string,
  ) {
    super(approvalQuestion(label, target));
  }
}

/**
 * How many questions one conversation may have waiting at once. A conversation that has stopped on
 * eight things the person has not looked at yet is not one more question away from being useful, so
 * the ninth is refused outright rather than quietly pushing the oldest out of the list.
 */
export const maximumPendingPerSession = 8;
/** What the task whose question was let go is told, in one sentence and no jargon. */
export const droppedPendingMessage = (label: string): string =>
  `This conversation had ${maximumPendingPerSession} questions waiting for an answer, so the one that `
  + `had been waiting longest was let go rather than kept for ever: ${label}. Nothing was done. `
  + "Ask again if you still want it.";

export class ApprovalGate {
  private readonly answers = new Map<string, Map<string, SessionGrant>>();
  /**
   * The questions each conversation is waiting on, oldest first. It is a list rather than a single
   * question because two things can genuinely be asked at once — a conversation running two tools
   * side by side, or one AI-tool connection making two calls — and the second must not silently
   * take the place of the first, leaving the first waiting on an answer that can never arrive.
   * Within one conversation a question is known by its fingerprint: the same exact request asked
   * twice is the same question, so it replaces rather than piles up.
   */
  private readonly pending = new Map<string, PendingApproval[]>();
  /**
   * The answer already given in this conversation for the same tool and target. When a fingerprint
   * is supplied and the kept answer was given for a different one, there is no answer: the exact
   * bytes changed, so the person is asked again.
   */
  answer(sessionId: string, tool: string, target: string, fingerprint?: string): "allow" | "deny" | undefined {
    const key = answerKey(tool, target);
    const grant = this.answers.get(sessionId)?.get(key);
    if (!grant) return undefined;
    if (Date.parse(grant.expiresAt) <= Date.now()) { this.answers.get(sessionId)?.delete(key); return undefined; }
    if (grant.fingerprint && fingerprint !== undefined && grant.fingerprint !== fingerprint) return undefined;
    return grant.decision;
  }
  /** Keeps an answer for the rest of the conversation, bound to the request it was given for. */
  remember(
    sessionId: string, tool: string, target: string, decision: "allow" | "deny",
    about: { fingerprint?: string | undefined; label?: string | undefined } = {},
  ): void {
    const forSession = this.answers.get(sessionId) ?? new Map<string, SessionGrant>();
    const now = Date.now();
    forSession.set(answerKey(tool, target), {
      tool, target, decision, fingerprint: about.fingerprint ?? null,
      grantedAt: new Date(now).toISOString(), expiresAt: new Date(now + sessionGrantMs).toISOString(),
      label: about.label ?? `${tool}${target ? ` on ${target}` : ""}`,
    });
    this.answers.set(sessionId, forSession);
  }
  /** What this conversation is allowed to do right now, for the "What is allowed" list. */
  grants(sessionId: string): SessionGrant[] {
    const forSession = this.answers.get(sessionId);
    if (!forSession) return [];
    const now = Date.now();
    for (const [key, grant] of forSession) if (Date.parse(grant.expiresAt) <= now) forSession.delete(key);
    return [...forSession.values()].sort((a, b) => a.grantedAt.localeCompare(b.grantedAt));
  }
  /**
   * Takes one remembered yes back. The conversation asks again the next time that tool wants that
   * thing, which is what the "Take this back" button beside it does.
   */
  revoke(sessionId: string, tool: string, target: string): boolean {
    return this.answers.get(sessionId)?.delete(answerKey(tool, target)) === true;
  }
  /** Ends every standing yes, in every conversation: what "Lock" does. */
  forgetAll(): number {
    const count = [...this.answers.values()].reduce((total, forSession) => total + forSession.size, 0);
    this.answers.clear();
    return count;
  }
  /**
   * Records a question a task stopped on. Asking the same exact request again replaces the question
   * already there rather than adding a second copy of it; anything else joins the end of the list.
   * When the list is already as long as it may be, the one that has been waiting longest is let go
   * and handed back, so whoever called can tell that task plainly rather than leave it waiting on
   * an answer that will never come.
   */
  ask(request: PendingApproval): PendingApproval | null {
    const forSession = this.pending.get(request.sessionId) ?? [];
    this.pending.set(request.sessionId, forSession);
    const same = forSession.findIndex((entry) => sameQuestion(entry, request));
    if (same >= 0) { forSession[same] = request; return null; }
    const dropped = forSession.length >= maximumPendingPerSession ? forSession.shift() ?? null : null;
    forSession.push(request);
    return dropped;
  }
  /** How many more questions this conversation may be asked before it is full. */
  roomToAsk(sessionId: string): number {
    return Math.max(0, maximumPendingPerSession - (this.pending.get(sessionId)?.length ?? 0));
  }
  /** Questions still waiting for an answer, oldest first. */
  waiting(sessionId?: string): PendingApproval[] {
    if (sessionId) return [...(this.pending.get(sessionId) ?? [])];
    return [...this.pending.values()].flat();
  }
  /**
   * Takes one question off a conversation's list, so it can be answered once. With a fingerprint it
   * is that exact request; without one, and with only a single question waiting, it is that one —
   * which is every older caller, and is why they all still work. Without one and with several
   * waiting it is the oldest, because that is the one that has been kept waiting longest.
   */
  resolve(sessionId: string, fingerprint?: string): PendingApproval | undefined {
    const forSession = this.pending.get(sessionId);
    if (!forSession?.length) return undefined;
    const at = fingerprint === undefined ? 0 : forSession.findIndex((entry) => entry.fingerprint === fingerprint);
    if (at < 0) return undefined;
    const [taken] = forSession.splice(at, 1);
    if (!forSession.length) this.pending.delete(sessionId);
    return taken;
  }
  /**
   * The question an answer is for: the one with that fingerprint, or — when none was given — the
   * oldest one still waiting. Looked at without taking it off the list, so whoever is answering can
   * check it over before saying yes.
   */
  questionFor(sessionId: string, fingerprint?: string): PendingApproval | undefined {
    const forSession = this.pending.get(sessionId) ?? [];
    return fingerprint === undefined ? forSession[0] : forSession.find((entry) => entry.fingerprint === fingerprint);
  }
  /** Forgets everything remembered for a conversation. */
  forget(sessionId: string): void {
    this.answers.delete(sessionId);
    this.pending.delete(sessionId);
  }
}

/** A sliding window counter: how many events a key may have inside the window. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(readonly windowMs = 60000) {}
  private recent(key: string, now: number): number[] {
    const times = (this.hits.get(key) ?? []).filter((at) => at > now - this.windowMs);
    this.hits.set(key, times);
    return times;
  }
  /** How long to wait before one more event fits inside the window; 0 when it fits right now. */
  waitMs(key: string, limit: number, now = Date.now()): number {
    if (limit <= 0) return 0;
    const times = this.recent(key, now);
    if (times.length < limit) return 0;
    return Math.max(1, times[times.length - limit]! + this.windowMs - now);
  }
  record(key: string, now = Date.now()): void {
    this.recent(key, now).push(now);
  }
}

/** Waits, unless the task is stopped first. */
export function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** What a tool returns in a dry run: nothing happened, and this is what would have. */
export function simulatedResult(label: string): { ok: true; simulated: true; result: string } {
  return { ok: true, simulated: true, result: `Nothing was done: this is a practice run. For real, this would have: ${label}.` };
}

/** After writing a .json file, the problem with it if it is not valid JSON after all, otherwise null. */
export async function jsonWriteProblem(
  read: (path: string) => Promise<{ content: string }>,
  path: string,
): Promise<string | null> {
  if (!/\.json$/i.test(path)) return null;
  let content: string;
  try { content = (await read(path)).content; } catch { return null; }
  try { JSON.parse(content); return null; } catch (error) { return errorText(error); }
}
