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
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Runtime } from "./runtime.js";
import type { ExecutionLimit } from "./execution-limit.js";
import { codeRunSettings } from "./code-run.js";
import { estimateCost, pricingSettings } from "./pricing.js";
import { findSuite, type EvaluationTask } from "./evaluation-suites.js";
import { denyProblem } from "./evaluation-grading.js";
import { evaluateChecks } from "./reliability.js";
import { readTrajectory, runtimeJudge, scoreTrajectory } from "./evaluation-run.js";
import type { ScoredTrajectory } from "./evaluation-scorers.js";
import { findBenchmarkAdapter } from "./benchmark-adapters.js";
import type { BenchmarkAdapter, BenchmarkBrowser, BenchmarkTask, LiveAttempt } from "./benchmarks.js";
import { datasetVersionOf, journalEntry, journalReport, journalReplayPlan, type JournalEntry } from "./study-journal.js";
import {
  combinedBasis, comparisonRefusal, completenessRefusal, conditionsVersion, costNote, incompleteWarning,
  ledgerTokens, machineIdentity, scorerDigest, spreadOf,
  type Completeness, type CostBasis, type RunConditions, type Spread,
} from "./evaluation-honesty.js";

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
  /**
   * How many tasks run at once. Capped at half the eight this computer allows altogether, because
   * a running study holds one of those eight places for as long as it lasts and its own tasks do
   * not take places of their own: the cap is what keeps a study plus ordinary work under that
   * ceiling.
   */
  concurrency: z.number().int().min(1).max(4).default(2),
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
  /** Whether the tokens behind `dollars` were the provider's own count or Branch's guess. */
  costBasis?: CostBasis;
  /** Set when nothing decided this task, so a run cannot go green while measuring nothing. */
  ungraded?: boolean;
}
export interface StudyRunResult {
  id: string; studyId: string; name: string; startedAt: string; finishedAt: string;
  presets: string[]; tasks: string[]; cells: StudyCell[];
  rows: {
    preset: string; tasks: number; passed: number; accuracy: number; meanMs: number; tokens: number; dollars: number | null;
    /** Where the money figure came from; never printed without saying which. */
    costBasis?: CostBasis;
    /** Repeats of the same task as a range rather than one number, when the study repeated anything. */
    spread?: Spread | null;
    /** How many of this choice's cells nothing decided at all. */
    ungraded?: number;
  }[];
  /** How many cells were already done when the study was picked back up. */
  resumed: number;
  stoppedEarly: string | null;
  /**
   * What this run was measured under. A result without it cannot be compared with anything: see
   * `comparisonRefusal`. Missing on results written before this existed, which is the point.
   */
  conditions?: RunConditions;
  /** What the run set out to do against what it actually recorded. */
  completeness?: Completeness;
}

const cellKey = (studyId: string, cell: { preset: string; taskId: string; repeat: number }): string =>
  `study-cell:${studyId}:${cell.preset}:${cell.taskId}:${cell.repeat}`;

/**
 * The plain-language table a person reads, and a study report pastes in unchanged.
 *
 * Three things are said out loud rather than left to be assumed: what a repeated task's accuracy
 * actually ranged over, where the money figure came from, and whether anything the run planned
 * produced no result at all. The last is the one that matters most — a run missing pieces has a
 * smaller denominator, and a smaller denominator flatters whatever is left.
 */
