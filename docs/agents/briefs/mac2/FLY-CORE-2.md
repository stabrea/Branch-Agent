# mac2/fly-core-2: the learning core changes what Branch does, and proves it on real work

Area `fly-core-2`. Read `docs/agents/briefs/mac2/README.md` and the merged v1 (`src/fly-core/**`,
`experiments/fly-core/PLAN.md`, `docs/configuration.md` "The learning core"). **You own:** `src/fly-core/**`,
`experiments/fly-core/**`, a new `src/fly-core-api.ts` with one route block in `src/server.ts`, a new
`public/learning-core.js` card (`data-home="settings:assistant"` or `library:memory` per `docs/places.md`),
`src/backup.ts` (only the `fly_*` tables), `src/memory-review.ts` (only the `learned` evidence value),
`src/memory-learning.ts` (export the correction pattern), and tests.

1. **Advice that acts, when the switch is "on":** the ranked tools/skills/memories are applied through the existing
   mechanisms — the tool-loading tier pre-loads the top tools (within the hard tool budget), the skill suggester
   ranks the top skills first, and memory retrieval boosts the top memories. "When needed" keeps v1 behaviour (the
   model asks with `learning.suggest`). Every applied piece of advice is visible in the task's details pane as one
   plain line ("Chose these first because they worked before in similar tasks").
2. **Owner controls:** settings route + card with the three-way switch, "What Branch has learned" (top habits
   in plain words, with the evidence count), "Forget what it learned" (with confirmation, clears `fly_*` tables).
3. **Backup and restore** include the `fly_*` tables; a restore over existing data cannot leave orphan traces.
4. **Skill ideas carry evidence:** `learned.signal` accepts the core's value; accepting a skill idea opens the
   existing skill-authoring flow pre-filled from the steps, instead of returning `{noted:true}`.
5. **Real measurement harness:** `experiments/fly-core/real-eval.mjs` runs a task set N times against a running
   Branch (base URL + session key from the environment, never printed), with the core off vs on, and writes a
   report: success rate, tool calls, tokens, cost, time per task, per repeat. Use the bucket 11 evaluation suites
   (`src/evaluation*`) for tasks. Do NOT run it against a real model from this Mac — the coordinator runs it on the
   Tower test container. Include a `--dry-run` that uses the offline demo provider so the harness itself is tested.
6. **Head-to-head hook:** the same harness can target Hermes Agent's OpenAI-compatible API (URL + key from the
   environment) for the same task set, so both assistants are scored identically. Test with a fake server only.

**Also fix (from the v1 review):** "on" mode loads every action at task start (170–480 ms at the cap) — cache or
index so task start stays under 10 ms; cap the weights kept per action so storage stays well under 20 MB at the cap;
the `learning.suggest` tool must read the switch of the owner it was registered for (or register per owner);
cite Owald et al. 2015 for reward depressing "avoid" synapses and check the Kenyon-cell counts against Schlegel 2024.
The honest v1 result: before a change the core ≈ a failure-aware counter; its edge is relearning after a change.
Any real-task claim must come from `real-eval.mjs`, not the synthetic stream.
