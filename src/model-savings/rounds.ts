import type { Store } from "../store.js";
import type { Event } from "../contracts.js";

/**
 * R17-049: one conversation, round by round: what went in, what came out, how much the service's
 * prompt cache served, and where the conversation was folded. Everything comes from events that
 * are already written down (`model.completed`, `context.budget`, `context.compacting`,
 * `context.compacted`), so nothing new is counted.
 */
export interface RoundRow {
  runId: string;
  round: number;
  input: number;
  output: number;
  cached: number | null;
  /** True when the service said the figures; false when they are Branch's estimate. */
  measured: boolean;
  /** True when a kept answer was used and nothing was sent. */
  reused: boolean;
  preset: string | null;
}
export interface FoldMark {
  runId: string;
  /** How many rounds had happened in this conversation when the fold started. */
  afterRound: number;
  before: number | null;
  after: number | null;
  done: boolean;
}
export interface RoundsView {
  rounds: RoundRow[];
  folds: FoldMark[];
  /** How close the latest round was to the folding point, 0 to 100, or null when unknown. */
  towardsFold: number | null;
  folding: boolean;
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function roundOf(event: Event, round: number): RoundRow {
  const data = event.data;
  const reported = data.reported as { input?: number; output?: number } | null | undefined;
  return {
    runId: event.runId, round,
    input: reported ? num(reported.input) : num(data.estimatedInput),
    output: reported ? num(reported.output) : num(data.estimatedOutput),
    cached: typeof data.cachedInput === "number" ? data.cachedInput : null,
    measured: Boolean(reported), reused: data.cached === true,
    preset: typeof data.preset === "string" ? data.preset : null,
  };
}

/** Reads one task's events into the view; `state` carries on from the tasks before it. */
function readRun(events: Event[], view: RoundsView, running: boolean): void {
  let latestBudget: { messages: number; threshold: number } | null = null;
  for (const event of events) {
    if (event.kind === "model.completed") view.rounds.push(roundOf(event, view.rounds.length + 1));
    else if (event.kind === "context.budget") latestBudget = { messages: num(event.data.messages), threshold: num(event.data.threshold) };
    else if (event.kind === "context.compacting")
      view.folds.push({ runId: event.runId, afterRound: view.rounds.length, before: num(event.data.estimatedBefore) || null, after: null, done: false });
    else if (event.kind === "context.compacted") {
      const open = view.folds.findLast((fold) => fold.runId === event.runId && !fold.done);
      const mark = open ?? { runId: event.runId, afterRound: view.rounds.length, before: num(event.data.estimatedBefore) || null, after: null, done: false };
      Object.assign(mark, { after: num(event.data.estimatedAfter) || null, done: true });
      if (!open) view.folds.push(mark);
    }
  }
  if (latestBudget && latestBudget.threshold > 0)
    view.towardsFold = Math.min(100, Math.round(latestBudget.messages / latestBudget.threshold * 100));
  if (running && view.folds.some((fold) => fold.runId === events[0]?.runId && !fold.done)) view.folding = true;
}

/** The last ten tasks of one of the owner's conversations, oldest first. */
export function roundsOf(store: Store, owner: string, sessionId: string): RoundsView {
  if (!store.ownsSession(owner, sessionId)) throw new Error("Conversation not found");
  const runs = store.runs(owner).filter((run) => run.sessionId === sessionId).slice(0, 10).reverse();
  const view: RoundsView = { rounds: [], folds: [], towardsFold: null, folding: false };
  for (const run of runs) {
    const events = store.events(run.id);
    if (events.length) readRun(events, view, run.status === "running");
  }
  for (const fold of view.folds) if (!fold.done && !view.folding) fold.done = true;
  view.rounds = view.rounds.slice(-60);
  return view;
}
