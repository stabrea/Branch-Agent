import type { DatabaseSync } from "node:sqlite";
import type { MetricPoint } from "./tracing-shapes.js";

/**
 * The running totals, in the plain text format monitoring tools already read. Everything here is
 * counted from this computer's own database; nothing is collected about the person and nothing is
 * sent anywhere. The page is behind the same local key as the rest of the app.
 */
export interface MetricsSnapshot {
  points: MetricPoint[];
  /** How long tool calls took, as the buckets a histogram needs. */
  toolLatency: { buckets: { le: number; count: number }[]; count: number; sum: number };
}

/** Seconds a tool call may take, as the boundaries of the histogram. */
const latencyBuckets = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120];

/** One number from the database; a table an older install has not got yet counts as nothing. */
function scalar(db: DatabaseSync, sql: string, ...values: (string | number)[]): number {
  try {
    const row = db.prepare(sql).get(...values) as Record<string, unknown> | undefined;
    const first = row ? Object.values(row)[0] : 0;
    return Number(first ?? 0);
  } catch {
    return 0;
  }
}

/** How long each finished tool call took, in seconds, from the started and completed events. */
export function toolDurations(db: DatabaseSync, limit = 5000): number[] {
  const rows = db.prepare(
    `SELECT run_id, kind, data, created_at FROM events
     WHERE kind IN ('tool.started','tool.completed','tool.failed','tool.stalled')
     ORDER BY id DESC LIMIT ?`,
  ).all(Math.min(Math.max(limit, 1), 20000)) as Array<{ run_id: string; kind: string; data: string; created_at: string }>;
  const ends = new Map<string, number>();
  const durations: number[] = [];
  // The rows come newest first, so a call's end is seen before its start.
  for (const row of rows) {
    let id = "";
    try { id = String((JSON.parse(row.data) as Record<string, unknown>).id ?? ""); } catch { continue; }
    const key = `${row.run_id}:${id}`;
    const at = Date.parse(row.created_at);
    if (!Number.isFinite(at)) continue;
    if (row.kind === "tool.started") {
      const end = ends.get(key);
      if (end !== undefined && end >= at) { durations.push((end - at) / 1000); ends.delete(key); }
    } else ends.set(key, at);
  }
  return durations;
}

/** Counts a list of durations into the histogram buckets a monitoring tool expects. */
export function histogram(durations: number[]): MetricsSnapshot["toolLatency"] {
  return {
    buckets: latencyBuckets.map((le) => ({ le, count: durations.filter((value) => value <= le).length })),
    count: durations.length,
    sum: Math.round(durations.reduce((total, value) => total + value, 0) * 1000) / 1000,
  };
}

/** Everything the metrics page reports, read once from the database. */
export function collectMetrics(db: DatabaseSync, owner: string, estimatedCost = 0): MetricsSnapshot {
  const durations = toolDurations(db);
  const points: MetricPoint[] = [
    { name: "branch_runs_total", description: "Tasks started, all time", unit: "1", value: scalar(db, "SELECT COUNT(*) FROM tasks WHERE owner=?", owner) },
    { name: "branch_runs_running", description: "Tasks working right now", unit: "1", value: scalar(db, "SELECT COUNT(*) FROM tasks WHERE owner=? AND status='running'", owner) },
    { name: "branch_runs_failed_total", description: "Tasks that ended badly", unit: "1", value: scalar(db, "SELECT COUNT(*) FROM tasks WHERE owner=? AND status IN ('failed','budget_exceeded')", owner) },
    { name: "branch_runs_waiting", description: "Tasks waiting for an answer from the person", unit: "1", value: scalar(db, "SELECT COUNT(*) FROM tasks WHERE owner=? AND status='needs_input'", owner) },
    { name: "branch_tokens_input_total", description: "Words in, counted as tokens", unit: "1", value: scalar(db, "SELECT COALESCE(SUM(MAX(reported_input,estimated_input)),0) FROM usage WHERE run_id IN (SELECT id FROM tasks WHERE owner=?)", owner) },
    { name: "branch_tokens_output_total", description: "Words out, counted as tokens", unit: "1", value: scalar(db, "SELECT COALESCE(SUM(MAX(reported_output,estimated_output)),0) FROM usage WHERE run_id IN (SELECT id FROM tasks WHERE owner=?)", owner) },
    { name: "branch_cost_usd_total", description: "Estimated money spent this month, in US dollars", unit: "1", value: estimatedCost },
    { name: "branch_tool_calls_total", description: "Tool calls that finished", unit: "1", value: scalar(db, "SELECT COUNT(*) FROM events WHERE kind='tool.completed'") },
    { name: "branch_tool_failures_total", description: "Tool calls that failed", unit: "1", value: scalar(db, "SELECT COUNT(*) FROM events WHERE kind IN ('tool.failed','tool.stalled')") },
    { name: "branch_compactions_total", description: "Conversations shortened to make room", unit: "1", value: scalar(db, "SELECT COUNT(*) FROM compactions") },
    { name: "branch_spans_total", description: "Spans recorded", unit: "1", value: scalar(db, "SELECT COUNT(*) FROM spans WHERE owner=?", owner) },
  ];
  return { points, toolLatency: histogram(durations) };
}

const line = (name: string, help: string, type: string, body: string[]): string[] =>
  [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...body];

/** The snapshot as the plain text a monitoring tool scrapes. Every value is a number on its own line. */
export function prometheusText(snapshot: MetricsSnapshot): string {
  const rows: string[] = [];
  for (const point of snapshot.points)
    rows.push(...line(point.name, point.description, point.name.endsWith("_total") ? "counter" : "gauge",
      [`${point.name} ${Number.isFinite(point.value) ? point.value : 0}`]));
  const histogramName = "branch_tool_duration_seconds";
  rows.push(...line(histogramName, "How long tool calls took", "histogram", [
    ...snapshot.toolLatency.buckets.map((bucket) => `${histogramName}_bucket{le="${bucket.le}"} ${bucket.count}`),
    `${histogramName}_bucket{le="+Inf"} ${snapshot.toolLatency.count}`,
    `${histogramName}_sum ${snapshot.toolLatency.sum}`,
    `${histogramName}_count ${snapshot.toolLatency.count}`,
  ]));
  return rows.join("\n") + "\n";
}

/** Reads the plain text back into names and numbers, so the Health card and the tests can use it. */
export function parsePrometheus(text: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const row of text.split("\n")) {
    if (!row || row.startsWith("#")) continue;
    const at = row.lastIndexOf(" ");
    if (at <= 0) continue;
    const name = row.slice(0, at).trim(), value = Number(row.slice(at + 1).trim());
    if (name && Number.isFinite(value)) values[name] = value;
  }
  return values;
}
