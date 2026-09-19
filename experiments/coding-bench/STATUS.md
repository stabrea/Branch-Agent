# Coding bench — status (2026-09-19)

## Window 5 — started 2026-09-19 16:04 UTC, running unattended on taofik-ai

**Read this first: the two Branch rows stop at the new tests question.** In the first cells both
Branch rows ended `needs_input` after 1–2 model calls with no edit, on
"Let Branch run this project's tests? It would run node --test in <cell folder>." (mac7/coding-next
item 4). With the run-scripts switch off, `code.check`'s `node --test` stand-in now asks instead of
answering "no check is set up", and `branch run` has nobody to answer, so the run ends. Until that is
answered (e.g. a row that stores the owner's "Always for this folder" `code.tests` rule, or a CLI
answer), these rows measure "stops at the first code.check", not the coding fixes, and the read-first
comparison is confounded. The window was left running (Branch cells cost ~1–2 min each); stop it with
`pkill -f 'run-scoreboard.mjs.*window5'` on the VM if it is not wanted.

- Build: trunk `cc212bf5` (coding-next merged: `read-first` switch, unknown arguments dropped, 300 s
  local first reply, tests question), copied with `git archive` to `/workspace/bench/cg/after3`,
  `npm ci && npm run build` with `/workspace/bench/node` (log `/workspace/bench/cg/after3-build.log`).
  `before/experiments/` was already byte-identical to trunk's `experiments/` (md5 checked), so not re-copied.
- Rows (VM only, not in git): `before/experiments/scoreboard/contestants.mjs` (original kept as
  `contestants.mjs.pre-window5`) gained an optional `prepScript` in `branchContestant` — the same
  `/bin/sh -c "node <prep> && exec node dist/cli.js run …"` path `scriptsOn` uses, with `scriptsOn` still
  mapping to `scripts-on.mjs`, so earlier rows are unchanged — and two rows:
  ```js
  branchContestant({ id: "branch-after3", name: "Branch (trunk cc212bf5, coding-next)", root: `${BENCH}/cg/after3`,
    note: "trunk after mac7/coding-next, every switch as shipped" }),
  branchContestant({ id: "branch-after3-readfirst", name: "Branch (trunk cc212bf5, read-first on)", root: `${BENCH}/cg/after3`,
    note: "branch-after3 with the read-before-edit switch (coding part read-first) on", prepScript: "experiments/coding-bench/readfirst-on.mjs" }),
  ```
  `after3/experiments/coding-bench/readfirst-on.mjs` (copy in `before/experiments/coding-bench/`) is
  `scripts-on.mjs` with `app.store.save("settings", app.runtime.owner, "coding-read-first", { mode: "on" })`;
  checked on a throwaway data folder (`codingMode` read back `on`).
- Model warmed first (cold load 105 s); `/workspace/bench/keep-model-warm.sh qwen3-14b-16k` runs under
  `timeout 8h` (log `/workspace/bench/board/keepwarm.log`).
- Command (detached with `setsid -f`, output to `/workspace/bench/cg/window5.log`):
  `cd /workspace/bench/cg && ./run.sh window5 branch-after3,branch-after3-readfirst,codex "" 1`
  — 36 cells, 3 rows × 12 tasks, round robin (codex first in each task).
- First cells (fix-range): codex fail 265 s (tests fail); branch-after3 fail 113 s and
  branch-after3-readfirst fail 65 s, both `needs_input` on the tests question, 0 edits.
- Progress: `tail /workspace/bench/cg/window5.log`, `wc -l /workspace/bench/cg/window5/results.jsonl`
  (36 when done), `pgrep -af run-scoreboard`. Per-cell databases in `window5/state/`, work trees in `window5/work/`.
- Expected finish: ~18:30 UTC if Branch cells keep stopping early; at most ~21:10 UTC (36 × ~8 min).
- Report when done (from `/workspace/bench/cg/before`, `PATH=/workspace/bench/node/bin:$PATH`):
  `node experiments/coding-bench/recount-edits.mjs ../window5/results.jsonl ../window5/state > ../window5/results-recounted.jsonl`
  then `node experiments/coding-bench/report.mjs ../window5/results-recounted.jsonl`; copy the JSONL here as
  `results-window5.jsonl` and write the section in `docs/agents/coding-bench.md`.

## Earlier windows

Done and pushed on `mac7/coding-gap`; results and plan in `docs/agents/coding-bench.md`.

- Windows reported: 3 (5 rows × first 8 tasks, interleaved; `results-window3.jsonl`) and 4 (two
  after2 rows × first 4 tasks; `results-window4.jsonl`). Windows 0–2 were stopped early and are only
  described, not scored. No win is claimed anywhere.
- The last fix (edit refusals quote the file; empty `find` appends/creates) has unit tests but was
  **not re-measured**. To measure: deploy this branch to `/workspace/bench/cg/after2` on taofik-ai
  (rsync, `npm run build` with `/workspace/bench/node`), copy `experiments/` to
  `/workspace/bench/cg/before/experiments/`, then
  `cd /workspace/bench/cg && ./run.sh window5 branch-after2,branch-after2-scripts,codex "" 1`
  (a full 12-task pass at ~8 min a cell is ~5 h on this rig; use `--tasks` for a subset).
- Recount Branch edits after a window: `node experiments/coding-bench/recount-edits.mjs results.jsonl state/`.
- The model must be warm before a window (cold load is ~2.5 min and trips Branch's 60 s watchdog).
