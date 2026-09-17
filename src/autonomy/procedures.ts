import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";
import { fingerprintOf, type Ledger, type LedgerEntry } from "./ledger.js";
import { narrowed, type Runner } from "./runner.js";
import { quoteLine } from "./settings.js";
import { nextDue, StartSchema, startsAfter, startWords } from "./timing.js";

/**
 * R17-019: procedures that start themselves, each with its own autonomy level and success rate.
 *
 *   ask-each-step  every step waits for the owner's yes
 *   ask-to-start   the owner says yes once before it starts; then its steps run (the default)
 *   auto           it starts and runs by itself, within the owner's approval rules
 *
 * A step marked `confirm` always waits, whatever the level. A procedure already running is not
 * started again (a second start is dropped), and at most one start waits for an answer at a time.
 * Its success rate is finished-and-completed over everything that finished; an "auto" procedure that
 * falls under half after four runs goes back to asking before it starts, and the card says why.
 *
 * The levels, the per-step confirmation that overrides "auto", the coalescing of starts and the
 * completion rate follow ZeroClaw's SOP engine (`crates/zeroclaw-runtime/src/sop/`, MIT/Apache-2.0);
 * this is an independent, smaller implementation.
 */
export const levels = ["ask-each-step", "ask-to-start", "auto"] as const;
export type Level = (typeof levels)[number];

export const ProcedureSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  start: StartSchema,
  steps: z.array(z.object({
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(2000),
    confirm: z.boolean().default(false),
  }).strict()).min(1).max(12),
  level: z.enum(levels).default("ask-to-start"),
  permissions: z.array(z.string().max(100)).max(50).optional(),
  perDay: z.number().int().min(1).max(24).default(4),
}).strict();
export type Procedure = z.infer<typeof ProcedureSchema>;

type Outcome = "completed" | "failed" | "cancelled";
export interface ProcedureState {
  id: string;
  procedure: Procedure;
  status: "active" | "paused";
  nextDueAt: string | null;
  running: { step: number; sessionId: string | null; startedAt: string } | null;
  stats: Record<Outcome, number>;
  recent: { at: string; outcome: Outcome; note: string }[];
  levelNote: string;
  createdAt: string;
}

const prefix = "autonomy-procedure:";
export const maxProcedures = 20;
const demoteAfter = 4;

export function successRate(stats: Record<Outcome, number>): number | null {
  const finished = stats.completed + stats.failed + stats.cancelled;
  return finished ? stats.completed / finished : null;
}

export interface ProceduresDeps {
  store: Store; owner: string; runner: Runner; ledger: Ledger; held: () => string[]; now?: () => Date;
}

export class SelfStarting {
  private readonly work = new Set<Promise<unknown>>();
  constructor(private readonly deps: ProceduresDeps) {}
  private get now(): Date { return (this.deps.now ?? (() => new Date()))(); }

