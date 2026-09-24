import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import type { ToolContext } from "../contracts.js";
import { ownerWorkOnly } from "./owner-only.js";
import { requireAsk } from "./settings.js";

/**
 * Forecasts and how well they turned out. The owner (or the assistant, asked to) writes down a
 * question, a probability that it comes true, and when it will be known. When the answer is in, it
 * is recorded, and every resolved forecast counts towards two plain numbers: the Brier score (the
 * average squared distance between the probability and what happened — 0 is perfect, 0.25 is what
 * always saying 50% earns) and a calibration table, which says, for everything forecast at about
 * 70%, how often it really happened. Nothing is guessed: a forecast with no answer yet is left out of
 * both, and a table row with nothing in it says so. Nothing leaves this computer.
 */
export const ForecastSchema = z.object({
  question: z.string().trim().min(3).max(500),
  probability: z.number().min(0).max(1),
  resolveBy: z.string().date().optional(),
  note: z.string().trim().max(1000).optional(),
}).strict();
export type ForecastInput = z.infer<typeof ForecastSchema>;

export const ResolveSchema = z.object({
  id: z.string().uuid(),
  happened: z.boolean(),
  note: z.string().trim().max(1000).optional(),
}).strict();

export interface Forecast {
  id: string; question: string; probability: number; resolveBy: string | null; note: string | null;
  createdAt: string; happened: boolean | null; resolvedAt: string | null; resolution: string | null;
}

export interface CalibrationRow {
  /** "0–10%", "10–20%" … "90–100%". */
  band: string;
  forecasts: number;
  /** The average probability given in this band; null when the band is empty. */
  said: number | null;
  /** How often those forecasts came true; null when the band is empty. */
  happened: number | null;
}
export interface Score { open: number; resolved: number; brier: number | null; calibration: CalibrationRow[] }

const fromRow = (row: Record<string, unknown>): Forecast => ({
  id: String(row.id), question: String(row.question), probability: Number(row.probability),
  resolveBy: row.resolve_by === null ? null : String(row.resolve_by), note: row.note === null ? null : String(row.note),
  createdAt: String(row.created_at), happened: row.happened === null ? null : Number(row.happened) === 1,
  resolvedAt: row.resolved_at === null ? null : String(row.resolved_at), resolution: row.resolution === null ? null : String(row.resolution),
});

const round = (value: number): number => Math.round(value * 10000) / 10000;

/** Brier score and calibration over resolved forecasts only. */
export function scoreForecasts(all: readonly Forecast[]): Score {
  const done = all.filter((one) => one.happened !== null);
  const brier = done.length ? round(done.reduce((sum, one) => sum + (one.probability - (one.happened ? 1 : 0)) ** 2, 0) / done.length) : null;
  const calibration = Array.from({ length: 10 }, (_, band): CalibrationRow => {
    const low = band / 10, high = (band + 1) / 10;
    // The top band holds 100% as well, so every probability lands in exactly one band.
    const inside = done.filter((one) => one.probability >= low && (band === 9 ? one.probability <= high : one.probability < high));
    return {
      band: `${band * 10}–${(band + 1) * 10}%`, forecasts: inside.length,
      said: inside.length ? round(inside.reduce((sum, one) => sum + one.probability, 0) / inside.length) : null,
      happened: inside.length ? round(inside.filter((one) => one.happened).length / inside.length) : null,
    };
  });
  return { open: all.length - done.length, resolved: done.length, brier, calibration };
}

export class Forecasts {
  constructor(private readonly store: Store, private readonly owner: string) {
    store.sqlite.exec(`CREATE TABLE IF NOT EXISTS asks_forecasts(id TEXT PRIMARY KEY, owner TEXT NOT NULL, question TEXT NOT NULL,
      probability REAL NOT NULL, resolve_by TEXT, note TEXT, created_at TEXT NOT NULL,
      happened INTEGER, resolved_at TEXT, resolution TEXT)`);
  }

  add(input: unknown): Forecast {
    const parsed = ForecastSchema.parse(input);
    const id = randomUUID(), at = new Date().toISOString();
    this.store.sqlite.prepare(`INSERT INTO asks_forecasts(id, owner, question, probability, resolve_by, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, this.owner, parsed.question, parsed.probability, parsed.resolveBy ?? null, parsed.note ?? null, at);
    return this.get(id)!;
  }

  get(id: string): Forecast | null {
    const row = this.store.sqlite.prepare("SELECT * FROM asks_forecasts WHERE id=? AND owner=?").get(id, this.owner) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : null;
  }

  /** Records what happened. An answer already given is not overwritten: a forecast is scored once. */
  resolve(input: unknown): Forecast {
    const parsed = ResolveSchema.parse(input);
    const found = this.get(parsed.id);
    if (!found) throw new Error("There is no forecast with that id.");
    if (found.happened !== null) throw new Error(`That forecast was already answered on ${found.resolvedAt!.slice(0, 10)}; it is scored as it stands.`);
    this.store.sqlite.prepare("UPDATE asks_forecasts SET happened=?, resolved_at=?, resolution=? WHERE id=? AND owner=?")
      .run(parsed.happened ? 1 : 0, new Date().toISOString(), parsed.note ?? null, parsed.id, this.owner);
    return this.get(parsed.id)!;
  }

  list(which: "open" | "resolved" | "all" = "all"): Forecast[] {
    const where = which === "open" ? " AND happened IS NULL" : which === "resolved" ? " AND happened IS NOT NULL" : "";
    return (this.store.sqlite.prepare(`SELECT * FROM asks_forecasts WHERE owner=?${where} ORDER BY created_at DESC, rowid DESC LIMIT 500`)
      .all(this.owner) as Record<string, unknown>[]).map(fromRow);
  }

  score(): Score { return scoreForecasts(this.list("all")); }
}

export function registerForecasts(registry: ToolRegistry, store: Store, owner: string, forecasts: Forecasts): void {
  // The owner's own records: the owner, in work the owner started, and nobody else (owner-only.ts).
  const guard = (context: ToolContext) => { ownerWorkOnly(store, context, "Your forecasts"); requireAsk(store, owner, "forecasts"); };
  registry.register({
    name: "forecast.add", permission: "forecasts.write",
    description: "Write down a forecast: a question, the probability (0 to 1) that it comes true, and optionally the date it will be known.",
    parameters: ForecastSchema,
    target: (input: ForecastInput) => `a forecast: ${input.question.slice(0, 80)}`,
    execute: async (input, context: ToolContext) => { guard(context); return forecasts.add(input); },
  });
  registry.register({
    name: "forecast.resolve", permission: "forecasts.write",
    description: "Record whether a forecast came true, by its id. A forecast is answered once and then scored as it stands.",
    parameters: ResolveSchema,
    target: (input: z.infer<typeof ResolveSchema>) => `the forecast ${input.id}`,
    execute: async (input, context: ToolContext) => { guard(context); return forecasts.resolve(input); },
  });
  registry.register({
    name: "forecast.score", permission: "forecasts.read",
    description: "How well the forecasts have turned out: the Brier score and a calibration table over the answered ones, and the open ones still waiting.",
    parameters: z.object({ which: z.enum(["open", "resolved", "all"]).default("open") }).strict(),
    target: () => "your forecasts",
    execute: async (input: { which: "open" | "resolved" | "all" }, context: ToolContext) => {
      guard(context);
      return { ...forecasts.score(), forecasts: forecasts.list(input.which).slice(0, 50) };
    },
  });
}
