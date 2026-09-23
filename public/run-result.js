/* Q52: what a finished task made and how that was checked, from GET /api/runs/:id/result (src/results.ts). Each
   thing made carries the proof its tool's receipt gives; merged and "in a release" stay "unknown" because nothing
   records them. */
import { t } from "/i18n.js";

const say = (key, fallback, values) => { const words = t(key, values); return words === key ? fallback : words; };
const PROOF = {
  success: ["result.proof.success", "checked and confirmed"],
  unsigned: ["result.proof.unsigned", "no proof was kept"],
  forged: ["result.proof.forged", "the proof did not match"],
  modified: ["result.proof.modified", "changed after it was done"],
  stalled: ["result.proof.stalled", "stopped part-way"],
  failed: ["result.proof.failed", "did not work"],
  blocked: ["result.proof.blocked", "not allowed"],
  "not recorded": ["result.proof.none", "no receipt recorded"],
};
const proofWords = (proof) => say(...(PROOF[proof] ?? [`result.proof.${proof}`, String(proof)]));
const name = (path) => String(path).split(/[\\/]/).filter(Boolean).at(-1) || String(path);

/** Rows for the Activity pane: [{ title, meta, kind }] where kind is "head" for a group heading. */
export function resultRows(result) {
  if (!result) return [];
  const out = [];
  if (result.made?.length) {
    out.push({ kind: "head", title: say("result.made", "What it made") });
    for (const one of result.made)
      out.push({ kind: "made", title: name(one.path), meta: `${one.created ? say("result.created", "new") : say("result.changed", "changed")} · ${proofWords(one.proof)}`, path: one.path });
  }
  if (result.checked?.length || result.ownChange) {
    out.push({ kind: "head", title: say("result.checked", "How it was checked") });
    for (const one of result.checked ?? [])
      out.push({ kind: "checked", title: one.kind === "review" ? say("result.review", "Reviewer") : say("result.check", "Project check"),
        meta: one.passed ? say("result.passed", "passed") : say("result.not-passed", "did not pass") });
  }
  const own = result.ownChange;
  if (own) {
    const tests = { passed: say("result.tests.passed", "tests passed"), failed: say("result.tests.failed", "tests failed"), "not run": say("result.tests.none", "tests not run") }[own.tests];
    const review = own.review === "pending" ? say("result.review.pending", "review pending") : say("result.review.none", "no review opened");
    const code = own.codeChanged ? say("result.code.changed", "code changed") : say("result.code.none", "no code changed");
    out.push({ kind: "own", title: say("result.own", "Branch's own change"),
      meta: [code, tests, review, say("result.merged.unknown", "merged: unknown"), say("result.release.unknown", "in a release: unknown")].join(" · ") });
  }
  return out;
}