  /** Resolves once every step started so far has settled (for closing, and for tests). */
  async idle(): Promise<void> { while (this.work.size) await Promise.allSettled([...this.work]); }
  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch(() => undefined).finally(() => this.work.delete(tracked));
    this.work.add(tracked);
  }

  list(): (ProcedureState & { successRate: number | null })[] {
    return this.deps.store.list("settings", this.deps.owner).filter((r) => r.id.startsWith(prefix))
      .map((r) => r.data as unknown as ProcedureState).map((s) => ({ ...s, successRate: successRate(s.stats) }));
  }
  get(id: string): ProcedureState {
    const found = this.deps.store.get("settings", this.deps.owner, prefix + id)?.data as ProcedureState | undefined;
    if (!found) throw new Error("There is no procedure with that id.");
    return found;
  }
  private save(state: ProcedureState): ProcedureState {
    this.deps.store.save("settings", this.deps.owner, prefix + state.id, { ...state });
    return state;
  }

  /** The owner's own yes: the procedure is kept and starts on its trigger. */
  create(input: unknown): ProcedureState {
    const procedure = ProcedureSchema.parse(input);
    if (this.list().length >= maxProcedures) throw new Error(`At most ${maxProcedures} procedures that start themselves.`);
    return this.save({ id: randomUUID(), procedure, status: "active", nextDueAt: nextDue(procedure.start, this.now), running: null,
      stats: { completed: 0, failed: 0, cancelled: 0 }, recent: [], levelNote: "", createdAt: this.now.toISOString() });
  }

  propose(input: unknown): { waiting: boolean; id?: string } {
    const procedure = ProcedureSchema.parse(input);
    const entry = this.deps.ledger.ask({ kind: "procedure", from: "assistant",
      fingerprint: fingerprintOf("procedure", procedure.name.toLowerCase(), procedure.steps.map((s) => s.prompt)),
      title: `Procedure: ${quoteLine(procedure.name, 80)}`,
      detail: `${procedure.steps.length} step${procedure.steps.length === 1 ? "" : "s"}, starting ${startWords(procedure.start)}, level ${procedure.level}.`,
      payload: { procedure } });
    return entry ? { waiting: true, id: entry.id } : { waiting: false };
  }

  /** The owner changes the level or pauses it. Raising to "auto" clears the note about going back. */
  update(id: string, input: unknown): ProcedureState {
    const change = z.object({ level: z.enum(levels).optional(), paused: z.boolean().optional() }).strict().parse(input);
    const state = this.get(id);
    if (change.level) Object.assign(state, { procedure: { ...state.procedure, level: change.level }, levelNote: "" });
    if (change.paused !== undefined) Object.assign(state, { status: change.paused ? "paused" : "active",
      nextDueAt: change.paused ? state.nextDueAt : nextDue(state.procedure.start, this.now) });
    return this.save(state);
  }

  remove(id: string): { removed: boolean } {
    this.get(id);
    this.deps.store.delete("settings", this.deps.owner, prefix + id);
    this.deps.ledger.withdraw((entry) => entry.payload.procedureId === id);
    return { removed: true };
  }

  /**
   * After a restart: a procedure marked running that is not waiting for the owner's answer was cut
   * off, so it is finished as cancelled rather than left "running" and never started again.
   */
  recover(): void {
    for (const state of this.list()) {
      if (!state.running) continue;
      const waiting = this.deps.ledger.pendingCount((e) => e.kind === "step" && e.payload.procedureId === state.id);
      if (!waiting) this.finish(state.id, "cancelled", "Branch was closed while it was running.");
    }
  }

  async tick(): Promise<void> {
    for (const state of this.list()) {
      if (state.status !== "active" || !state.nextDueAt || state.nextDueAt > this.now.toISOString()) continue;
      this.save({ ...this.get(state.id), nextDueAt: nextDue(state.procedure.start, this.now) });
      this.trigger(state.id, "its clock came round");
    }
  }
  afterTask(prompt: string): void {
    for (const state of this.list())
      if (state.status === "active" && startsAfter(state.procedure.start, prompt)) this.trigger(state.id, "a task of yours finished");
  }

  /** A start: dropped while running, a question below "auto", and a run at "auto". */
  trigger(id: string, why: string): { started: boolean; reason: string } {
    const state = this.get(id);
    if (state.running) return { started: false, reason: "It is already running, so this start was dropped." };
    if (state.procedure.level === "auto") {
      this.track(this.begin(id));
      return { started: true, reason: "" };
    }
    if (this.deps.ledger.pendingCount((e) => e.kind === "start" && e.payload.procedureId === id))
      return { started: false, reason: "A start already waits for your answer." };
    this.deps.ledger.ask({ kind: "start", from: "procedure", fingerprint: fingerprintOf("start", id, this.now.toISOString()),
      title: `Start "${quoteLine(state.procedure.name, 80)}"?`, detail: `It wants to start because ${why}.`, payload: { procedureId: id } });
    return { started: false, reason: "It asked you first (Inbox, Needs you)." };
  }

  /** The owner's answer to a start or a step. */
  answered(entry: LedgerEntry, yes: boolean): void {
    const id = String(entry.payload.procedureId ?? "");
    const state = this.deps.store.get("settings", this.deps.owner, prefix + id)?.data as ProcedureState | undefined;
    if (!state) return;
    if (entry.kind === "start") { if (yes && !state.running) this.track(this.begin(id)); return; }
    if (!state.running || state.running.step !== Number(entry.payload.step)) return;
    if (yes) this.track(this.runStep(id, true));
    else this.finish(id, "cancelled", `You said no to step ${state.running.step + 1}.`);
  }

  private async begin(id: string): Promise<void> {
    const state = this.get(id);
    this.save({ ...state, running: { step: 0, sessionId: null, startedAt: this.now.toISOString() } });
    // The owner's yes to the start covers the first step; at "auto" a step marked `confirm` still asks.
    await this.runStep(id, state.procedure.level === "ask-to-start");
  }

  /** One step: a question first when its level or the step asks for one, otherwise a bounded turn. */
  private async runStep(id: string, cleared: boolean): Promise<void> {
    const state = this.get(id);
    if (!state.running) return;
    const index = state.running.step, step = state.procedure.steps[index]!;
    const asks = state.procedure.level === "ask-each-step" || step.confirm;
    if (asks && !cleared) {
      this.deps.ledger.ask({ kind: "step", from: "procedure", fingerprint: fingerprintOf("step", id, state.running.startedAt, index),
        title: `"${quoteLine(state.procedure.name, 80)}", step ${index + 1}: ${quoteLine(step.title, 120)}`,
        detail: quoteLine(step.prompt, 300), payload: { procedureId: id, step: index } });
      return;
    }
    const outcome = await this.deps.runner.turn({ key: `procedure:${id}`, prompt: `Procedure "${quoteLine(state.procedure.name, 80)}", step ${index + 1} of ${state.procedure.steps.length}: ${step.title}\n${step.prompt}`,
      permissions: narrowed(state.procedure.permissions, this.deps.held()), perDay: state.procedure.perDay * state.procedure.steps.length,
      gapMs: 0, ...(state.running.sessionId ? { sessionId: state.running.sessionId } : {}) });
    if (!outcome.ran) return this.finish(id, "failed", outcome.reason);
    if (outcome.run.status !== "completed") return this.finish(id, "failed", `Step ${index + 1} did not finish (${outcome.run.status}).`);
    const next = index + 1;
    if (next >= state.procedure.steps.length) return this.finish(id, "completed", "Every step finished.");
    this.save({ ...this.get(id), running: { ...state.running, step: next, sessionId: outcome.run.sessionId } });
    await this.runStep(id, false);
  }

  private finish(id: string, outcome: Outcome, note: string): void {
    const state = this.get(id);
    const stats = { ...state.stats, [outcome]: state.stats[outcome] + 1 };
    const next: ProcedureState = { ...state, running: null, stats,
      recent: [...state.recent, { at: this.now.toISOString(), outcome, note: quoteLine(note, 200) }].slice(-20) };
    const rate = successRate(stats);
    const finished = stats.completed + stats.failed + stats.cancelled;
    if (state.procedure.level === "auto" && finished >= demoteAfter && rate !== null && rate < 0.5) {
      next.procedure = { ...state.procedure, level: "ask-to-start" };
      next.levelNote = `It went back to asking before it starts: only ${Math.round(rate * 100)}% of its runs worked.`;
    }
    this.save(next);
  }
}