export function studyTable(result: StudyRunResult): string {
  const head = "| Model choice | Tasks | Right | Accuracy | Over repeats | Mean ms | Tokens | Cost |";
  const rule = "| --- | ---: | ---: | ---: | :---: | ---: | ---: | ---: |";
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const range = (spread: Spread | null | undefined): string =>
    !spread || spread.repeats < 2 ? "one repeat" : `${percent(spread.low)}–${percent(spread.high)}`;
  const rows = result.rows.map((row) =>
    `| ${row.preset} | ${row.tasks} | ${row.passed} | ${percent(row.accuracy)} | ${range(row.spread)} | ${row.meanMs} | ${row.tokens} | `
    + `${row.dollars === null ? "no price on file" : "$" + row.dollars.toFixed(4)} |`);
  const basis = combinedBasis(result.rows.flatMap((row) => (row.costBasis ? [row.costBasis] : [])));
  const priced = result.rows.some((row) => row.dollars !== null);
  const warning = result.completeness ? incompleteWarning(result.completeness) : null;
  const ungraded = result.rows.reduce((total, row) => total + (row.ungraded ?? 0), 0);
  return [
    `### ${result.name}`, "",
    ...(warning ? [`**${warning}**`, ""] : []),
    ...(ungraded ? [`**${ungraded} task(s) had nothing that could decide them, and are counted as not right.**`, ""] : []),
    head, rule, ...rows, "",
    `Cost: ${costNote(basis, priced)}.`,
    ...(result.stoppedEarly ? ["", result.stoppedEarly] : []),
    "",
  ].join("\n");
}
/** Every cell as JSON Lines, one per line, for a spreadsheet or another program to read. */
export function* studyLines(result: StudyRunResult): Generator<string> {
  for (const cell of result.cells) yield JSON.stringify({ study: result.studyId, run: result.id, ...cell });
}

/** One task a study runs, whatever it came from. */
interface StudyTask {
  id: string; prompt: string; expected?: string | undefined; scorers?: unknown[] | undefined;
  /**
   * The task's own checks and its "must not" list, when it came from one of the owner's suites.
   * A study used to drop both, which meant a suite task decided by checks passed every study it
   * was in whatever the answer said. They are carried and applied here instead.
   */
  checks?: EvaluationTask["checks"] | undefined;
  deny?: EvaluationTask["deny"] | undefined;
  judge?: ((answer: string) => Promise<{ pass: boolean; reasons: string[] }>) | undefined;
  /** Why this task cannot be run on this computer. Set, it is failed without asking the model. */
  refusal?: string | undefined;
  /** w911 (A1726): a task in a browser page, opened afresh for every attempt. */
  live?: (() => Promise<LiveAttempt>) | undefined;
}

/** Where a benchmark's files may be read from, and what to say when a study points elsewhere. */
export const StudySettingsSchema = z.object({
  /**
   * One folder outside the workspace that benchmark files may be read from. Empty means the
   * workspace and nothing else, which is where a study starts.
   */
  benchmarksFolder: z.string().trim().max(1000).default(""),
}).strict();
export type StudySettings = z.infer<typeof StudySettingsSchema>;

const within = (root: string, directory: string): boolean => {
  if (!root.trim()) return false;
  const from = resolve(root), to = resolve(directory);
  return to === from || to.startsWith(from.endsWith(sep) ? from : from + sep);
};
/**
 * Why a study may not read a benchmark from this folder, or null when it may. A study names a
 * folder on this computer, so it is confined the same way every other path is: your workspace, or
 * the one benchmarks folder you named in Settings, and nowhere else.
 */
export function benchmarkFolderRefusal(directory: string, workspace: string, allowed: string): string | null {
  if (within(workspace, directory) || within(allowed, directory)) return null;
  return `A study may only read a benchmark from your workspace${allowed ? `, or from ${allowed},` : ""} `
    + `and ${directory} is outside that. Move the files there, or name that folder in Settings, and try again.`;
}

export class StudyRunner {
  private readonly judgeCache = new Map<string, { score: number; reason: string }>();
  /**
   * The one count of how much work this computer is doing at once. A study holds the place its
   * request or waiting-line entry took; every cell it runs beyond the first takes a place of its
   * own and waits for one rather than pushing past the limit.
   */
  executions: ExecutionLimit | undefined;
  /** w911 (A1726) hook: Branch's own browser, when the launch has one, for benchmarks that need a page. */
  browser: BenchmarkBrowser | undefined;
  constructor(
    private readonly store: Store, private readonly runtime: Runtime,
    /** The version of Branch Agent that is running, written into every journal entry. */
    private readonly appVersion = "unknown",
  ) {}
  private get owner(): string { return this.runtime.owner; }
  settings(): StudySettings {
    const saved = StudySettingsSchema.safeParse(this.store.get("settings", this.owner, "studies")?.data ?? {});
    return saved.success ? saved.data : StudySettingsSchema.parse({});
  }
  configure(input: unknown): StudySettings {
    const value = StudySettingsSchema.parse({ ...this.settings(), ...(input as object) });
    this.store.save("settings", this.owner, "studies", value);
    return value;
  }

