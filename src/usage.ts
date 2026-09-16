import { DatabaseSync } from "node:sqlite";
import type { Run, Event } from "./contracts.js";

export interface PresetPricing {
  id: string;
  inputTokenPrice: number; // per 1000 tokens, in USD
  outputTokenPrice: number; // per 1000 tokens, in USD
}

export interface UsageAggregate {
  date: string;
  runs: number;
  toolCalls: number;
  tokens: { input: number; output: number };
  estimatedCost: number;
  failures: number;
  topFailures: Array<{ reason: string; count: number }>;
  presets: Array<{ id: string; runs: number; tokens: { input: number; output: number }; cost: number }>;
  byConversation: Array<{ sessionId: string; runs: number; tokens: { input: number; output: number } }>;
  byChannel: Array<{ source: string; runs: number }>;
}

export interface UsageStats {
  currentMonthlyTokens: number;
  monthStart: string;
  budgetAlert80Percent: boolean;
}

export interface TimelineEntry {
  timestamp: string;
  type: "model.started" | "model.completed" | "tool.started" | "tool.completed" | "permission" | "retry" | "stall" | "delegation";
  title: string;
  duration: number | undefined;
  result: "success" | "failed" | "timeout" | undefined;
  inputClipped: string | undefined;
  outputClipped: string | undefined;
  details: Record<string, unknown> | undefined;
}

export class UsageStore {
  private cacheTableReady = false;

  constructor(readonly db: DatabaseSync) {
    this.initCache();
  }

