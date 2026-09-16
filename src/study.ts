/**
 * Studies: a written-down experiment, so a measurement can be repeated months later and get the
 * same shape of answer. A study says which tasks, which model choices, how many repeats and what
 * it may cost; running it works through every combination, several at a time, writing each result
 * down as it lands. A study that is stopped part way — a crash, a power cut — carries on from
 * where it left off, because every finished piece is already saved.
 *
 * Nothing here downloads anything, and a benchmark's files are read from the folder the owner
 * chose. Comparing two studies reports the difference with an interval worked out by resampling
 * the tasks, so a small win on a handful of tasks is not read as a real one.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Runtime } from "./runtime.js";
import { maximumActiveExecutions } from "./execution-limit.js";
import { estimateCost, pricingSettings } from "./pricing.js";
import { findSuite } from "./evaluation-suites.js";
import { readTrajectory, runtimeJudge, scoreTrajectory } from "./evaluation-run.js";
import type { ScoredTrajectory } from "./evaluation-scorers.js";
import { findBenchmarkAdapter } from "./benchmark-adapters.js";
import type { BenchmarkAdapter, BenchmarkTask } from "./benchmarks.js";

export const StudySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).default(""),
  /** Where the tasks come from: one of the owner's suites, or a benchmark folder on this computer. */
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("suite"), suite: z.string().min(1).max(64) }).strict(),
    z.object({ kind: z.literal("benchmark"), benchmark: z.string().min(1).max(40), directory: z.string().min(1).max(1000) }).strict(),
  ]),
  /** Only these task ids, in this order. Empty means every task the source has. */
  subset: z.array(z.string().min(1).max(64)).max(200).default([]),
  /** The most tasks to take from the source, so a study of a big dataset stays affordable. */
  limit: z.number().int().min(1).max(200).default(20),
  /** The model choices to try, side by side. */
  presets: z.array(z.string().min(1).max(64)).min(1).max(4),
  /** How many times each task is repeated for each model choice. */
  repeats: z.number().int().min(1).max(5).default(1),
  /** How many tasks run at once. Never more than the whole app allows. */
  concurrency: z.number().int().min(1).max(maximumActiveExecutions).default(2),
  /** How many more goes a task gets after an error that is not the model's fault. */
  retries: z.number().int().min(0).max(3).default(1),
  /** Stop the study when it has cost this much. Left out, only the task count limits it. */
  maxDollars: z.number().min(0).optional(),
  maxSteps: z.number().int().min(1).max(200).default(30),
  maxTokens: z.number().int().min(1000).max(1_000_000).default(120_000),
  /** Best-of-N: run each task this many times and keep the best one by its score. */
  bestOfN: z.number().int().min(1).max(5).default(1),
}).strict();
export type Study = z.infer<typeof StudySchema>;

/** One task, run once, for one model choice. This is the row everything else is worked out from. */
export interface StudyCell {
  taskId: string; preset: string; repeat: number; attempts: number;
  passed: boolean; score: number; ms: number; tokens: number; dollars: number | null;
  runId: string | null; reasons: string[];
  /** Best-of-N: the score of each try, so the choice can be seen rather than trusted. */
  candidates?: number[];
}
export interface StudyRunResult {
  id: string; studyId: string; name: string; startedAt: string; finishedAt: string;
  presets: string[]; tasks: string[]; cells: StudyCell[];
  rows: { preset: string; tasks: number; passed: number; accuracy: number; meanMs: number; tokens: number; dollars: number | null }[];
  /** How many cells were already done when the study was picked back up. */
  resumed: number;
  stoppedEarly: string | null;
}

const cellKey = (studyId: string, cell: { preset: string; taskId: string; repeat: number }): string =>
  `study-cell:${studyId}:${cell.preset}:${cell.taskId}:${cell.repeat}`;

/** The plain-language table a person reads, and a study report pastes in unchanged. */
export function studyTable(result: StudyRunResult): string {
  const head = "| Model choice | Tasks | Right | Accuracy | Mean ms | Tokens | Cost |";
  const rule = "| --- | ---: | ---: | ---: | ---: | ---: | ---: |";
  const rows = result.rows.map((row) =>
    `| ${row.preset} | ${row.tasks} | ${row.passed} | ${(row.accuracy * 100).toFixed(1)}% | ${row.meanMs} | ${row.tokens} | ${row.dollars === null ? "no price on file" : "$" + row.dollars.toFixed(4)} |`);
  return [`### ${result.name}`, "", head, rule, ...rows, ""].join("\n");
}
/** Every cell as JSON Lines, one per line, for a spreadsheet or another program to read. */
export function* studyLines(result: StudyRunResult): Generator<string> {
  for (const cell of result.cells) yield JSON.stringify({ study: result.studyId, run: result.id, ...cell });
}

