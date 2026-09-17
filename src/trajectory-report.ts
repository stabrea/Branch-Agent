/**
 * One task read back as a story: what it was asked, every action it took, what came back from each
 * one, and where the time went. The trajectory JSON already holds all of it, but nobody reads a
 * thousand lines of JSON to find out why a task went wrong — this writes the same record out as
 * numbered steps in plain sentences.
 *
 * Nothing is worked out here that is not already in the document, and nothing is asked of a model.
 * Long inputs and outputs are cut short with the number of characters dropped said out loud, so a
 * report never hides that there was more.
 */

/** The parts of a trajectory document this reads. Everything is optional: a thin record still renders. */
export interface TrajectoryDocument {
  run?: { id?: string; prompt?: string; status?: string; output?: string } | null;
  seconds?: number | null;
  rounds?: readonly { model?: string | null; preset?: string | null; seconds?: number | null; failed?: boolean; error?: string | null; cached?: boolean }[];
  calls?: readonly { name: string; status: string; seconds: number | null; input: string | null; output: string | null; receipt: string | null }[];
  plan?: readonly { title: string; detail: string | null }[];
  verdicts?: readonly { verdict: string; reason: string | null }[];
  usage?: { estimatedInput?: number | null; estimatedOutput?: number | null } | null;
}

export interface TrajectoryReportOptions {
  /** How much of one input or output to show. The rest is counted, never silently dropped. */
  clip?: number;
  /** Leave the answer out, for a report that is only about the path. */
  withAnswer?: boolean;
}

const shorten = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit)} … (${value.length - limit} more characters)`;

const wording: Record<string, string> = {
  done: "came back", failed: "failed", practice: "was a practice run and changed nothing", stopped: "was stopped",
};

/**
 * The report. One line per action with what went in, one line with what came back, and a short
 * head and tail so a person knows what the task was and how it ended.
 */
export function renderTrajectory(document: TrajectoryDocument, options: TrajectoryReportOptions = {}): string {
  const clip = options.clip ?? 300;
  const lines = [...heading(document), ...planLines(document), ...actionLines(document, clip)];
  lines.push("", ...tail(document, clip, options.withAnswer !== false));
  return lines.join("\n");
}

function heading(document: TrajectoryDocument): string[] {
  const run = document.run ?? null;
  const rounds = document.rounds ?? [];
  const models = [...new Set(rounds.map((round) => round.model ?? round.preset).filter(Boolean))];
  const seconds = document.seconds === null || document.seconds === undefined ? null : document.seconds;
  return [
    `# What this task did${run?.id ? ` (${run.id})` : ""}`,
    "",
    `Asked: ${run?.prompt ? shorten(run.prompt.replace(/\s+/g, " ").trim(), 300) : "nothing was recorded"}`,
    `Ended: ${run?.status ?? "unknown"}${seconds === null ? "" : ` after ${seconds} seconds`}`,
    `Rounds with the model: ${rounds.length}${models.length ? ` (${models.join(", ")})` : ""}`,
    `Actions: ${(document.calls ?? []).length}`,
    "",
  ];
}

function planLines(document: TrajectoryDocument): string[] {
  const plan = document.plan ?? [];
  if (!plan.length) return [];
  return ["## The plan it wrote", "", ...plan.map((step) => `- ${step.title}${step.detail ? `: ${shorten(step.detail, 200)}` : ""}`), ""];
}

/** Every action, numbered, with what it was given and what it gave back. */
function actionLines(document: TrajectoryDocument, clip: number): string[] {
  const calls = document.calls ?? [];
  if (!calls.length) return ["## What it did", "", "It took no actions at all.", ""];
  const lines = ["## What it did", ""];
  calls.forEach((call, index) => {
    const took = call.seconds === null ? "" : ` in ${call.seconds}s`;
    lines.push(`${index + 1}. **${call.name}** ${wording[call.status] ?? call.status}${took}${call.receipt ? ` — ${call.receipt}` : ""}`);
    lines.push(`   - given: ${call.input ? shorten(call.input.replace(/\s+/g, " ").trim(), clip) : "nothing"}`);
    lines.push(`   - back: ${call.output ? shorten(call.output.replace(/\s+/g, " ").trim(), clip) : "nothing"}`);
  });
  lines.push("");
  return lines;
}

function tail(document: TrajectoryDocument, clip: number, withAnswer: boolean): string[] {
  const lines: string[] = [];
  const failed = (document.rounds ?? []).filter((round) => round.failed);
  if (failed.length)
    lines.push("## Rounds that failed", "", ...failed.map((round) => `- ${round.model ?? "the model"}: ${round.error ?? "no reason recorded"}`), "");
  const verdicts = document.verdicts ?? [];
  if (verdicts.length)
    lines.push("## What the reviewer said", "", ...verdicts.map((one) => `- ${one.verdict}${one.reason ? `: ${shorten(one.reason, 200)}` : ""}`), "");
  const usage = document.usage ?? null;
  const tokens = (usage?.estimatedInput ?? 0) + (usage?.estimatedOutput ?? 0);
  if (tokens) lines.push(`Tokens: ${tokens} (${usage?.estimatedInput ?? 0} in, ${usage?.estimatedOutput ?? 0} out)`, "");
  if (withAnswer && document.run?.output)
    lines.push("## The answer it gave", "", shorten(document.run.output.trim(), clip * 4));
  return lines;
}
