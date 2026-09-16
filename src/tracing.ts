import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Spans: the shape of a task while it is running, rather than after it. A task gets one trace id
 * and a span for every model round, tool call, retrieval, message delivery and sub-task inside it,
 * each pointing at its parent. The rows live beside the events in the same database and never leave
 * this computer unless the owner turns an exporter on.
 *
 * The ids follow the W3C trace context standard (a 32-character trace id, a 16-character span id),
 * so a trace that starts here and carries on in another assistant is one trace in any viewer.
 */
export const spanKinds = ["run", "model", "tool", "retrieval", "delivery", "child", "error"] as const;
export type SpanKind = (typeof spanKinds)[number];

export interface SpanRow {
  traceId: string;
  spanId: string;
  /** Empty for the span at the top of a trace. */
  parentSpanId: string;
  runId: string;
  owner: string;
  kind: SpanKind;
  name: string;
  startedAt: string;
  /** Null while the span is still open. */
  endedAt: string | null;
  /** "ok", "error", or "unset" while it is still running. */
  status: "unset" | "ok" | "error";
  /** Why it failed, in plain words; empty when it did not. */
  message: string;
  /** The same numbers the run inspector shows, with saved passwords and keys already taken out. */
  attributes: Record<string, string | number | boolean>;
}

export const newTraceId = (): string => randomBytes(16).toString("hex");
export const newSpanId = (): string => randomBytes(8).toString("hex");

const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
/** The header that carries a trace from one assistant to the next. */
export function formatTraceparent(traceId: string, spanId: string, sampled = true): string {
  return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}
/** Reads an incoming `traceparent`; anything malformed is ignored rather than trusted. */
export function parseTraceparent(header: unknown): { traceId: string; spanId: string; sampled: boolean } | null {
  const value = String(Array.isArray(header) ? header[0] : (header ?? "")).trim().toLowerCase();
  const match = traceparentPattern.exec(value);
  if (!match) return null;
  const [, traceId, spanId, flags] = match as unknown as [string, string, string, string];
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

/** Where the spans are kept. One table, written as a task runs and read by the exporters. */
export class SpanStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS spans(span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL,
      parent_span_id TEXT NOT NULL, run_id TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL,
      name TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL,
      message TEXT NOT NULL, attributes TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS spans_trace ON spans(trace_id);
      CREATE INDEX IF NOT EXISTS spans_run ON spans(run_id);
      CREATE INDEX IF NOT EXISTS spans_started ON spans(owner, started_at);`);
  }
  begin(row: SpanRow): SpanRow {
    this.db.prepare(`INSERT OR REPLACE INTO spans VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.spanId, row.traceId, row.parentSpanId, row.runId, row.owner, row.kind, row.name,
      row.startedAt, row.endedAt, row.status, row.message, JSON.stringify(row.attributes),
    );
    return row;
  }
  finish(spanId: string, at: string, status: "ok" | "error", message = "", attributes?: Record<string, string | number | boolean>): void {
    const current = this.get(spanId);
    if (!current) return;
    this.db.prepare(`UPDATE spans SET ended_at=?, status=?, message=?, attributes=? WHERE span_id=?`).run(
      at, status, message.slice(0, 300), JSON.stringify({ ...current.attributes, ...(attributes ?? {}) }), spanId,
    );
  }
  get(spanId: string): SpanRow | undefined {
    const row = this.db.prepare(`SELECT * FROM spans WHERE span_id=?`).get(spanId);
    return row ? toSpan(row) : undefined;
  }
  forRun(runId: string): SpanRow[] {
    return this.db.prepare(`SELECT * FROM spans WHERE run_id=? ORDER BY started_at, rowid`).all(runId).map(toSpan);
  }
  forTrace(traceId: string): SpanRow[] {
    return this.db.prepare(`SELECT * FROM spans WHERE trace_id=? ORDER BY started_at, rowid`).all(traceId).map(toSpan);
  }
  /** The newest finished spans, for the exporters and the diagnostics folder. */
  recent(owner: string, limit = 200): SpanRow[] {
    return this.db.prepare(`SELECT * FROM spans WHERE owner=? ORDER BY rowid DESC LIMIT ?`)
      .all(owner, Math.min(Math.max(limit, 1), 2000)).map(toSpan);
  }
  /** Spans written after a moment, oldest first: what an exporter still has to send. */
  since(owner: string, after: string, limit = 500): SpanRow[] {
    return this.db.prepare(`SELECT * FROM spans WHERE owner=? AND ended_at IS NOT NULL AND ended_at > ? ORDER BY ended_at, rowid LIMIT ?`)
      .all(owner, after, Math.min(Math.max(limit, 1), 2000)).map(toSpan);
  }
  /** Keeps the newest spans and drops the rest, so the table cannot grow without limit. */
  prune(owner: string, keep = 20000): number {
    return Number(this.db.prepare(
      `DELETE FROM spans WHERE owner=? AND rowid NOT IN (SELECT rowid FROM spans WHERE owner=? ORDER BY rowid DESC LIMIT ?)`,
    ).run(owner, owner, keep).changes);
  }
}