/** One task a study runs, whatever it came from. */
interface StudyTask { id: string; prompt: string; expected?: string | undefined; scorers?: unknown[] | undefined; judge?: ((answer: string) => Promise<{ pass: boolean; reasons: string[] }>) | undefined }

export class StudyRunner {
  private readonly judgeCache = new Map<string, { score: number; reason: string }>();
  constructor(private readonly store: Store, private readonly runtime: Runtime) {}
  private get owner(): string { return this.runtime.owner; }

  /** Saves a study so it can be run again exactly as written. */
  save(input: unknown): Study {
    const study = StudySchema.parse(input);
    this.store.save("governance", this.owner, `study:${study.id}`, { ...study });
    return study;
  }
  list(): Study[] {
    return this.store.list("governance", this.owner)
      .filter((record) => record.id.startsWith("study:"))
      .flatMap((record) => { const parsed = StudySchema.safeParse(record.data); return parsed.success ? [parsed.data] : []; });
  }
  find(id: string): Study {
    const found = this.list().find((study) => study.id === id);
    if (!found) throw new Error(`There is no study called ${id}`);
    return found;
  }
  results(studyId?: string): StudyRunResult[] {
    return this.store.list("governance", this.owner)
      .filter((record) => record.id.startsWith("study-run:"))
      .map((record) => record.data as unknown as StudyRunResult)
      .filter((result) => !studyId || result.studyId === studyId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Runs a study. Anything already finished is kept, so this is also how a study is resumed. */
  async run(id: string, options: { fresh?: boolean } = {}): Promise<StudyRunResult> {
    const study = this.find(id);
    if (options.fresh) this.clearCheckpoints(study.id);
    const tasks = await this.tasksFor(study);
    const startedAt = new Date().toISOString();
    const planned = study.presets.flatMap((preset) =>
      tasks.flatMap((task) => Array.from({ length: study.repeats }, (_, repeat) => ({ task, preset, repeat }))));
    const done = new Map<string, StudyCell>();
    for (const item of planned) {
      const saved = this.store.get("governance", this.owner, cellKey(study.id, { preset: item.preset, taskId: item.task.id, repeat: item.repeat }));
      if (saved) done.set(cellKey(study.id, { preset: item.preset, taskId: item.task.id, repeat: item.repeat }), saved.data as unknown as StudyCell);
    }
    const resumed = done.size;
    const stopped = await this.workThrough(study, planned.filter((item) => !done.has(cellKey(study.id, { preset: item.preset, taskId: item.task.id, repeat: item.repeat }))), done);
    return this.finish(study, tasks, [...done.values()], startedAt, resumed, stopped);
  }

  /** Runs what is left, `concurrency` at a time, writing each result down the moment it lands. */
  private async workThrough(
    study: Study, queue: { task: StudyTask; preset: string; repeat: number }[], done: Map<string, StudyCell>,
  ): Promise<string | null> {
    let next = 0, stopped: string | null = null;
    const spend = () => [...done.values()].reduce((total, cell) => total + (cell.dollars ?? 0), 0);
    const worker = async (): Promise<void> => {
      while (next < queue.length && !stopped) {
        if (study.maxDollars !== undefined && spend() > study.maxDollars) { stopped = `The study stopped after $${spend().toFixed(4)}, which is over the $${study.maxDollars.toFixed(4)} it was given.`; return; }
        const item = queue[next++]!;
        const cell = await this.runCell(study, item.task, item.preset, item.repeat);
        done.set(cellKey(study.id, cell), cell);
        this.store.save("governance", this.owner, cellKey(study.id, cell), { ...cell });
      }
    };
    await Promise.all(Array.from({ length: Math.min(study.concurrency, queue.length || 1) }, worker));
    return stopped;
  }

  /** One cell, with retries and Best-of-N. The best try by score is the one that is kept. */
  private async runCell(study: Study, task: StudyTask, preset: string, repeat: number): Promise<StudyCell> {
    const tries: StudyCell[] = [];
    for (let candidate = 0; candidate < study.bestOfN; candidate++) tries.push(await this.attempt(study, task, preset, repeat));
    const best = tries.slice().sort((a, b) => Number(b.passed) - Number(a.passed) || b.score - a.score || a.ms - b.ms)[0]!;
    return study.bestOfN > 1 ? { ...best, candidates: tries.map((entry) => entry.score) } : best;
  }

  /** One go at one task, retried when the machinery itself fails rather than the model. */
  private async attempt(study: Study, task: StudyTask, preset: string, repeat: number): Promise<StudyCell> {
    let attempts = 0, lastError = "";
    while (attempts <= study.retries) {
      attempts++;
      try { return { ...(await this.once(study, task, preset)), taskId: task.id, preset, repeat, attempts }; }
      catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    }
    return { taskId: task.id, preset, repeat, attempts, passed: false, score: 0, ms: 0, tokens: 0, dollars: null, runId: null, reasons: [lastError] };
  }

  private async once(study: Study, task: StudyTask, preset: string): Promise<Omit<StudyCell, "taskId" | "preset" | "repeat" | "attempts">> {
    const began = Date.now();
    const run = await this.runtime.run({
      prompt: task.prompt, model: preset, budget: { maxSteps: study.maxSteps, maxTokens: study.maxTokens },
      traceAttributes: { "branch.study.id": study.id, "branch.benchmark.id": study.source.kind === "benchmark" ? study.source.benchmark : study.source.suite, "branch.study.task": task.id },
    });
    const usage = this.store.usage(run.id);
    const tokens = { input: usage.estimatedInput ?? 0, output: usage.estimatedOutput ?? 0 };
    const dollars = estimateCost(preset, tokens, pricingSettings(this.store, this.owner).overrides).amount;
    const ms = Date.now() - began, total = tokens.input + tokens.output;
    const trajectory = readTrajectory(this.store, run.id, { ms, tokens: total, dollars });
    const verdict = await this.decide(task, run.output, trajectory, run.status);
    return { passed: verdict.pass, score: verdict.score, ms, tokens: total, dollars, runId: run.id, reasons: verdict.reasons };
  }

  /** How a task is decided: its own judge when it came from a benchmark, else its scorers. */
  private async decide(
    task: StudyTask, answer: string, trajectory: ScoredTrajectory, status: string,
  ): Promise<{ pass: boolean; score: number; reasons: string[] }> {
    if (status !== "completed") return { pass: false, score: 0, reasons: [`The task did not finish (${status})`] };
    if (task.judge) { const judged = await task.judge(answer); return { ...judged, score: judged.pass ? 1 : 0 }; }
    const scored = await scoreTrajectory(task.scorers, { workspace: this.runtime.workspace, judge: runtimeJudge(this.runtime), judgeCache: this.judgeCache },
      { id: task.id, prompt: task.prompt, expected: task.expected }, trajectory, answer);
    return scored ? { pass: scored.pass, score: scored.score, reasons: scored.reasons } : { pass: true, score: 1, reasons: [] };
  }

  /** The tasks a study will run: from one of the owner's suites, or from a benchmark's own files. */
  private async tasksFor(study: Study): Promise<StudyTask[]> {
    const chosen = (all: StudyTask[]): StudyTask[] =>
      (study.subset.length ? study.subset.flatMap((id) => all.filter((task) => task.id === id)) : all).slice(0, study.limit);
    if (study.source.kind === "suite") {
      const suite = findSuite(this.store, this.owner, study.source.suite);
      return chosen(suite.tasks.map((task) => ({ id: task.id, prompt: task.prompt, expected: task.expected, scorers: task.scorers })));
    }
    const adapter = findBenchmarkAdapter(study.source.benchmark);
    const directory = study.source.directory;
    const found = chosen((await adapter.discover(directory)).map((task) => ({ id: task.id, prompt: task.prompt, expected: task.expected })));
    const byId = new Map((await adapter.discover(directory)).map((task) => [task.id, task]));
    return Promise.all(found.map((task) => this.benchmarkTask(adapter, byId.get(task.id)!, directory, study)));
  }

  /** One benchmark task: a folder of its own inside the workspace, and the benchmark's own judge. */
  private async benchmarkTask(adapter: BenchmarkAdapter, task: BenchmarkTask, directory: string, study: Study): Promise<StudyTask> {
    const into = join(this.runtime.workspace, "benchmarks", study.id, task.id);
    const ready = await adapter.prepare(task, into, directory);
    const where = join("benchmarks", study.id, task.id).replace(/\\/g, "/");
    return {
      id: task.id,
      prompt: ready.refusal ? ready.prompt : `${ready.prompt}\n\nWork in the folder ${where} of your workspace.`,
      expected: task.expected,
      judge: ready.refusal
        ? async () => ({ pass: false, reasons: [ready.refusal!] })
        : async (answer: string) => {
          const judged = await adapter.judge(task, { answer, workspace: into }, directory);
          return { pass: judged.pass, reasons: judged.reasons };
        },
    };
  }

  private clearCheckpoints(studyId: string): void {
    for (const record of this.store.list("governance", this.owner))
      if (record.id.startsWith(`study-cell:${studyId}:`)) this.store.delete("governance", this.owner, record.id);
  }

  private finish(study: Study, tasks: StudyTask[], cells: StudyCell[], startedAt: string, resumed: number, stoppedEarly: string | null): StudyRunResult {
    const rows = study.presets.map((preset) => {
      const mine = cells.filter((cell) => cell.preset === preset);
      const priced = mine.filter((cell) => cell.dollars !== null);
      return {
        preset, tasks: mine.length, passed: mine.filter((cell) => cell.passed).length,
        accuracy: mine.length ? Math.round((mine.filter((cell) => cell.passed).length / mine.length) * 1000) / 1000 : 0,
        meanMs: mine.length ? Math.round(mine.reduce((total, cell) => total + cell.ms, 0) / mine.length) : 0,
        tokens: mine.reduce((total, cell) => total + cell.tokens, 0),
        dollars: priced.length ? Math.round(priced.reduce((total, cell) => total + (cell.dollars ?? 0), 0) * 1e6) / 1e6 : null,
      };
    });
    const result: StudyRunResult = {
      id: randomUUID(), studyId: study.id, name: study.name, startedAt, finishedAt: new Date().toISOString(),
      presets: study.presets, tasks: tasks.map((task) => task.id), cells, rows, resumed, stoppedEarly,
    };
    this.store.save("governance", this.owner, `study-run:${result.id}`, { ...result });
    return result;
  }
}

/* ------------------------------------------------------------- comparison */

/** A small repeatable random number generator, so the same two studies always give the same interval. */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

/** The mean score of each task, so repeats count once and a task is the unit of the comparison. */
function perTask(result: StudyRunResult): Map<string, number> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const cell of result.cells) {
    const entry = sums.get(cell.taskId) ?? { total: 0, count: 0 };
    sums.set(cell.taskId, { total: entry.total + (cell.passed ? 1 : 0), count: entry.count + 1 });
  }
  return new Map([...sums].map(([id, entry]) => [id, entry.total / entry.count]));
}

