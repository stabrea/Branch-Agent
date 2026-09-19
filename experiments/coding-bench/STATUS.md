# Coding bench — status (2026-09-19)

## Window 6 — started 2026-09-19 19:06 UTC, running unattended on taofik-ai

- Build: trunk `f5b8d582` (mac7/tests-unattended: an unattended `branch run` skips the project's tests
  with a note and carries on; `branch run --allow-tests` lets that one run run them), copied with
  `git archive` to `/workspace/bench/cg/after4`, `npm ci && npm run build` with `/workspace/bench/node`
  (log `/workspace/bench/cg/after4-build.log`). `before/experiments/` still matches trunk apart from the rows below.
- Rows (VM only, not in git): `before/experiments/scoreboard/contestants.mjs` (window5's version kept as
  `contestants.mjs.window5`, the original as `contestants.mjs.pre-window5`). `branchContestant` has two
  optional fields: `prepScript` (window5, see below) and `runArgs`, extra `branch run` flags placed before
  `--timeout`. Rows without them run exactly as before. The window6 rows:
  ```js
  branchContestant({ id: "branch-after4", name: "Branch (trunk f5b8d582)", root: `${BENCH}/cg/after4`,
    note: "trunk after mac7/tests-unattended, every switch as shipped (unattended: project tests skipped)" }),
  branchContestant({ id: "branch-after4-tests", name: "Branch (trunk f5b8d582, --allow-tests)", root: `${BENCH}/cg/after4`,
    note: "branch-after4 started with branch run --allow-tests, so it may run the project's tests", runArgs: ["--allow-tests"] }),
  ```
  So the tests row runs `node dist/cli.js run --allow-tests --timeout 600000 "<prompt>"` in after4.
- Model warm (the load took 22 ms at start). `keep-model-warm.sh qwen3-14b-16k` was restarted under `timeout 8h` at
  19:06 UTC (log `/workspace/bench/board/keepwarm.log`).
- Command (detached with `setsid -f`, output to `/workspace/bench/cg/window6.log`):
  `cd /workspace/bench/cg && ./run.sh window6 branch-after4,branch-after4-tests,codex "" 1`
  — 36 cells, 3 rows × 12 tasks, round robin (codex first in each task).
- First task (fix-range), all fail:
  - codex: 147 s, tests fail.
  - branch-after4: completed in 101 s after 2 model calls, with no question, 0 edits. The model tried
    `code.run` (off as shipped), was refused, and ended by telling the owner to switch scripts on. Model
    behaviour, not the rig.
  - branch-after4-tests: stopped at the 600 s deadline, still working. The flag was accepted (stderr:
    "this task may run the project's tests without asking"). One edit landed in `src/range.js`, then a
    model turn was in progress. Model turns took ~70 s each at load ~11.
- Progress: `tail /workspace/bench/cg/window6.log`, `wc -l /workspace/bench/cg/window6/results.jsonl`
  (36 when done), `pgrep -af run-scoreboard`. Per-cell databases in `window6/state/`, logs in `window6/logs/`.
- Expected finish: roughly 21:30–22:30 UTC at the first task's pace (~14 min a task, three cells).
  Worst case is 36 × 10 min, about 01:10 UTC.
- Report when done (from `/workspace/bench/cg/before`, `PATH=/workspace/bench/node/bin:$PATH`):
  `node experiments/coding-bench/recount-edits.mjs ../window6/results.jsonl ../window6/state > ../window6/results-recounted.jsonl`
  then `node experiments/coding-bench/report.mjs ../window6/results-recounted.jsonl`. Copy the JSONL here as
  `results-window6.jsonl` and write the section in `docs/agents/coding-bench.md`.

## Window 5 — stopped, invalid (do not report)

Started 16:04 UTC on trunk `cc212bf5` (`/workspace/bench/cg/after3`), rows `branch-after3`,
`branch-after3-readfirst` (a `prepScript`, `after3/experiments/coding-bench/readfirst-on.mjs`, that saves
`settings/coding-read-first` `{ mode: "on" }`) and `codex`. The coordinator stopped it after 3 cells. Both
Branch rows ended `needs_input` after 1–2 model calls with no edit, on "Let Branch run this project's
tests?". `code.check` asked the tests question and `branch run` had nobody to answer. Fixed on trunk
f5b8d582 (window 6). The 3 rows are in `/workspace/bench/cg/window5/results.jsonl` and are not a
measurement. The read-first row is to be measured later.

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