  private initCache(): void {
    if (this.cacheTableReady) return;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS usage_cache(
        date TEXT PRIMARY KEY,
        runs INTEGER NOT NULL,
        tool_calls INTEGER NOT NULL,
        tokens_input INTEGER NOT NULL,
        tokens_output INTEGER NOT NULL,
        estimated_cost REAL NOT NULL,
        failures INTEGER NOT NULL,
        top_failures TEXT NOT NULL,
        by_preset TEXT NOT NULL,
        by_conversation TEXT NOT NULL,
        by_channel TEXT NOT NULL,
        last_event_id INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );`
    );
    this.cacheTableReady = true;
  }

  private getDate(timestamp: string): string {
    return timestamp.split("T")[0] || timestamp;
  }

  aggregateUsage(
    range: "7d" | "30d" | "90d" | "all" = "30d",
    groupBy: "day" | "model" | "conversation" | "source" = "day",
    presets: PresetPricing[] = []
  ): UsageAggregate[] {
    const daysBack = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : 36500;
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

    const runs = this.db
      .prepare(
        `SELECT id, session_id, status, created_at, source FROM tasks
         WHERE created_at >= ? AND status NOT IN ('running', 'needs_input')
         ORDER BY created_at DESC`
      )
      .all(cutoff) as Array<{
      id: string;
      session_id: string;
      status: string;
      created_at: string;
      source: string;
    }>;

    const aggregates = new Map<string, UsageAggregate>();
    const presetMap = new Map(presets.map((p) => [p.id, p]));

    for (const run of runs) {
      const date = this.getDate(run.created_at);
      if (!aggregates.has(date)) {
        aggregates.set(date, {
          date,
          runs: 0,
          toolCalls: 0,
          tokens: { input: 0, output: 0 },
          estimatedCost: 0,
          failures: 0,
          topFailures: [],
          presets: [],
          byConversation: [],
          byChannel: [],
        });
      }

      const agg = aggregates.get(date)!;
      agg.runs += 1;

      const usage = this.db
        .prepare(
          `SELECT estimated_input, estimated_output, reported_input, reported_output
           FROM usage WHERE run_id = ?`
        )
        .get(run.id) as {
        estimated_input: number;
        estimated_output: number;
        reported_input: number;
        reported_output: number;
      } | undefined;

      if (usage) {
        const inputTokens = usage.reported_input || usage.estimated_input || 0;
        const outputTokens = usage.reported_output || usage.estimated_output || 0;
        agg.tokens.input += inputTokens;
        agg.tokens.output += outputTokens;
      }

      const events = this.db
        .prepare(`SELECT kind, data FROM events WHERE run_id = ? ORDER BY id`)
        .all(run.id) as Array<{ kind: string; data: string }>;

      for (const event of events) {
        if (event.kind === "tool.completed" || event.kind === "tool.started") agg.toolCalls += 1;
        if (event.kind === "model.completed") {
          const data = JSON.parse(event.data) as Record<string, unknown>;
          const presetId = String(data.preset ?? "");
          if (presetId && !agg.presets.find((p) => p.id === presetId)) {
            agg.presets.push({ id: presetId, runs: 0, tokens: { input: 0, output: 0 }, cost: 0 });
          }
        }
        if (event.kind === "tool.failed") agg.failures += 1;
      }

      if (run.status === "failed" || run.status === "budget_exceeded") agg.failures += 1;

      // Track by source
      const sourceEntry = agg.byChannel.find((s) => s.source === run.source);
      if (sourceEntry) {
        sourceEntry.runs += 1;
      } else {
        agg.byChannel.push({ source: run.source, runs: 1 });
      }
    }

    // Calculate costs
    for (const agg of aggregates.values()) {
      let cost = 0;
      for (const evt of this.db
        .prepare(
          `SELECT DISTINCT r.id, e.data FROM tasks r
           JOIN events e ON r.id = e.run_id
           WHERE r.created_at >= ? AND DATE(r.created_at) = ? AND e.kind = 'model.completed'`
        )
        .all(cutoff, agg.date) as Array<{ id: string; data: string }>) {
        const data = JSON.parse(evt.data) as Record<string, unknown>;
        const presetId = String(data.preset ?? "");
        const pricing = presetMap.get(presetId);
        if (pricing) {
          const usage = this.db
            .prepare(`SELECT estimated_input, estimated_output, reported_input, reported_output FROM usage WHERE run_id = ?`)
            .get(evt.id) as {
            estimated_input: number;
            estimated_output: number;
            reported_input: number;
            reported_output: number;
          } | undefined;
          if (usage) {
            const inp = usage.reported_input || usage.estimated_input || 0;
            const out = usage.reported_output || usage.estimated_output || 0;
            cost += (inp * pricing.inputTokenPrice + out * pricing.outputTokenPrice) / 1000;
          }
        }
      }
      agg.estimatedCost = Math.round(cost * 10000) / 10000;
    }

    return Array.from(aggregates.values()).sort((a, b) => b.date.localeCompare(a.date));
  }

  getRunTimeline(runId: string): TimelineEntry[] {
    const events = this.db
      .prepare(`SELECT kind, data, created_at FROM events WHERE run_id = ? ORDER BY id`)
      .all(runId) as Array<{ kind: string; data: string; created_at: string }>;

    const timeline: TimelineEntry[] = [];
    const startTimes = new Map<string, string>();
    let lastToolId: string | null = null;

    for (const event of events) {
      const data = JSON.parse(event.data) as Record<string, unknown>;

      if (event.kind === "model.started") {
        startTimes.set("model", event.created_at);
      } else if (event.kind === "model.completed") {
        const start = startTimes.get("model");
        const duration = start
          ? Math.round((new Date(event.created_at).getTime() - new Date(start).getTime()) / 1000)
          : undefined;
        timeline.push({
          timestamp: event.created_at,
          type: "model.completed",
          title: `Model: ${data.model || "unknown"} (${data.provider || "?"})`,
          duration: duration,
          result: "success",
          inputClipped: undefined,
          outputClipped: undefined,
          details: { preset: data.preset, provider: data.provider, model: data.model, reasoning: data.reasoning },
        });
      } else if (event.kind === "tool.started") {
        lastToolId = String(data.id ?? "");
        startTimes.set(`tool:${lastToolId}`, event.created_at);
      } else if (event.kind === "tool.completed") {
        const toolId = String(data.id ?? lastToolId ?? "");
        const start = startTimes.get(`tool:${toolId}`);
        const duration = start
          ? Math.round((new Date(event.created_at).getTime() - new Date(start).getTime()) / 1000)
          : undefined;
        timeline.push({
          timestamp: event.created_at,
          type: "tool.completed",
          title: `Tool: ${data.name || "unknown"}`,
          duration: duration,
          result: "success",
          inputClipped: undefined,
          outputClipped: undefined,
          details: { id: toolId, name: data.name },
        });
      } else if (event.kind === "tool.failed") {
        timeline.push({
          timestamp: event.created_at,
          type: "tool.completed",
          title: `Tool failed: ${data.name || "unknown"}`,
          duration: undefined,
          result: "failed",
          inputClipped: undefined,
          outputClipped: undefined,
          details: { error: data.error },
        });
      } else if (event.kind === "model.retry_scheduled") {
        timeline.push({
          timestamp: event.created_at,
          type: "retry",
          title: `Retry scheduled (${data.attempt || 1})`,
          duration: undefined,
          result: undefined,
          inputClipped: undefined,
          outputClipped: undefined,
          details: { preset: data.preset, afterMs: data.afterMs },
        });
      } else if (event.kind === "model.stall_recovery") {
        timeline.push({
          timestamp: event.created_at,
          type: "stall",
          title: `Stall detected and recovered`,
          duration: undefined,
          result: undefined,
          inputClipped: undefined,
          outputClipped: undefined,
          details: { action: data.action, stalls: data.stalls, afterMs: data.afterMs },
        });
      } else if (event.kind === "delegation.fanout") {
        timeline.push({
          timestamp: event.created_at,
          type: "delegation",
          title: `Delegated ${data.count || 1} tasks in parallel`,
          duration: undefined,
          result: undefined,
          inputClipped: undefined,
          outputClipped: undefined,
          details: { count: data.count, ids: data.ids },
        });
      }
    }

    return timeline;
  }

  getMonthlyStats(maxMonthlyTokens?: number): UsageStats {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const runs = this.db
      .prepare(`SELECT id FROM tasks WHERE status NOT IN ('running', 'needs_input') AND created_at >= ? ORDER BY created_at DESC`)
      .all(monthStart) as Array<{ id: string }>;

    let total = 0;
    for (const run of runs) {
      const usage = this.db
        .prepare(`SELECT estimated_input, estimated_output, reported_input, reported_output FROM usage WHERE run_id = ?`)
        .get(run.id) as {
        estimated_input: number;
        estimated_output: number;
        reported_input: number;
        reported_output: number;
      } | undefined;
      if (usage) {
        const inp = usage.reported_input || usage.estimated_input || 0;
        const out = usage.reported_output || usage.estimated_output || 0;
        total += inp + out;
      }
    }

    const alert80 = maxMonthlyTokens ? total >= maxMonthlyTokens * 0.8 : false;
    return {
      currentMonthlyTokens: total,
      monthStart: monthStart.split("T")[0] || monthStart,
      budgetAlert80Percent: alert80,
    };
  }

  updateCache(date: string, aggregate: UsageAggregate, lastEventId: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO usage_cache VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(date) DO UPDATE SET runs=excluded.runs, tool_calls=excluded.tool_calls,
         tokens_input=excluded.tokens_input, tokens_output=excluded.tokens_output,
         estimated_cost=excluded.estimated_cost, failures=excluded.failures,
         top_failures=excluded.top_failures, by_preset=excluded.by_preset,
         by_conversation=excluded.by_conversation, by_channel=excluded.by_channel,
         last_event_id=excluded.last_event_id`
      )
      .run(
        date,
        aggregate.runs,
        aggregate.toolCalls,
        aggregate.tokens.input,
        aggregate.tokens.output,
        aggregate.estimatedCost,
        aggregate.failures,
        JSON.stringify(aggregate.topFailures),
        JSON.stringify(aggregate.presets),
        JSON.stringify(aggregate.byConversation),
        JSON.stringify(aggregate.byChannel),
        lastEventId,
        now
      );
  }

  getCachedUsage(date?: string): UsageAggregate | UsageAggregate[] | null {
    if (date) {
      const row = this.db
        .prepare(`SELECT * FROM usage_cache WHERE date = ?`)
        .get(date) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        date: String(row.date),
        runs: Number(row.runs),
        toolCalls: Number(row.tool_calls),
        tokens: { input: Number(row.tokens_input), output: Number(row.tokens_output) },
        estimatedCost: Number(row.estimated_cost),
        failures: Number(row.failures),
        topFailures: JSON.parse(String(row.top_failures)),
        presets: JSON.parse(String(row.by_preset)),
        byConversation: JSON.parse(String(row.by_conversation)),
        byChannel: JSON.parse(String(row.by_channel)),
      };
    }
    const rows = this.db.prepare(`SELECT * FROM usage_cache ORDER BY date DESC`).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      date: String(row.date),
      runs: Number(row.runs),
      toolCalls: Number(row.tool_calls),
      tokens: { input: Number(row.tokens_input), output: Number(row.tokens_output) },
      estimatedCost: Number(row.estimated_cost),
      failures: Number(row.failures),
      topFailures: JSON.parse(String(row.top_failures)),
      presets: JSON.parse(String(row.by_preset)),
      byConversation: JSON.parse(String(row.by_conversation)),
      byChannel: JSON.parse(String(row.by_channel)),
    }));
  }
}
