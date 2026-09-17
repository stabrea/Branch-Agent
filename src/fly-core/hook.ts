import { createHash } from "node:crypto";
import type { Run } from "../contracts.js";
import type { Store } from "../store.js";
import { type ActionKind, type ActionUse, type Circuit, type Scored } from "./circuit.js";
import { Expansion, requestKind, type KenyonCode, type TaskContext } from "./encode.js";
import { correctionSignal, isCorrection, outcomeOf } from "./signals.js";
import { correctionTraceMinutes } from "./sizes.js";
import { flyCoreSettings } from "./settings.js";
import { FlyState } from "./state.js";

/**
 * Branch's learning core, as the runtime sees it: when a task starts, it ranks what has worked in
 * situations like this one; when the task ends, it learns from how it went.
 *
 * It follows the owner's three-way switch (settings.ts), which ships off. Version 1 gives advice
 * only. With the switch on, the ranking is written on the task as a `fly.suggested` event; a
 * pattern of steps that keeps working is offered as a skill idea in the owner's existing review
 * queue; nothing is changed without the owner. See experiments/fly-core for how well it learns.
 */
export interface Suggestion { name: string; score: number }
export interface Suggestions { tools: Suggestion[]; skills: Suggestion[]; memories: Suggestion[]; avoid: Suggestion[] }
export interface MemoryAdvice { strengthen: string[]; fade: string[] }

/** How many of each kind are suggested, and how clear a score must be to count. */
export const suggestionLimit = 5;
export const clearScore = 0.05;
/** A pattern of steps is offered as a skill after this many successes, at this success rate. */
export const patternSuccesses = 3;
export const patternSuccessRate = 0.8;
/** Evidence needed before a memory is called helpful or unhelpful. */
export const memoryUsesNeeded = 3;

const wirings = new Map<string, Expansion>();
const round = (value: number): number => Math.round(value * 1000) / 1000;
const named = (list: readonly Scored[]): Suggestion[] => list.map((s) => ({ name: s.action, score: round(s.score) }));

