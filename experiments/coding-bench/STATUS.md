# Coding bench — status (2026-09-19)

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