  /** Saves a study so it can be run again exactly as written. */
  save(input: unknown): Study {
    const study = StudySchema.parse(input);
    if (study.source.kind === "benchmark") {
      const refusal = benchmarkFolderRefusal(study.source.directory, this.runtime.workspace, this.settings().benchmarksFolder);
      if (refusal) throw new Error(refusal);
    }
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
    // A grader's answer is only reused within one study; two studies may be grading different work.
    this.judgeCache.clear();
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
    // What the study set out to do, so a cell that never produced a result is named rather than
    // dropped from the denominator. A worker that gave up waiting for a place leaves cells here.
    const wanted = planned.map((item) => `${item.preset}/${item.task.id}/${item.repeat}`);
    const got = new Set([...done.values()].map((cell) => `${cell.preset}/${cell.taskId}/${cell.repeat}`));
    const completeness: Completeness = { planned: wanted.length, recorded: got.size, missing: wanted.filter((key) => !got.has(key)) };
    return this.finish(study, tasks, [...done.values()], startedAt, resumed, stopped, completeness);
  }

  /**
   * Runs what is left, `concurrency` at a time, writing each result down the moment it lands.
   *
   * Every cell is a piece of work this computer is doing, so every cell takes a place from the one
   * shared count. The study already holds a place — the request or the waiting-line entry that set
   * it going — and the first worker runs on that one, which is what makes several studies at once
   * safe: each of them can always make progress on a place it already has, whatever the others are
   * doing, so none can be starved and none can deadlock. Every other worker asks for a place of its
   * own and waits for one rather than pushing past the limit.
   */
  private async workThrough(
    study: Study, queue: { task: StudyTask; preset: string; repeat: number }[], done: Map<string, StudyCell>,
  ): Promise<string | null> {
    let next = 0, stopped: string | null = null;
    const spend = () => [...done.values()].reduce((total, cell) => total + (cell.dollars ?? 0), 0);
    const worker = async (onTheStudysOwnPlace: boolean): Promise<void> => {
      while (next < queue.length && !stopped) {
        if (study.maxDollars !== undefined && spend() > study.maxDollars) { stopped = `The study stopped after $${spend().toFixed(4)}, which is over the $${study.maxDollars.toFixed(4)} it was given.`; return; }
        const place = onTheStudysOwnPlace ? () => undefined : await this.placeForACell();
        // No place came free in a reasonable time: this worker stops and the ones that have a place
        // finish the queue between them. Slower, never stuck.
        if (!place) return;
        const item = queue[next++]!;
        try {
          const cell = await this.runCell(study, item.task, item.preset, item.repeat);
          done.set(cellKey(study.id, cell), cell);
          this.store.save("governance", this.owner, cellKey(study.id, cell), { ...cell });
        } finally { place(); }
      }
    };
    const workers = Math.min(study.concurrency, queue.length || 1);
    await Promise.all(Array.from({ length: workers }, (_, index) => worker(index === 0)));
    return stopped;
  }
  /** How long a cell waits for a place before giving up its turn and letting the others finish. */
  waitForPlaceMs = 30_000;
  /** A place from the shared count, waited for rather than refused; null when none came free. */
  private async placeForACell(): Promise<(() => void) | null> {
    const limit = this.executions;
    if (!limit) return () => undefined;
    const deadline = Date.now() + this.waitForPlaceMs;
    for (;;) {
      const place = limit.take();
      if (place) return place;
      if (Date.now() >= deadline) return null;
      await limit.roomSoon(200);
    }
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
    // A task that cannot be run here is failed straight away: asking the model to attempt it would
    // cost money and hide the reason behind whatever it happened to answer.
    if (task.refusal) return { passed: false, score: 0, ms: 0, tokens: 0, dollars: 0, runId: null, reasons: [task.refusal] };
    // w911 (A1726) hook: a page opened for this attempt only, with its own prompt and judge.
    const live = task.live ? await task.live() : null;
    try { return await this.measured(study, live ? { ...task, prompt: live.prompt, judge: live.judge } : task, preset, live); }
    finally { await live?.close(); }
  }

