# Coding bench — status

- Branch `mac7/coding-gap`. Fixes committed: tolerant patch placement + `*** Begin Patch`
  (src/patch.ts), whitespace-tolerant edits with helpful refusals + argument aliases
  (src/text-replace.ts, src/code-edit.ts, src/code-change.ts), caller-set run deadline
  (runtime `timeoutMs`, cli-run), empty-reply nudge (runtime loop), actionable `code.check`
  note + `node --test` fallback when the owner's run-scripts switch is on.
- Window 3 (the one that counts) runs on taofik-ai: `/workspace/bench/cg/run.sh window3
  branch-before,branch-after,branch-after-scripts,codex,openclaw "" 1`, results in
  `/workspace/bench/cg/window3/results.jsonl`, per-cell stdout in `window3/logs/`.
  Builds: `/workspace/bench/cg/before` (36ee8abb + harness), `/workspace/bench/cg/after` (this branch).
- Windows 0–2 were stopped early each time a new fix landed and are not reported.
- To report: copy results.jsonl here as `results-window3.jsonl`, then
  `node experiments/coding-bench/report.mjs experiments/coding-bench/results-window3.jsonl`
  and paste into docs/agents/coding-bench.md §3.
