/**
 * "Look inside" a task: one call that answers everything the inspector screen shows, so the page
 * does not have to stitch five requests together. Rounds the model took, tools it called with the
 * input and output clipped to something readable, the plan it worked through, the reviewer's
 * verdicts, anything the owner steered mid-task, and the questions it stopped on.
 */
import type { Store } from "./store.js";

const CLIP = 600;
/** Whatever the event carried, as short readable text. */
function clip(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > CLIP ? text.slice(0, CLIP) + "…" : text;
}
const at = (value: string) => new Date(value).getTime();

export interface InspectRound {
  at: string;
  provider: string | null;
  model: string | null;
  preset: string | null;
  seconds: number | null;
  /** How big the prompt was, in tokens, when the round started. */
  promptTokens: number | null;
  tokens: { input: number | null; output: number | null };
  /** False when the provider said nothing and these are our own estimates. */
  reported: boolean;
  cost: { amount: number | null; display: string } | null;
  failed: boolean;
  error: string | null;
}
/** Prices one round; the caller supplies the workspace's own price table. */
export type PriceRound = (model: string, tokens: { input: number; output: number }) => { amount: number | null; display: string };
export interface InspectCall {
  at: string;
  id: string | null;
  name: string;
  seconds: number | null;
  status: "done" | "failed" | "practice" | "stopped";
  input: string | null;
  output: string | null;
  receipt: string | null;
}

const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
/**
 * Model rounds, paired from their started/completed events so each carries its own duration. The
 * runtime records what the provider reported when it reported anything, and its own estimate
 * otherwise; both are kept, and `reported` says which of the two the numbers came from.
 */
export function rounds(store: Store, runId: string, price?: PriceRound): InspectRound[] {
  const out: InspectRound[] = [];
  let started: { at: string; tokens: number | null } | null = null;
  for (const event of store.events(runId)) {
    const data = event.data as Record<string, unknown>;
    if (event.kind === "model.started") { started = { at: event.createdAt, tokens: count(data.estimatedInput) }; continue; }
    if (event.kind !== "model.completed" && event.kind !== "model.failed") continue;
    const said = (data.reported ?? null) as { input?: number; output?: number } | null;
    const input = count(said?.input) ?? count(data.estimatedInput) ?? started?.tokens;
    const output = count(said?.output) ?? count(data.estimatedOutput);
    const model = data.model === undefined ? null : String(data.model);
    out.push({
      at: event.createdAt,
      provider: data.provider === undefined ? null : String(data.provider),
      model,
      preset: data.preset === undefined ? null : String(data.preset),
      seconds: started ? Math.max(0, Math.round((at(event.createdAt) - at(started.at)) / 100) / 10) : null,
      promptTokens: started?.tokens ?? count(data.estimatedInput),
      tokens: { input: input ?? null, output: output ?? null },
      reported: Boolean(said && (said.input !== undefined || said.output !== undefined)),
      cost: price && model ? price(model, { input: input ?? 0, output: output ?? 0 }) : null,
      failed: event.kind === "model.failed",
      error: data.error === undefined ? null : String(data.error),
    });
    started = null;
  }
  return out;
}

const STATUS: Record<string, InspectCall["status"]> = {
  "tool.completed": "done", "tool.failed": "failed", "tool.simulated": "practice", "tool.stalled": "stopped",
};
/**
 * What each tool was actually given. The events record the plain-language label, not the raw
 * arguments — those live on the assistant message that asked for the call — so this reads them back
 * by call id and falls back to the label when the message has been compacted away.
 */