  private async measured(study: Study, task: StudyTask, preset: string, live: LiveAttempt | null): Promise<Omit<StudyCell, "taskId" | "preset" | "repeat" | "attempts">> {
    const began = Date.now();
    const run = await this.runtime.run({
      ...(live ? { onStarted: (started: { id: string }) => live.started(started.id) } : {}),
      prompt: task.prompt, measured: true, model: preset, budget: { maxSteps: study.maxSteps, maxTokens: study.maxTokens },
      traceAttributes: { "branch.study.id": study.id, "branch.benchmark.id": study.source.kind === "benchmark" ? study.source.benchmark : study.source.suite, "branch.study.task": task.id },
    });
    // The provider's own token count is the ledger; Branch's estimate is only the fallback for a
    // provider that reports nothing. Which of the two was used travels with the cell, because an
    // estimate must never be read as a bill.
    const counted = ledgerTokens(this.store.usage(run.id));
    const tokens = { input: counted.input, output: counted.output };
    const dollars = estimateCost(preset, tokens, pricingSettings(this.store, this.owner).overrides).amount;
    const ms = Date.now() - began, total = tokens.input + tokens.output;
    const trajectory = readTrajectory(this.store, run.id, { ms, tokens: total, dollars });
    // Grading with a model is a model call like any other, so what the grader spends is added to
    // this cell — as it happens, so that "did it stay inside its budget" sees it too.
    const judged = { tokens: 0, dollars: 0 };
    const verdict = await this.decide(task, run.output, trajectory, run.status, (cost) => {
      judged.tokens += cost.tokens;
      judged.dollars += cost.dollars ?? 0;
      trajectory.tokens += cost.tokens;
      if (trajectory.dollars !== null) trajectory.dollars += cost.dollars ?? 0;
    });
    return { passed: verdict.pass, score: verdict.score, ms, tokens: total + judged.tokens,
      dollars: dollars === null ? null : dollars + judged.dollars, runId: run.id, reasons: verdict.reasons,
      costBasis: dollars === null ? "unknown" : counted.basis, ...(verdict.ungraded ? { ungraded: true } : {}) };
  }

  /** How a task is decided: its own judge when it came from a benchmark, else its scorers. */
  private async decide(
    task: StudyTask, answer: string, trajectory: ScoredTrajectory, status: string,
    spent: (cost: { tokens: number; dollars: number | null }) => void = () => undefined,
  ): Promise<{ pass: boolean; score: number; reasons: string[]; ungraded?: boolean }> {
    if (status !== "completed") return { pass: false, score: 0, reasons: [`The task did not finish (${status})`] };
    if (task.judge) { const judged = await task.judge(answer); return { ...judged, score: judged.pass ? 1 : 0 }; }
    // What the task said must not happen is fatal, and decided without a model, as it is everywhere
    // else. A study used to ignore this entirely.
    const forbidden = task.deny ? await denyProblem(answer, { ...task, deny: task.deny } as never, this.runtime.workspace) : null;
    if (forbidden) return { pass: false, score: 0, reasons: [forbidden] };
    const scored = await scoreTrajectory(task.scorers, { workspace: this.runtime.workspace, judge: runtimeJudge(this.runtime, spent), judgeCache: this.judgeCache },
      { id: task.id, prompt: task.prompt, expected: task.expected }, trajectory, answer);
    if (!scored && task.checks) {
      const problem = await evaluateChecks(answer, { ...task.checks, maxRetries: 0 }, this.runtime.workspace);
      return problem ? { pass: false, score: 0, reasons: [problem] } : { pass: true, score: 1, reasons: [] };
    }
    if (!scored && task.deny) return { pass: true, score: 1, reasons: [] };
    // A task with nothing that could decide it used to pass, which is how a study goes green while
    // measuring nothing. It is now counted as not right and named, so the suite says what is wrong
    // with itself instead of quietly inflating its own accuracy.
    return scored
      ? { pass: scored.pass, score: scored.score, reasons: scored.reasons }
      : { pass: false, score: 0, ungraded: true, reasons: [`${task.id} has no checks, no scorers and no judge, so nothing could decide it. Give it a check or a scorer, or take it out of the study.`] };
  }