export interface StudyComparison {
  a: { id: string; name: string; accuracy: number };
  b: { id: string; name: string; accuracy: number };
  /** Tasks both studies ran; only these can be compared. */
  tasks: number;
  delta: number;
  /** The range the difference is very likely to be in, from resampling the tasks 2000 times. */
  interval: { low: number; high: number };
  /** True when the whole range is on one side of zero, so the difference is worth believing. */
  clear: boolean;
}

/**
 * Compares two study results over the tasks they both ran. The interval comes from resampling the
 * tasks with replacement two thousand times — no library, and the same answer every time, because
 * the generator is seeded by the two studies' own ids.
 */
export function compareStudies(a: StudyRunResult, b: StudyRunResult): StudyComparison {
  const left = perTask(a), right = perTask(b);
  const shared = [...left.keys()].filter((id) => right.has(id));
  if (!shared.length) throw new Error("These two studies have no task in common, so there is nothing to compare");
  const differences = shared.map((id) => right.get(id)! - left.get(id)!);
  const mean = (values: number[]): number => values.reduce((total, value) => total + value, 0) / values.length;
  const random = seeded([...a.id, ...b.id].reduce((total, character) => total + character.charCodeAt(0), 7));
  const samples: number[] = [];
  for (let round = 0; round < 2000; round++)
    samples.push(mean(shared.map(() => differences[Math.floor(random() * differences.length)]!)));
  samples.sort((x, y) => x - y);
  const low = samples[Math.floor(0.025 * samples.length)]!, high = samples[Math.floor(0.975 * samples.length)]!;
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return {
    a: { id: a.id, name: a.name, accuracy: round(mean(shared.map((id) => left.get(id)!))) },
    b: { id: b.id, name: b.name, accuracy: round(mean(shared.map((id) => right.get(id)!))) },
    tasks: shared.length, delta: round(mean(differences)),
    interval: { low: round(low), high: round(high) }, clear: low > 0 || high < 0,
  };
}

/** The comparison as a table a person can read. */
export function comparisonTable(comparison: StudyComparison): string {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  return [
    "| Study | Accuracy |", "| --- | ---: |",
    `| ${comparison.a.name} | ${percent(comparison.a.accuracy)} |`,
    `| ${comparison.b.name} | ${percent(comparison.b.accuracy)} |`, "",
    `Difference over the ${comparison.tasks} task(s) both ran: ${percent(comparison.delta)} (very likely between ${percent(comparison.interval.low)} and ${percent(comparison.interval.high)}).`,
    comparison.clear ? "That range does not include zero, so the difference is worth believing." : "That range includes zero, so this is not yet a real difference.",
  ].join("\n");
}
