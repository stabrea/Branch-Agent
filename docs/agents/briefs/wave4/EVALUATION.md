# Wave 4 task: evaluation and benchmarks that the owner can run

Rules: docs/agents/briefs/wave1/BUILD.md. Branch: wave4/evaluation from the local branch wave2/integration. Theme: evaluation-and-benchmarks (#61, 51 pieces). Backend plus the existing Evaluation route; a small additive card in Settings or Usage only.

Read: src/evaluation.ts (standard suite, Evaluation.run/list), src/skill-governance.ts (benchmark), src/usage.ts, src/pricing.ts, tests/teams-registry.test.mjs (evaluation test), docs/configuration.md.

Build:
1. Suites as data: suites live in `data/evaluation/*.json` (id, name, tasks with prompt, checks, expected, tags, timeout); ship five built-in suites: everyday assistant (memory recall, file write with proof, summarise a document, follow a procedure), tool use (patch, grep, browser extract against a local page), safety (prompt-injection page must not trigger a write; secret must not leak into output), reliability (interrupt + resume), cost (same task on two presets). Owner suites can be created from any past run ("turn this task into a test") via `POST /api/evaluation/suites/from-run`.
2. Runs with history: every evaluation run stores per-task pass/fail, latency, tokens, dollars (pricing table), the preset, the app version; `GET /api/evaluation/history?suite=` returns trend series; regression detection flags a task that passed in the last three runs and failed now.
3. Model comparison: `POST /api/evaluation/compare { suite, presets: [..] }` runs the suite against each preset and returns a side-by-side table (accuracy, mean latency, cost); respects budgets and the approval preset (read-only tools only unless the owner allows).
4. LLM-as-judge option per task (`judge: { rubric }`) using the active model to grade free-text answers 0–1 with a stated reason; deterministic checks always win when present.
5. Scheduled evaluations: a suite can be attached to the existing scheduler (nightly) with a webhook/notification on regression.
6. CLI: `branch eval --suite <id> [--preset ..] [--compare a,b]` prints a table; `--json`.

Tests (tests/evaluation-more.test.mjs, scripted provider): suites load and validate; from-run creates a suite; history and regression flag; compare across two fake presets; judge grading with a fake model reply; scheduled run fires and a regression notification is sent to a fake webhook; CLI JSON output.

Acceptance: E1 five suites ship and pass on the scripted provider; E2 history + regression proven; E3 compare table proven; E4 judge proven with deterministic override; E5 scheduler hookup proven; E6 docs/configuration.md section; E7 no new dependency. Report the ids you consider done from the evaluation-and-benchmarks section of docs/audit/todo.md (benchmark harness families count when the suite mechanism covers them; external leaderboards do not).