function toSpan(row: Record<string, unknown>): SpanRow {
  let attributes: Record<string, string | number | boolean> = {};
  try { attributes = JSON.parse(String(row.attributes)) as Record<string, string | number | boolean>; } catch { /* a damaged row still has its shape */ }
  return {
    spanId: String(row.span_id), traceId: String(row.trace_id), parentSpanId: String(row.parent_span_id),
    runId: String(row.run_id), owner: String(row.owner), kind: String(row.kind) as SpanKind, name: String(row.name),
    startedAt: String(row.started_at), endedAt: row.ended_at === null ? null : String(row.ended_at),
    status: String(row.status) as SpanRow["status"], message: String(row.message), attributes,
  };
}

/**
 * Uncaught failures in the engine, written down as their own one-moment span with the stack put
 * through the same scrubber as everything else. This only watches — it never stops Node doing what
 * it would have done — so a crash still crashes and is still visible in the usual places.
 */
const errorSinks = new Set<(error: unknown) => void>();
let watchingProcess = false;
export function recordUncaughtErrors(spans: SpanStore, owner: string, scrub: (value: string) => string): () => void {
  const sink = (error: unknown): void => {
    const at = new Date().toISOString();
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const stack = error instanceof Error ? (error.stack ?? "") : "";
    try {
      spans.begin({
        traceId: newTraceId(), spanId: newSpanId(), parentSpanId: "", runId: "", owner,
        kind: "error", name: "branch.uncaught_error", startedAt: at, endedAt: at, status: "error",
        message: scrub(message).slice(0, 300),
        attributes: { "exception.type": error instanceof Error ? error.name : "Error", "exception.stacktrace": scrub(stack).slice(0, 300) },
      });
    } catch { /* recording a crash must never cause a second one */ }
  };
  errorSinks.add(sink);
  if (!watchingProcess) {
    watchingProcess = true;
    // "uncaughtExceptionMonitor" watches without taking the failure over, so Node still exits.
    process.on("uncaughtExceptionMonitor", (error) => { for (const each of [...errorSinks]) each(error); });
  }
  return () => { errorSinks.delete(sink); };
}

export interface OpenSpan {
  traceId: string;
  spanId: string;
  /** Closes the span. Calling it twice changes nothing. */
  end(status: "ok" | "error", message?: string, attributes?: Record<string, string | number | boolean>): void;
}

/** Only these value types go into a span; anything else is left out rather than stringified blindly. */
function cleanAttributes(input: Record<string, unknown>, scrub: (value: string) => string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") out[key] = scrub(value).slice(0, 300);
  }
  return out;
}

/**
 * Opens and closes spans for one running assistant. A task's first span carries the trace id — its
 * own, or the one an incoming request brought with it — and everything inside the task hangs off it.
 */
export class Tracer {
  private readonly roots = new Map<string, { traceId: string; spanId: string }>();
  /** Takes saved passwords and keys back out of every attribute before it is written down. */
  scrub: (value: string) => string = (value) => value;
  constructor(private readonly spans: SpanStore, private readonly owner: string) {}

  /** The trace this task belongs to and the span its children hang off, or null when it is untraced. */
  current(runId: string): { traceId: string; spanId: string } | null {
    return this.roots.get(runId) ?? null;
  }
  /** The header to put on an outbound call so the other side joins this trace; null when untraced. */
  traceparent(runId: string): string | null {
    const root = this.roots.get(runId);
    return root ? formatTraceparent(root.traceId, root.spanId) : null;
  }
  /**
   * Starts a task's own span. `inbound` is the `traceparent` header of the request that asked for
   * this task, and `parentRunId` the task that delegated it; either one joins an existing trace.
   */
  startRun(
    runId: string, name: string, attributes: Record<string, unknown> = {},
    link: { inbound?: unknown; parentRunId?: string | null } = {},
  ): OpenSpan {
    const inbound = parseTraceparent(link.inbound);
    const parent = link.parentRunId ? this.roots.get(link.parentRunId) : undefined;
    const traceId = inbound?.traceId ?? parent?.traceId ?? newTraceId();
    const parentSpanId = parent?.spanId ?? inbound?.spanId ?? "";
    const spanId = newSpanId();
    this.roots.set(runId, { traceId, spanId });
    return this.write({ traceId, spanId, parentSpanId, runId, kind: parent ? "child" : "run", name, attributes });
  }
  /** Starts a span inside a task. Nothing is written when the task has no trace. */
  start(runId: string, kind: SpanKind, name: string, attributes: Record<string, unknown> = {}): OpenSpan | null {
    const root = this.roots.get(runId);
    if (!root) return null;
    return this.write({ traceId: root.traceId, spanId: newSpanId(), parentSpanId: root.spanId, runId, kind, name, attributes });
  }
  /** Forgets a finished task, so its ids are not kept in memory for ever. */
  forget(runId: string): void {
    this.roots.delete(runId);
  }

  private write(input: {
    traceId: string; spanId: string; parentSpanId: string; runId: string; kind: SpanKind;
    name: string; attributes: Record<string, unknown>;
  }): OpenSpan {
    const startedAt = new Date().toISOString();
    this.spans.begin({
      ...input, owner: this.owner, startedAt, endedAt: null, status: "unset", message: "",
      attributes: cleanAttributes(input.attributes, this.scrub), name: input.name.slice(0, 200),
    });
    let closed = false;
    const spans = this.spans, scrub = (value: string): string => this.scrub(value);
    return {
      traceId: input.traceId, spanId: input.spanId,
      end(status, message = "", attributes = {}) {
        if (closed) return;
        closed = true;
        spans.finish(input.spanId, new Date().toISOString(), status, scrub(message), cleanAttributes(attributes, scrub));
      },
    };
  }
}
