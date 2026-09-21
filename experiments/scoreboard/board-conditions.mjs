/**
 * One contestant's conditions, rebuilt from the rows it actually produced.
 *
 * This is deliberately not the object the runner set out with. The runner writes what it *intended*
 * onto every row; this reads those stamps back and insists they agree, so that two result files
 * from two windows can be put together and the honesty module can still be asked whether they
 * measured the same thing. If one contestant's own rows disagree about the model or the machine,
 * the disagreement is put into the field itself, and `comparisonRefusal` then names it.
 *
 * The contestant is not a field here on purpose: it is the one thing the board varies, and the
 * refusal exists to catch anything *else* that moved.
 */
import { combinedBasis, scorerDigest } from "../../dist/evaluation-honesty.js";

/** Fingerprints the programs that decide pass/fail, including shared marking helpers when supplied. */
export function programScorerDigest(tasks, markingSource = "") {
  const scorers = tasks.map((task) => ({
    id: task.id,
    kind: "program",
    readOnly: !!task.readOnly,
    restoreVerify: !!task.restoreVerify,
    checkSource: Function.prototype.toString.call(task.check),
  }));
  if (markingSource) scorers.push({ id: "task-module", kind: "program-source", checkSource: markingSource });
  return scorerDigest({
    scorers,
    judgeModel: null,
    benchmarkJudge: "the harness runs a program; no model marks anything",
  });
}

export function conditionsOf(rows) {
  const one = (pick, name) => {
    const values = [...new Set(rows.map((row) => pick(row.observed ?? {})))].filter((value) => value !== undefined);
    return values.length === 1 ? String(values[0]) : `${values.length} different values for ${name}: ${values.join(" / ")}`;
  };
  return {
    version: 2,
    presets: [one((o) => o.model, "model")],
    models: [one((o) => o.model, "model")],
    judgeModel: null,
    settings: {
      endpoint: one((o) => o.endpoint, "endpoint"),
      timeoutSeconds: one((o) => o.timeoutSeconds, "deadline"),
      contextWindowTokens: one((o) => o.contextWindowTokens, "context window"),
    },
    appVersion: one((o) => o.appVersion, "harness version"),
    machine: one((o) => o.machine, "machine"),
    taskSetHash: one((o) => o.taskSetHash, "task set"),
    scorerDigest: one((o) => o.scorerDigest, "scorers"),
    costBasis: combinedBasis(rows.map((row) => row.usage?.basis ?? "unknown")),
  };
}
