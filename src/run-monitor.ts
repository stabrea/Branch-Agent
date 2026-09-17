/**
 * Watching one task from outside while it runs, or reading it back afterwards (public list, bucket
 * 13, audit rows A0798 and A1677): the state of every box of a flow (its "vertices"), every exchange
 * with the model and every action (its "transactions"), and the words each of those used — the
 * pipeline's own accounting, box by box, rather than one figure for the whole task.
 *
 * A caller that polls passes the last event number it saw and is handed only what is new, so a
 * screen or a script can follow a long task without reading its whole record every few seconds.
 * Everything comes from the task's event log and the usage ledger; nothing here writes.
 */
import type { Event, Run } from "./contracts.js";
import type { Store } from "./store.js";

export interface MonitorVertex {
  node: string; name: string; kind: string; seq: number;
  status: "running" | "done" | "failed" | "waiting" | "stopped";
  startedAt: string; endedAt: string | null; seconds: number | null;
  /** What the box handed on, or why it failed, cut short and with secrets already taken out. */
  message: string;
  /** The task a prompt box ran, and the words it used. */
  childRunId: string | null;
  tokens: { input: number; output: number };
}
export interface MonitorTransaction {
  eventId: number; at: string; kind: "model" | "tool"; name: string;
  status: "done" | "failed" | "stopped"; seconds: number | null;
  tokens: { input: number; output: number } | null;
}
export interface RunMonitor {
  run: { id: string; status: Run["status"]; startedAt: string; updatedAt: string; seconds: number };
  vertices: MonitorVertex[];
  transactions: MonitorTransaction[];
  /** The words the task itself used, the words its flow boxes' own tasks used, and both together. */
  usage: { task: { input: number; output: number }; boxes: { input: number; output: number }; total: { input: number; output: number } };
  /** Pass this back as `after` to be handed only what happened since. */
  lastEventId: number;
}

const ms = (iso: string): number => new Date(iso).getTime();
const secondsBetween = (from: string, to: string): number => Math.max(0, Math.round((ms(to) - ms(from)) / 100) / 10);
const tokensOf = (usage: Record<string, number>) => ({
  input: usage.reportedInput || usage.estimatedInput || 0,
  output: usage.reportedOutput || usage.estimatedOutput || 0,
});
const vertexEnd: Record<string, MonitorVertex["status"]> = {
  "flow.node.finished": "done", "flow.node.failed": "failed", "flow.node.waiting": "waiting", "flow.node.interrupted": "stopped",
};

/** Every box of a flow, in the order they were reached, with its words counted. */
export function vertices(store: Store, events: readonly Event[], scrub: <T>(value: T) => T): MonitorVertex[] {
  const byKey = new Map<string, MonitorVertex>();
  for (const event of events) {
    const data = event.data as Record<string, unknown>;
    const key = `${String(data.node)}:${String(data.seq)}`;
    if (event.kind === "flow.node.started") {
      byKey.set(key, {
        node: String(data.node), name: String(scrub(String(data.name ?? data.node))).slice(0, 120), kind: String(data.kind ?? ""), seq: Number(data.seq ?? 0),
        status: "running", startedAt: event.createdAt, endedAt: null, seconds: null, message: "", childRunId: null, tokens: { input: 0, output: 0 },
      });
      continue;
    }
    const status = vertexEnd[event.kind];
    const vertex = byKey.get(key);
    if (!status || !vertex) continue;
    const child = typeof data.childRunId === "string" ? data.childRunId : null;
    Object.assign(vertex, {
      status, endedAt: event.createdAt, seconds: secondsBetween(vertex.startedAt, event.createdAt),
      message: String(scrub(data.output ?? data.error ?? "")).slice(0, 500), childRunId: child,
      tokens: child ? tokensOf(store.usage(child)) : vertex.tokens,
    });
  }
  return [...byKey.values()].sort((a, b) => a.seq - b.seq);
}

const toolEnd: Record<string, MonitorTransaction["status"]> = { "tool.completed": "done", "tool.failed": "failed", "tool.stalled": "stopped" };
const modelEnd: Record<string, MonitorTransaction["status"]> = {
  "model.completed": "done", "model.failed": "failed", "model.stalled": "stopped", "model.cancelled": "stopped",
};

/** Every model exchange and every action that finished after `after`, with how long each took. */
export function transactions(events: readonly Event[], after: number): MonitorTransaction[] {
  const toolStarts = new Map<string, string>();
  let modelStart: string | null = null;
  const out: MonitorTransaction[] = [];
  for (const event of events) {
    const data = event.data as Record<string, unknown>;
    if (event.kind === "tool.started") { toolStarts.set(String(data.id ?? ""), event.createdAt); continue; }
    if (event.kind === "model.started") { modelStart = event.createdAt; continue; }
    const tool = toolEnd[event.kind], model = modelEnd[event.kind];
    if (!tool && !model) continue;
    const began = tool ? toolStarts.get(String(data.id ?? "")) : modelStart;
    if (model) modelStart = null;
    if (event.id <= after) continue;
    const reported = (data.reported ?? null) as { input?: number; output?: number } | null;
    out.push({
      eventId: event.id, at: event.createdAt, kind: tool ? "tool" : "model",
      name: String(tool ? data.name ?? "unknown" : data.model ?? "unknown"),
      status: (tool ?? model)!, seconds: began ? secondsBetween(began, event.createdAt) : null,
      tokens: model ? { input: Number(reported?.input ?? data.estimatedInput ?? 0) || 0, output: Number(reported?.output ?? data.estimatedOutput ?? 0) || 0 } : null,
    });
  }
  return out;
}

/** The monitor's whole answer for one task. The caller has already checked the task is the owner's. */
export function runMonitor(store: Store, runId: string, options: { after?: number; scrub?: <T>(value: T) => T } = {}): RunMonitor {
  const run = store.run(runId);
  if (!run) throw Object.assign(new Error("There is no task with that number"), { status: 404 });
  const events = store.events(runId);
  const scrub = options.scrub ?? (<T>(value: T) => value);
  const boxes = vertices(store, events, scrub);
  const task = tokensOf(store.usage(runId));
  const boxTotal = boxes.reduce((sum, box) => ({ input: sum.input + box.tokens.input, output: sum.output + box.tokens.output }), { input: 0, output: 0 });
  return {
    run: { id: run.id, status: run.status, startedAt: run.createdAt, updatedAt: run.updatedAt, seconds: secondsBetween(run.createdAt, run.updatedAt) },
    vertices: boxes,
    transactions: transactions(events, options.after ?? 0),
    usage: { task, boxes: boxTotal, total: { input: task.input + boxTotal.input, output: task.output + boxTotal.output } },
    lastEventId: events.at(-1)?.id ?? 0,
  };
}