  /** The tasks a study will run: from one of the owner's suites, or from a benchmark's own files. */
  private async tasksFor(study: Study): Promise<StudyTask[]> {
    const chosen = (all: StudyTask[]): StudyTask[] =>
      (study.subset.length ? study.subset.flatMap((id) => all.filter((task) => task.id === id)) : all).slice(0, study.limit);
    if (study.source.kind === "suite") {
      const suite = findSuite(this.store, this.owner, study.source.suite);
      return chosen(suite.tasks.map((task) => ({ id: task.id, prompt: task.prompt, expected: task.expected, scorers: task.scorers, checks: task.checks, deny: task.deny })));
    }
    const adapter = findBenchmarkAdapter(study.source.benchmark);
    const directory = study.source.directory;
    // A study names a folder on this computer, so it is confined exactly as every other path is.
    // Checked here rather than only when the study was saved, so an older one is refused too.
    const refusal = benchmarkFolderRefusal(directory, this.runtime.workspace, this.settings().benchmarksFolder);
    if (refusal) throw new Error(refusal);
    const all = await adapter.discover(directory);
    const picked = (study.subset.length ? study.subset.flatMap((id) => all.filter((task) => task.id === id)) : all).slice(0, study.limit);
    return Promise.all(picked.map((task) => this.benchmarkTask(adapter, task, directory, study)));
  }

  /** One benchmark task: a folder of its own inside the workspace, and the benchmark's own judge. */
  private async benchmarkTask(adapter: BenchmarkAdapter, task: BenchmarkTask, directory: string, study: Study): Promise<StudyTask> {
    const into = join(this.runtime.workspace, "benchmarks", study.id, task.id);
    // A benchmark that decides right and wrong by running the tests it ships is starting a program
    // on this computer, so it waits on the same switch a small script does.
    const blocked = adapter.runsPrograms && !codeRunSettings(this.store, this.owner).enabled
      ? `${adapter.name} is marked by running the tests it ships, which means starting a program on this computer. That is switched off. The owner turns on running small scripts in Settings first.`
      : null;
    const ready = blocked ? { workspace: into, prompt: task.prompt, files: [], refusal: blocked } : await adapter.prepare(task, into, directory);
    const where = join("benchmarks", study.id, task.id).replace(/\\/g, "/");
    // w911 (A1726) hook: a benchmark that lives in a page needs Branch's own browser.
    const browser = this.browser, live = adapter.live?.bind(adapter);
    const refusal = ready.refusal ?? (live && !browser ? `${adapter.name} runs in Branch's own browser, and this launch has none. Set up the browser in the integrations file first.` : null);
    const prompt = refusal ? ready.prompt : `${ready.prompt}\n\nWork in the folder ${where} of your workspace.`;
    return {
      id: task.id,
      prompt,
      expected: task.expected,
      ...(refusal ? { refusal } : {}),
      ...(live && browser ? { live: () => live(task, { ...ready, prompt }, browser, this.owner) } : {}),
      judge: async (answer: string) => {
        const judged = await adapter.judge(task, { answer, workspace: into }, directory);
        return { pass: judged.pass, reasons: judged.reasons };
      },
    };
  }

  private clearCheckpoints(studyId: string): void {
    for (const record of this.store.list("governance", this.owner))
      if (record.id.startsWith(`study-cell:${studyId}:`)) this.store.delete("governance", this.owner, record.id);
  }

