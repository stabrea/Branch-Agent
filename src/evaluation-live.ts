/**
 * Scoring the real work, not only the test set. A suite tells you how the assistant does on twenty
 * questions somebody wrote down; this tells you how it is doing on the tasks you actually gave it
 * today, which is the number that matters when something quietly breaks.
 *
 * It is off until the owner switches it on, and it only ever runs scorers that decide for
 * themselves — never the one that asks a model, because scoring every task with a model would put
 * a second bill on ordinary work. Each finished task gets one verdict, kept beside the task, and
 * the recent ones are summed up as "this many of the last hundred passed".
 */
import { z } from "zod";
import type { Store } from "./store.js";
import { ScorerSchema, scoreAll, makeScorer, type ScorerSpec } from "./evaluation-scorers.js";
import { readTrajectory } from "./evaluation-run.js";

export const LiveScoringSettingsSchema = z.object({
  /** Off until you turn it on. Nothing is scored and nothing is written while it is off. */
  enabled: z.boolean().default(false),
  /** The checks every finished task is held to. At most four, so this never slows a task down. */
  scorers: z.array(ScorerSchema).max(4).default([]),
  /** How many verdicts are kept. The oldest are dropped once there are more than this. */
  keep: z.number().int().min(10).max(2000).default(200),
}).strict();
export type LiveScoringSettings = z.infer<typeof LiveScoringSettingsSchema>;

/** One finished task's verdict. */
export interface LiveScore {
  runId: string;
  at: string;
  status: string;
  score: number;
  pass: boolean;
  reasons: string[];
}

const KEY = "live-scoring";
const recordId = (runId: string): string => `live-score:${runId}`;

export function liveScoringSettings(store: Store, owner: string): LiveScoringSettings {
  const saved = LiveScoringSettingsSchema.safeParse(store.get("settings", owner, KEY)?.data ?? {});
  return saved.success ? saved.data : LiveScoringSettingsSchema.parse({});
}

/**
 * Saves the settings. A scorer that asks a model is refused by name rather than accepted and then
 * quietly skipped, so nobody sets one and wonders why every task fails.
 */
export function saveLiveScoringSettings(store: Store, owner: string, input: unknown): LiveScoringSettings {
  const value = LiveScoringSettingsSchema.parse({ ...liveScoringSettings(store, owner), ...(input as object) });
  if (value.scorers.some((scorer) => scorer.kind === "rubric"))
    throw new Error("Scoring every finished task with a model would put a second bill on ordinary work. Use checks that decide for themselves.");
  // What a finished task cost is worked out where usage is priced, not here, so a money limit set
  // here would be a bar that quietly never applies. Saying so beats letting it always pass.
  if (value.scorers.some((scorer) => scorer.kind === "budget" && scorer.maxDollars !== undefined))
    throw new Error("A money limit cannot be checked here, because what a finished task cost is worked out elsewhere. Use maxSteps, maxMs or maxTokens, and a study for the money.");
  store.save("settings", owner, KEY, value);
  return value;
}

/** Every verdict kept, newest first. */
export function liveScores(store: Store, owner: string, limit = 100): LiveScore[] {
  return store.list("governance", owner)
    .filter((record) => record.id.startsWith("live-score:"))
    .map((record) => record.data as unknown as LiveScore)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

/** "This many of the last so-many passed", and what the recent failures said. */
export function liveScoreSummary(scores: readonly LiveScore[]): { runs: number; passed: number; accuracy: number; reasons: string[] } {
  const passed = scores.filter((score) => score.pass).length;
  const reasons = [...new Set(scores.filter((score) => !score.pass).flatMap((score) => score.reasons))].slice(0, 5);
  return {
    runs: scores.length, passed,
    accuracy: scores.length ? Math.round((passed / scores.length) * 1000) / 1000 : 0,
    reasons,
  };
}

/** Drops the oldest verdicts once there are more than the owner asked to keep. */
function trim(store: Store, owner: string, keep: number): void {
  const all = store.list("governance", owner).filter((record) => record.id.startsWith("live-score:"));
  if (all.length <= keep) return;
  const ordered = all
    .map((record) => ({ id: record.id, at: String((record.data as { at?: unknown }).at ?? "") }))
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const old of ordered.slice(0, all.length - keep)) store.delete("governance", owner, old.id);
}

/**
 * Scores one finished task. Gives back null when scoring is off, when nothing is set to check, or
 * when the task is not this owner's — the caller never has to work out whether it should have run.
 */
export async function scoreFinishedRun(
  store: Store, owner: string, runId: string, workspace: string,
): Promise<LiveScore | null> {
  const settings = liveScoringSettings(store, owner);
  if (!settings.enabled || !settings.scorers.length) return null;
  const run = store.run(runId);
  if (!run || run.owner !== owner) return null;
  const usage = store.usage(runId);
  const trajectory = readTrajectory(store, runId, {
    // How long the task really took, from its own timestamps, so a limit on time is a real limit.
    ms: Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt)) || 0,
    tokens: (usage.estimatedInput ?? 0) + (usage.estimatedOutput ?? 0),
    dollars: null,
  });
  const scorers = settings.scorers.map((spec: ScorerSpec) => makeScorer(spec, { workspace }));
  const verdict = await scoreAll(scorers, { id: runId, prompt: run.prompt ?? "" }, trajectory, run.output ?? "");
  const score: LiveScore = {
    runId, at: new Date().toISOString(), status: run.status,
    score: verdict.score, pass: verdict.pass, reasons: verdict.reasons.slice(0, 5),
  };
  store.save("governance", owner, recordId(runId), { ...score });
  trim(store, owner, settings.keep);
  return score;
}

/**
 * Starts watching. Every task that finishes is scored in the background; a task is never made to
 * wait for its own verdict, and a scorer that throws is the verdict's problem, not the task's.
 */
export function watchFinishedRuns(store: Store, owner: string, workspace: () => string): () => void {
  return store.onRunFinished((runId, status) => {
    if (status !== "completed" && status !== "failed") return;
    void scoreFinishedRun(store, owner, runId, workspace()).catch(() => undefined);
  });
}
