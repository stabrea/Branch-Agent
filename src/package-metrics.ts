import type { DatabaseSync } from "node:sqlite";

/**
 * Runtime counters for a skill package's own declared calls (FQ-automation.metrics). A package
 * that ships a metrics.json names which of its tools.json calls it wants watched; installing it
 * asks for nothing new, since every number here comes from the "skill.tool_called" event a call
 * already writes (src/skill-http-tools.ts) once that call has actually run. Nothing is collected
 * about the person and nothing leaves this computer; the owner reads the same counters back
 * through the packages list or the package's own metrics endpoint.
 */
export interface PackageMetricPoint {
  tool: string;
  description: string;
  callsTotal: number;
  errorsTotal: number;
  /** Milliseconds, rounded; 0 when the tool has never run. */
  avgMs: number;
  lastCalledAt: string | null;
}

interface ToolCallRow { data: string; created_at: string }

/**
 * Reads every "skill.tool_called" event this package's calls have produced and folds it into one
 * point per declared metric. `limit` bounds how far back a busy package is read, the same way
 * src/metrics.ts bounds tool-duration reads, so one popular package cannot slow the whole page.
 */
export function collectPackageMetrics(db: DatabaseSync, packageName: string, declared: { tool: string; description: string }[], limit = 5000): PackageMetricPoint[] {
  if (!declared.length) return [];
  let rows: ToolCallRow[];
  try {
    rows = db.prepare(
      `SELECT data, created_at FROM events WHERE kind='skill.tool_called' ORDER BY id DESC LIMIT ?`,
    ).all(Math.min(Math.max(limit, 1), 20000)) as unknown as ToolCallRow[];
  } catch {
    rows = [];
  }
  const byTool = new Map<string, { calls: number; errors: number; totalMs: number; last: string | null }>();
  for (const metric of declared) byTool.set(metric.tool, { calls: 0, errors: 0, totalMs: 0, last: null });
  for (const row of rows) {
    let data: Record<string, unknown>;
    try { data = JSON.parse(row.data) as Record<string, unknown>; } catch { continue; }
    if (data.skill !== packageName) continue;
    const bucket = byTool.get(String(data.tool ?? ""));
    if (!bucket) continue;
    bucket.calls += 1;
    const status = Number(data.status ?? 0);
    if (!Number.isFinite(status) || status < 200 || status >= 300) bucket.errors += 1;
    const ms = Number(data.ms ?? 0);
    if (Number.isFinite(ms)) bucket.totalMs += ms;
    bucket.last ??= row.created_at; // rows arrive newest first, so the first one seen is the latest call
  }
  return declared.map((metric) => {
    const bucket = byTool.get(metric.tool)!;
    return {
      tool: metric.tool, description: metric.description, callsTotal: bucket.calls, errorsTotal: bucket.errors,
      avgMs: bucket.calls ? Math.round(bucket.totalMs / bucket.calls) : 0, lastCalledAt: bucket.last,
    };
  });
}
