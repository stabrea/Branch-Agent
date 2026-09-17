/**
 * The reproducibility journal: what a study was when it ran, written down beside what it found, so
 * that running it again months later either gets the same answer or says why it could not.
 *
 * A number on its own is not evidence. "78% on twenty GAIA questions" means nothing without which
 * twenty, which model choices, how many repeats, which scorers, and which version of the program —
 * and those are exactly the things that drift. An entry keeps all of them and boils them down to
 * one fingerprint: two entries with the same fingerprint measured the same thing, and two that do
 * not are named, field by field, before their accuracies are ever put side by side.
 *
 * Nothing here talks to a store, a model or the network. It takes a study and its result and gives
 * back plain data, which is what makes it something a test can pin down.
 */
import { createHash } from "node:crypto";
import type { Study, StudyRunResult, StudyComparison } from "./study.js";

export const journalFormat = "branch-agent-study-journal";
export const journalVersion = 1;

/** Everything that decides what a study measures, as opposed to what it found. */
export interface JournalInputs {
  /** The study exactly as it was written when it ran. */
  study: Study;
  /** The task ids it actually ran, in order. A dataset that grew since is visible here. */
  tasks: string[];
  /** Every kind of scorer the tasks used, sorted, each once. */
  scorerKinds: string[];
  /** The one folder benchmark files were allowed to come from. */
  benchmarksFolder: string;
  /** The version of Branch Agent that ran it. */
  version: string;
}

export interface JournalEntry {
  format: string;
  formatVersion: number;
  studyId: string;
  /** The study run this is the journal of. */
  runId: string;
  name: string;
  startedAt: string;
  finishedAt: string;
  inputs: JournalInputs;
  /** One short string standing for every input above. Same fingerprint, same experiment. */
  fingerprint: string;
  outcome: { tasks: number; cells: number; passed: number; accuracy: number; dollars: number | null; meanMs: number; resumed: number };
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** The fingerprint: a hash of the inputs written in a fixed order, so it never moves on its own. */
export function fingerprintOf(inputs: JournalInputs): string {
  const ordered = {
    source: inputs.study.source, presets: [...inputs.study.presets].sort(), repeats: inputs.study.repeats,
    limit: inputs.study.limit, bestOfN: inputs.study.bestOfN, maxSteps: inputs.study.maxSteps,
    maxTokens: inputs.study.maxTokens, tasks: inputs.tasks, scorerKinds: [...inputs.scorerKinds].sort(),
    benchmarksFolder: inputs.benchmarksFolder, version: inputs.version,
  };
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 16);
}

/** One journal entry from a finished study run. */
export function journalEntry(result: StudyRunResult, inputs: JournalInputs): JournalEntry {
  const passed = result.cells.filter((cell) => cell.passed).length;
  const ms = result.cells.reduce((total, cell) => total + cell.ms, 0);
  const priced = result.cells.filter((cell) => cell.dollars !== null);
  return {
    format: journalFormat, formatVersion: journalVersion,
    studyId: result.studyId, runId: result.id, name: result.name,
    startedAt: result.startedAt, finishedAt: result.finishedAt,
    inputs, fingerprint: fingerprintOf(inputs),
    outcome: {
      tasks: result.tasks.length, cells: result.cells.length, passed,
      accuracy: result.cells.length ? round(passed / result.cells.length) : 0,
      dollars: priced.length ? round(priced.reduce((total, cell) => total + (cell.dollars ?? 0), 0)) : null,
      meanMs: result.cells.length ? Math.round(ms / result.cells.length) : 0,
      resumed: result.resumed,
    },
  };
}

/** The study to save and run to repeat an entry exactly, including only the tasks it ran. */
export function journalReplayPlan(entry: JournalEntry): Study {
  return { ...entry.inputs.study, subset: [...entry.inputs.tasks], limit: Math.max(1, entry.inputs.tasks.length) };
}

export interface JournalChange { what: string; before: string; after: string }

const list = (values: readonly string[]): string => (values.length ? values.join(", ") : "none");

/**
 * What changed between two runs of the same study, field by field. This is the half that has to be
 * read before the accuracies are: a study that got better after its task list shrank did not.
 */
export function journalDiff(before: JournalEntry, after: JournalEntry): { same: boolean; changes: JournalChange[] } {
  const changes: JournalChange[] = [];
  const note = (what: string, a: string, b: string): void => { if (a !== b) changes.push({ what, before: a, after: b }); };
  const [x, y] = [before.inputs, after.inputs];
  note("Where the tasks came from", JSON.stringify(x.study.source), JSON.stringify(y.study.source));
  note("Which tasks ran", list(x.tasks), list(y.tasks));
  note("Model choices", list(x.study.presets), list(y.study.presets));
  note("Repeats of each task", String(x.study.repeats), String(y.study.repeats));
  note("Best of how many tries", String(x.study.bestOfN), String(y.study.bestOfN));
  note("Rounds a task may take", String(x.study.maxSteps), String(y.study.maxSteps));
  note("Tokens a task may use", String(x.study.maxTokens), String(y.study.maxTokens));
  note("Scorers used", list(x.scorerKinds), list(y.scorerKinds));
  note("Benchmarks folder", x.benchmarksFolder || "the workspace only", y.benchmarksFolder || "the workspace only");
  note("Version of Branch Agent", x.version, y.version);
  return { same: changes.length === 0, changes };
}

/**
 * The two entries as something a person reads: first whether they measured the same thing, then
 * what moved. The accuracy difference is only called real when a comparison is handed in, because
 * working out whether a difference is worth believing is the study's own job, not the journal's.
 */
export function journalReport(before: JournalEntry, after: JournalEntry, comparison?: StudyComparison): string {
  const difference = journalDiff(before, after);
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const lines = [
    `### ${after.name}: this run against ${before.startedAt.slice(0, 10)}`, "",
    difference.same
      ? `Both runs measured the same thing (fingerprint ${after.fingerprint}).`
      : `These two runs did **not** measure the same thing. ${difference.changes.length} thing(s) changed:`,
  ];
  if (!difference.same)
    lines.push("", "| What | Before | Now |", "| --- | --- | --- |",
      ...difference.changes.map((change) => `| ${change.what} | ${change.before} | ${change.after} |`));
  lines.push("", `Accuracy went from ${percent(before.outcome.accuracy)} to ${percent(after.outcome.accuracy)}.`);
  if (comparison)
    lines.push(comparison.clear
      ? `Over the ${comparison.tasks} task(s) both ran that is ${percent(comparison.delta)}, and the range does not include zero, so it is worth believing.`
      : `Over the ${comparison.tasks} task(s) both ran that is ${percent(comparison.delta)}, and the range still includes zero, so it is not yet a real difference.`);
  if (!difference.same) lines.push("", "Change one thing at a time, or the difference above cannot be pinned on any of them.");
  return lines.join("\n");
}
