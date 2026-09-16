# Wave 3 task: smarter delegation and orchestration

Rules: docs/agents/briefs/wave1/BUILD.md. Branch: wave3/orchestration from the local branch wave2/integration. Theme: agent-orchestration (#55, 77 pieces, the largest). Backend only; the context pane already shows running tasks and specialists, so surface new state through the existing events and `GET /api/activity`, not new screens.

Read: src/runtime.ts (delegation, delegateBackground, follow-ups, checks, resume, reconciliation), src/delegation.ts, src/specialists*.ts, src/teams.ts, src/reliability.ts, docs/CHECKPOINT.md batches on delegation and teams, tests/delegation*.test.mjs, tests/teams-registry.test.mjs.

Build (each behind existing permissions and budgets; every sub-run recorded with parent id and visible in activity):
1. Plan-then-act: an optional planning step (`plan: true` on a run, or automatic when the prompt is long/multi-part by a cheap heuristic) where the model produces a short numbered plan stored on the run; steps are executed in order with per-step checks; the plan is editable by the owner before execution when the approval preset asks; progress events `plan.step.started/finished`.
2. Parallel fan-out with a budget: `delegate.parallel` runs up to N (default 3, max 6) specialist sub-tasks concurrently with a shared token budget split, collects results, and asks the parent to synthesize; failures of one branch do not cancel the others unless `failFast`.
3. Handoffs and steering: a running sub-task can hand off to a named specialist with a brief; the owner can steer a running task with a message (`POST /api/runs/:id/steer { text }`) that is injected at the next model round as a high-priority user note; both recorded as events.
4. Critic/verifier loop: an optional second pass where a reviewer role checks the result against the task's checks and the owner's memory facts, returning "accept" or a concrete fix list; at most two iterations; the run report shows the verdict.
5. Long-task hygiene: automatic milestone summaries every K rounds stored on the run (so resume and the context pane can show "where we are"), and a "stuck" detector that, after the existing stall watchdog fires twice, changes strategy (asks the owner or switches specialist) instead of retrying the same thing.
6. Shared scratchpad per run: a small key-value scratch area that all sub-tasks of one run can read/write (`scratch.get/set/list`), cleared on completion, size-capped.

Tests (tests/orchestration.test.mjs with the scripted provider): plan produced and steps executed in order with events; parallel fan-out completes with one failing branch and a synthesized answer; steer message reaches the next round; critic loop rejects then accepts; milestone summaries appear; stuck detector switches strategy; scratch shared across sub-tasks and cleared; budgets respected (a sub-task cannot exceed its share).

Acceptance: O1 all six behaviours behind flags with defaults that keep today's behaviour (existing runtime/delegation tests unchanged); O2 events documented in docs/configuration.md; O3 no new dependency; O4 tests above green; O5 report the agent-orchestration ids and families you consider done.