  private finish(study: Study, tasks: StudyTask[], cells: StudyCell[], startedAt: string, resumed: number, stoppedEarly: string | null, completeness: Completeness): StudyRunResult {
    const rows = study.presets.map((preset) => {
      const mine = cells.filter((cell) => cell.preset === preset);
      const priced = mine.filter((cell) => cell.dollars !== null);
      // A repeated task is reported as the range its repeats covered, not as their mean alone: one
      // task that passed once in three is not the same measurement as one that passed every time.
      const byRepeat = [...new Set(mine.map((cell) => cell.repeat))].sort()
        .map((repeat) => mine.filter((cell) => cell.repeat === repeat))
        .filter((group) => group.length)
        .map((group) => group.filter((cell) => cell.passed).length / group.length);
      return {
        preset, tasks: mine.length, passed: mine.filter((cell) => cell.passed).length,
        accuracy: mine.length ? Math.round((mine.filter((cell) => cell.passed).length / mine.length) * 1000) / 1000 : 0,
        meanMs: mine.length ? Math.round(mine.reduce((total, cell) => total + cell.ms, 0) / mine.length) : 0,
        tokens: mine.reduce((total, cell) => total + cell.tokens, 0),
        dollars: priced.length ? Math.round(priced.reduce((total, cell) => total + (cell.dollars ?? 0), 0) * 1e6) / 1e6 : null,
        costBasis: combinedBasis(mine.flatMap((cell) => (cell.costBasis ? [cell.costBasis] : []))),
        spread: byRepeat.length > 1 ? spreadOf(byRepeat) : null,
        ungraded: mine.filter((cell) => cell.ungraded).length,
      };
    });
    const result: StudyRunResult = {
      id: randomUUID(), studyId: study.id, name: study.name, startedAt, finishedAt: new Date().toISOString(),
      presets: study.presets, tasks: tasks.map((task) => task.id), cells, rows, resumed, stoppedEarly,
      conditions: this.conditionsFor(study, tasks, rows.flatMap((row) => (row.costBasis ? [row.costBasis] : []))),
      completeness,
    };
    this.store.save("governance", this.owner, `study-run:${result.id}`, { ...result });
    this.record(study, tasks, result);
    return result;
  }

  /** Which model grades, when anything in this study is graded by one. Null when nothing is. */
  private judgeModel(tasks: StudyTask[]): string | null {
    const asksAModel = tasks.some((task) => task.judge)
      || tasks.some((task) => (task.scorers ?? []).some((scorer) => (scorer as { kind?: unknown }).kind === "rubric"));
    if (!asksAModel) return null;
    // A grader always runs on whichever model the owner's plan would pick, the same way
    // `runtimeJudge` charges it, so that is the identity that belongs in the conditions.
    try { return this.runtime.models.plan(this.owner, "").choice.model ?? null; } catch { return null; }
  }

  /**
   * Everything about how this run was measured, as opposed to what it found. A result that carries
   * this can be checked against another one; a result without it is refused rather than guessed at.
   */
  private conditionsFor(study: Study, tasks: StudyTask[], bases: CostBasis[]): RunConditions {
    const modelOf = (preset: string): string => {
      try { return this.runtime.models.plan(this.owner, "", { preset }).choice.model ?? preset; } catch { return preset; }
    };
    const judge = this.judgeModel(tasks);
    return {
      version: conditionsVersion,
      presets: [...study.presets].sort(),
      models: [...new Set(study.presets.map(modelOf))].sort(),
      judgeModel: judge,
      settings: {
        maxSteps: study.maxSteps, maxTokens: study.maxTokens, repeats: study.repeats,
        bestOfN: study.bestOfN, limit: study.limit, retries: study.retries,
        source: JSON.stringify(study.source), benchmarksFolder: this.settings().benchmarksFolder,
      },
      appVersion: this.appVersion,
      machine: machineIdentity(),
      taskSetHash: datasetVersionOf(tasks.map(({ id, prompt, expected, scorers }) => ({ id, prompt, expected, scorers }))),
      scorerDigest: scorerDigest({
        scorers: tasks.flatMap((task) => task.scorers ?? []),
        judgeModel: judge,
        benchmarkJudge: study.source.kind === "benchmark" ? study.source.benchmark : null,
      }),
      costBasis: combinedBasis(bases),
    };
  }

