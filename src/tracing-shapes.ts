import type { SpanAttribute, TraceDocument, TraceSpan } from "./trace.js";
import type { SpanRow } from "./tracing.js";

/**
 * The same spans in the three shapes the owner's tracing tool might want: OpenTelemetry (OTLP over
 * HTTP, plain JSON), Langfuse's ingestion list, and LangSmith's runs list. All three are built from
 * the one span model in src/tracing.ts, so a span cannot mean one thing in one tool and another in
 * the next. Nothing here sends anything; these are only the bodies.
 */
const nanos = (iso: string): string => `${BigInt(Date.parse(iso)) * 1_000_000n}`;
const attribute = (key: string, value: string | number | boolean): SpanAttribute =>
  typeof value === "boolean"
    ? { key, value: { boolValue: value } }
    : typeof value === "number" && Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { stringValue: String(value) } };

/** OpenTelemetry's own span kinds: 1 internal, 3 client. A model round and a web call are clients. */
const otlpKind = (kind: SpanRow["kind"]): number => (kind === "model" || kind === "delivery" ? 3 : 1);

export function spanToOtlp(row: SpanRow): TraceSpan {
  const end = row.endedAt ?? row.startedAt;
  return {
    traceId: row.traceId, spanId: row.spanId, parentSpanId: row.parentSpanId,
    name: row.name, kind: otlpKind(row.kind),
    startTimeUnixNano: nanos(row.startedAt), endTimeUnixNano: nanos(end),
    attributes: [attribute("branch.span.kind", row.kind), attribute("branch.run.id", row.runId),
      ...Object.entries(row.attributes).map(([key, value]) => attribute(key, value))],
    status: row.status === "error" ? { code: 2, message: row.message } : { code: row.status === "ok" ? 1 : 0 },
  };
}

/** The spans as one OTLP/HTTP JSON body, the same document shape the trace files already use. */
export function spansToOtlp(rows: SpanRow[], service: { name: string; version: string }): TraceDocument {
  return {
    resourceSpans: [{
      resource: { attributes: [attribute("service.name", service.name), attribute("service.version", service.version)] },
      scopeSpans: [{ scope: { name: "branch.runtime", version: service.version }, spans: rows.map(spanToOtlp) }],
    }],
  };
}

export interface MetricPoint { name: string; description: string; unit: string; value: number }
/** The usage counters as an OTLP/HTTP metrics body: one gauge per counter, all at the same moment. */
export function metricsToOtlp(points: MetricPoint[], service: { name: string; version: string }, at = new Date()): unknown {
  const time = nanos(at.toISOString());
  return {
    resourceMetrics: [{
      resource: { attributes: [attribute("service.name", service.name), attribute("service.version", service.version)] },
      scopeMetrics: [{
        scope: { name: "branch.runtime", version: service.version },
        metrics: points.map((point) => ({
          name: point.name, description: point.description, unit: point.unit,
          gauge: { dataPoints: [{ asDouble: point.value, timeUnixNano: time }] },
        })),
      }],
    }],
  };
}

/**
 * Langfuse takes a list of events, each with its own id and moment. A span becomes one
 * `span-create` observation; the task's own span becomes the trace it all hangs off.
 */
export function spansToLangfuse(rows: SpanRow[], service: { name: string; version: string }): unknown {
  const batch: unknown[] = [];
  for (const row of rows) {
    if (!row.parentSpanId)
      batch.push({
        id: `trace-${row.spanId}`, type: "trace-create", timestamp: row.startedAt,
        body: { id: row.traceId, name: row.name, timestamp: row.startedAt, release: service.version,
          metadata: { ...row.attributes, runId: row.runId }, tags: [service.name, row.kind] },
      });
    batch.push({
      id: `obs-${row.spanId}`, type: "span-create", timestamp: row.startedAt,
      body: {
        id: row.spanId, traceId: row.traceId, name: row.name,
        ...(row.parentSpanId ? { parentObservationId: row.parentSpanId } : {}),
        startTime: row.startedAt, ...(row.endedAt ? { endTime: row.endedAt } : {}),
        level: row.status === "error" ? "ERROR" : "DEFAULT",
        ...(row.message ? { statusMessage: row.message } : {}),
        metadata: { ...row.attributes, branchSpanKind: row.kind, runId: row.runId },
      },
    });
  }
  return { batch };
}

/** LangSmith takes a list of runs; a span is a run whose `parent_run_id` is the span above it. */
export function spansToLangsmith(rows: SpanRow[], project: string): unknown {
  return {
    post: rows.map((row) => ({
      id: uuidFromSpanId(row.spanId),
      trace_id: uuidFromTraceId(row.traceId),
      ...(row.parentSpanId ? { parent_run_id: uuidFromSpanId(row.parentSpanId) } : {}),
      name: row.name,
      run_type: row.kind === "model" ? "llm" : row.kind === "tool" ? "tool" : "chain",
      start_time: row.startedAt,
      ...(row.endedAt ? { end_time: row.endedAt } : {}),
      ...(row.status === "error" ? { error: row.message || "failed" } : {}),
      extra: { metadata: { ...row.attributes, branchSpanKind: row.kind, runId: row.runId } },
      session_name: project,
    })),
  };
}

/** LangSmith identifies runs by UUID, so the 16-character span id is padded into one, reversibly. */
export const uuidFromSpanId = (spanId: string): string => asUuid(spanId.padEnd(32, "0"));
export const uuidFromTraceId = (traceId: string): string => asUuid(traceId.padEnd(32, "0").slice(0, 32));
const asUuid = (hex: string): string =>
  [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
