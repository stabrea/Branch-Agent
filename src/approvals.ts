import { errorText } from "./contracts.js";
import type { PolicyRemember, RunSource } from "./policy.js";

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
  askedAt: string;
}

const answerKey = (tool: string, target: string): string => `${tool}\u0000${target}`;

export class ApprovalGate {
  private readonly answers = new Map<string, Map<string, "allow" | "deny">>();
  private readonly pending = new Map<string, PendingApproval>();
  /** The answer already given in this conversation for the same tool and target, if there is one. */
  answer(sessionId: string, tool: string, target: string): "allow" | "deny" | undefined {
    return this.answers.get(sessionId)?.get(answerKey(tool, target));
  }
  /** Keeps an answer for the rest of the conversation. */
  remember(sessionId: string, tool: string, target: string, decision: "allow" | "deny"): void {
    const forSession = this.answers.get(sessionId) ?? new Map<string, "allow" | "deny">();
    forSession.set(answerKey(tool, target), decision);
    this.answers.set(sessionId, forSession);
  }
  /** Records the question a task stopped on; one conversation waits on one question at a time. */
  ask(request: PendingApproval): void {
    this.pending.set(request.sessionId, request);
  }
  /** Questions still waiting for an answer, newest last. */
  waiting(sessionId?: string): PendingApproval[] {
    const all = [...this.pending.values()];
    return sessionId ? all.filter((entry) => entry.sessionId === sessionId) : all;
  }
  /** Takes the question a conversation is waiting on, so it can be answered once. */
  resolve(sessionId: string): PendingApproval | undefined {
    const waiting = this.pending.get(sessionId);
    this.pending.delete(sessionId);
    return waiting;
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