function argumentsById(store: Store, sessionId: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const message of store.messages(sessionId)) {
    for (const call of (message as { toolCalls?: { id?: string; arguments?: unknown }[] }).toolCalls ?? [])
      if (call.id) found.set(String(call.id), String(clip(call.arguments) ?? ""));
  }
  return found;
}
/** Every tool call, with what it was given and what came back clipped, and its receipt beside it. */
export function calls(store: Store, runId: string, receipts: Map<string, string>, sessionId?: string): InspectCall[] {
  const given = sessionId ? argumentsById(store, sessionId) : new Map<string, string>();
  const opened = new Map<string, { at: string; label: string | null }>();
  const out: InspectCall[] = [];
  for (const event of store.events(runId)) {
    const data = event.data as Record<string, unknown>;
    const id = data.id === undefined ? "" : String(data.id);
    if (event.kind === "tool.started") { opened.set(id, { at: event.createdAt, label: clip(data.label) }); continue; }
    const status = STATUS[event.kind];
    if (!status) continue;
    const open = opened.get(id);
    out.push({
      at: event.createdAt,
      id: id || null,
      name: String(data.name ?? "unknown"),
      seconds: open ? Math.max(0, Math.round((at(event.createdAt) - at(open.at)) / 100) / 10) : null,
      status,
      input: (given.get(id) || null) ?? open?.label ?? clip(data.label),
      output: clip(data.result ?? data.error),
      receipt: receipts.get(id) ?? null,
    });
    opened.delete(id);
  }
  return out;
}

/** The plan steps, reviewer verdicts, steering notes and stopped-on questions, in the order they happened. */
export function notes(store: Store, runId: string) {
  const plan: { at: string; title: string; detail: string | null }[] = [];
  const verdicts: { at: string; verdict: string; reason: string | null }[] = [];
  const steering: { at: string; text: string }[] = [];
  const questions: { at: string; question: string; answered: boolean }[] = [];
  // Wave 7: a think-then-act specialist leaves one line of reasoning a round, and the working style
  // it was given; both belong on the "Look inside" screen rather than in the answer.
  const thinking: { at: string; text: string }[] = [];
  let style: string | null = null;
  for (const event of store.events(runId)) {
    const data = event.data as Record<string, unknown>;
    if (event.kind === "react.scratch") { thinking.push({ at: event.createdAt, text: String(data.text ?? "") }); continue; }
    if (event.kind === "specialist.style") { style = String(data.style ?? ""); continue; }
    if (event.kind.startsWith("plan.")) plan.push({ at: event.createdAt, title: event.kind.replace("plan.", "plan "), detail: clip(data.steps ?? data.step ?? data.error) });
    else if (event.kind === "verify.verdict" || event.kind === "verify.failed")
      verdicts.push({ at: event.createdAt, verdict: String(data.verdict ?? (event.kind === "verify.failed" ? "could not check" : "unknown")), reason: clip(data.reason ?? data.error) });
    else if (event.kind === "run.steered" || event.kind === "run.steer_applied")
      steering.push({ at: event.createdAt, text: String(data.text ?? data.note ?? "steered") });
    else if (event.kind === "policy.ask" || event.kind === "user.ask")
      questions.push({ at: event.createdAt, question: String(data.question ?? data.label ?? "waiting for an answer"), answered: false });
  }
  return { plan, verdicts, steering, questions, thinking, style };
}

/** Everything the "Look inside" screen needs, and the same shape the JSON export writes out. */
export function inspectRun(
  store: Store,
  runId: string,
  extras: {
    receipts: { items: { id: unknown; outcome: string }[]; counts: Record<string, number> };
    timeline: unknown; cost: unknown; version: string; price?: PriceRound;
  },
) {
  const map = new Map<string, string>();
  for (const item of extras.receipts.items) map.set(item.id === undefined || item.id === null ? "" : String(item.id), item.outcome);
  const run = store.run(runId);
  return {
    exportedAt: new Date().toISOString(),
    version: extras.version,
    run,
    seconds: run ? Math.max(0, Math.round((at(run.updatedAt) - at(run.createdAt)) / 100) / 10) : null,
    rounds: rounds(store, runId, extras.price),
    calls: calls(store, runId, map, run?.sessionId),
    ...notes(store, runId),
    receiptCounts: extras.receipts.counts,
    timeline: extras.timeline,
    usage: store.usage(runId),
    cost: extras.cost,
  };
}