export class FlyCore {
  readonly state: FlyState;
  constructor(private readonly store: Store, private readonly now: () => number = () => Date.now()) {
    this.state = new FlyState(store.sqlite);
  }
  private wiring(owner: string): Expansion {
    const seed = this.state.seed(owner);
    let found = wirings.get(seed);
    if (!found) { found = new Expansion(seed); wirings.set(seed, found); }
    return found;
  }
  /** The Kenyon-cell code for a task's starting situation. */
  code(owner: string, context: TaskContext): KenyonCode {
    return this.wiring(owner).code(context);
  }
  /** What has worked, and what has not, in situations like this one. */
  suggest(owner: string, code: KenyonCode, circuit: Circuit = this.state.load(owner)): Suggestions {
    const now = this.now(), all: Scored[] = [];
    const pick = (kind: ActionKind): Suggestion[] => {
      const ranked = circuit.rank(code, kind, now);
      all.push(...ranked);
      return named(ranked.filter((s) => s.score >= clearScore).slice(0, suggestionLimit));
    };
    const result = { tools: pick("tool"), skills: pick("skill"), memories: pick("memory") };
    const avoid = all.filter((s) => s.score <= -clearScore).sort((a, b) => a.score - b.score).slice(0, suggestionLimit);
    return { ...result, avoid: avoid.map((s) => ({ name: `${s.kind}:${s.action}`, score: round(s.score) })) };
  }
  /** A correction at the start of a task punishes what the previous task in the conversation did. */
  applyCorrection(owner: string, sessionId: string): boolean {
    const trace = this.state.takeLastTrace(owner, sessionId);
    if (!trace || !trace.uses.length) return false;
    const now = this.now(), age = Math.max(0, now - trace.at);
    const scale = Math.exp(-age / (correctionTraceMinutes * 60_000));
    const circuit = this.state.load(owner);
    this.state.save(owner, circuit.learn(trace.code, trace.uses, correctionSignal, now, scale));
    return true;
  }
  /** Learns from a finished task and returns what it learned, in plain terms. */
  learn(owner: string, run: Run, code: KenyonCode): { signal: number; reasons: string[]; actions: number } {
    const usage = this.store.usage(run.id);
    const tokens = (usage.reportedInput || usage.estimatedInput || 0) + (usage.reportedOutput || usage.estimatedOutput || 0);
    const events = this.store.events(run.id);
    const outcome = outcomeOf(run.status, events, tokens);
    if (outcome.uses.length && outcome.signal !== 0) {
      const circuit = this.state.load(owner);
      this.state.save(owner, circuit.learn(code, outcome.uses, outcome.signal, this.now()));
      if (run.status === "completed" || run.status === "failed") this.notePattern(owner, run, code, outcome.uses, circuit);
    }
    this.state.saveTrace(owner, { runId: run.id, sessionId: run.sessionId, code, uses: outcome.uses, at: this.now() });
    return { signal: round(outcome.signal), reasons: outcome.reasons, actions: outcome.uses.length };
  }
  /**
   * Counts a pattern of steps (the tools a task used without failure, for its kind of request)
   * and, once it has kept working, offers it as a skill idea in the review queue. Accepting that
   * idea only notes it in v1; the owner makes the skill.
   */
  private notePattern(owner: string, run: Run, code: KenyonCode, uses: readonly ActionUse[], circuit: Circuit): void {
    const tools = uses.filter((u) => u.kind === "tool" && !u.failed).sort((a, b) => a.step - b.step).map((u) => u.action);
    if (tools.length < 2 || tools.length > 6) return;
    const kind = requestKind(run.prompt);
    const fingerprint = createHash("sha256").update(`${kind}:${[...tools].sort().join(",")}`).digest("hex").slice(0, 24);
    const pattern = this.state.countPattern(owner, fingerprint, run.status === "completed");
    const total = pattern.successes + pattern.failures;
    if (pattern.proposedAt || pattern.successes < patternSuccesses || pattern.successes / total < patternSuccessRate) return;
    const scores = new Map(circuit.rank(code, "tool", this.now()).map((s) => [s.action, s.score]));
    if (!tools.every((tool) => (scores.get(tool) ?? 0) > 0)) return;
    this.store.review.propose(owner, {
      kind: "skill-note", skillId: null, runId: run.id, source: "Noticed by Branch's learning core",
      text: `These steps have worked ${pattern.successes} of ${total} times for ${kind} requests: ${tools.join(", then ")}. They could become a skill.`,
      note: `Last seen working in a task that began: ${run.prompt.slice(0, 120)}`,
    });
    this.state.markProposed(owner, fingerprint);
  }
  /** Memories whose use has mostly gone well (worth keeping to hand) or mostly badly (could fade). */
  memoryAdvice(owner: string): MemoryAdvice {
    const advice: MemoryAdvice = { strengthen: [], fade: [] };
    for (const s of this.state.load(owner).actions.values()) {
      if (s.kind !== "memory" || s.uses < memoryUsesNeeded) continue;
      const average = s.net / s.uses;
      if (average >= 0.5) advice.strengthen.push(s.action);
      else if (average <= -0.5) advice.fade.push(s.action);
    }
    return advice;
  }
}

/** Where the task started from, as the tasks table recorded it. */
export function contextOf(store: Store, run: Run): TaskContext {
  const row = store.sqlite.prepare("SELECT source, project FROM tasks WHERE id=?").get(run.id);
  return { prompt: run.prompt, project: String(row?.project ?? run.project ?? "default"), source: String(row?.source ?? "owner") };
}

/**
 * The runtime's one call. With the switch off it does nothing at all. Otherwise it applies a
 * correction, ranks suggestions as the task starts (only when the switch is on), and returns what
 * to call when the task has settled. Nothing here may fail or slow a task: errors are recorded.
 */
export function watchTask(store: Store, run: Run, owner: string, makeCore = () => new FlyCore(store)): (settled: Run) => void {
  try {
    const mode = flyCoreSettings(store, owner).mode;
    if (mode === "off" || store.sessionTemporary(run.sessionId)) return () => undefined;
    const core = makeCore();
    const corrected = isCorrection(run.prompt) && core.applyCorrection(owner, run.sessionId);
    const code = core.code(owner, contextOf(store, run));
    if (mode === "on") store.event(run.id, "fly.suggested", { ...core.suggest(owner, code), corrected, activeCells: code.length });
    return (settled) => {
      try { store.event(run.id, "fly.learned", { ...core.learn(owner, settled, code), corrected }); }
      catch (error) { noteFailure(store, run.id, error); }
    };
  } catch (error) {
    noteFailure(store, run.id, error);
    return () => undefined;
  }
}
function noteFailure(store: Store, runId: string, error: unknown): void {
  try { store.event(runId, "fly.failed", { error: error instanceof Error ? error.message : String(error) }); } catch { /* never fails a task */ }
}