  /** The journal entry for one finished run: what the study was, not only what it found. */
  private record(study: Study, tasks: StudyTask[], result: StudyRunResult): void {
    const kinds = new Set<string>();
    for (const task of tasks)
      for (const scorer of task.scorers ?? []) {
        const kind = (scorer as { kind?: unknown }).kind;
        if (typeof kind === "string") kinds.add(kind);
      }
    const entry = journalEntry(result, {
      study, tasks: tasks.map((task) => task.id), scorerKinds: [...kinds].sort(),
      benchmarksFolder: this.settings().benchmarksFolder, version: this.appVersion,
      ...(result.conditions ? { conditions: result.conditions } : {}),
      datasetVersion: datasetVersionOf(tasks.map(({ id, prompt, expected, scorers }) => ({ id, prompt, expected, scorers }))), // w911 (A1082)
    });
    this.store.save("governance", this.owner, `study-journal:${result.id}`, { ...entry });
  }

  /** Every journal entry, newest first, for one study or for all of them. */
  journals(studyId?: string): JournalEntry[] {
    return this.store.list("governance", this.owner)
      .filter((record) => record.id.startsWith("study-journal:"))
      .map((record) => record.data as unknown as JournalEntry)
      .filter((entry) => !studyId || entry.studyId === studyId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * This study run against the one before it: what changed about the experiment first, then what
   * changed about the answer, with the interval worked out the same way `compareStudies` does it.
   */
  replay(studyId: string): { entry: JournalEntry; plan: Study; report: string } {
    const entries = this.journals(studyId);
    const latest = entries[0];
    if (!latest) throw new Error(`No run of ${studyId} has been written down yet, so there is nothing to repeat`);
    const previous = entries[1];
    if (!previous) return { entry: latest, plan: journalReplayPlan(latest), report: `This is the first run of ${latest.name}, so there is nothing to compare it with yet.` };
    const results = this.results(studyId);
    const before = results.find((one) => one.id === previous.runId), after = results.find((one) => one.id === latest.runId);
    // When the two results themselves are no longer on file, nothing is handed in and the report
    // works the refusal out from the entries' own conditions. Handing it null would say "I checked,
    // and there is nothing wrong" — which is exactly the silence this branch is removing.
    const attempt = before && after ? tryCompare(before, after) : undefined;
    return { entry: latest, plan: journalReplayPlan(latest),
      report: journalReport(previous, latest, attempt?.comparison, attempt?.refusal) };
  }
}

/**
 * The comparison, or the reason there is none. Two kinds of "no": a refusal, which is a fact about
 * how the two runs were measured and has to be read out loud, and two studies with no task in
 * common, which is only a fact to mention. Swallowing the first is how a refused comparison used to
 * turn back into an ordinary accuracy line further down the page.
 */
function tryCompare(before: StudyRunResult, after: StudyRunResult): { comparison?: StudyComparison; refusal: string | null } {
  const refusal = studyComparisonRefusal(before, after);
  if (refusal) return { refusal };
  try { return { comparison: compareStudies(before, after), refusal: null }; } catch { return { refusal: null }; }
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
export function studyComparisonRefusal(a: StudyRunResult, b: StudyRunResult): string | null {
  const names = { before: a.name || "the earlier run", after: b.name || "this run" };
  return comparisonRefusal(a.conditions, b.conditions, names)
    ?? completenessRefusal(
      a.completeness ?? { planned: a.cells.length, recorded: a.cells.length, missing: [] },
      b.completeness ?? { planned: b.cells.length, recorded: b.cells.length, missing: [] },
      names);
}

export function compareStudies(a: StudyRunResult, b: StudyRunResult): StudyComparison {
  // Before anything is worked out: were these two runs measured the same way at all? A difference
  // between two runs made under different settings is not a weaker result, it is not a result.
  const refusal = studyComparisonRefusal(a, b);
  if (refusal) throw new Error(refusal);
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
