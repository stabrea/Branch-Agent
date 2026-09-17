# mac2/fly-core: the fly-brain learning core (v1)

Area `fly-core`. Read `docs/agents/briefs/mac2/README.md`. You own new files `src/fly-core/**`,
`experiments/fly-core/**`, tests `tests/fly-core*.test.mjs`, and one hook in `src/runtime.ts` (task finished →
learning signal; task starting → ranked suggestions).

Owner decision (2026-09-17): the fly-brain work is Branch's learning backbone, not an experiment. Evidence so far:
the whole-brain fly models (Shiu et al. / Eon `fly-brain`, GPL-2.0 — study only) have **fixed** weights and do not
learn; flies learn in the mushroom body through dopamine-gated plasticity at Kenyon-cell → output-neuron synapses.

Build v1, in TypeScript, no new dependency:
1. A mushroom-body learning circuit: task context (tools used, skill ids, memory ids, project, kind of request,
   outcome) is encoded into a sparse Kenyon-cell code (random expansion + winner-take-most, ~2000 cells, ~5% active);
   output neurons ("approach" / "avoid" per candidate action); a reward/punishment signal from the task outcome
   (completed, checks passed, owner correction, failure, cost) depresses or potentiates the active KC→MBON synapses
   (three-factor rule with eligibility traces), with slow forgetting. State persists in the existing SQLite store.
   Where the connectome's real mushroom-body proportions are published (FlyWire/MaleCNS), cite them in comments
   and use them for sizes; no GPL code.
2. What it decides (advice only in v1, applied through existing mechanisms): which skills/tools/memories to put
   first for a new task, which memories to strengthen or let fade, and when a repeated successful pattern should be
   proposed as a skill (goes to the owner's existing review queue).
3. Measurement: `experiments/fly-core/` + a test that runs a synthetic task stream where some choices succeed and
   others fail, and asserts the core's picks improve over repeats versus a no-learning baseline and versus a simple
   frequency counter; report the numbers. Also a plan (in `experiments/fly-core/PLAN.md`) for the real before/after
   evaluation on Branch's benchmark suites and the head-to-head against Hermes.
4. A plain "What Branch has learned" card is optional; do not claim creativity, perfect memory or sentience anywhere.
Read `/Users/taofikbishi/Code/agent-refs/GAPS.md` (learning section, if written) and Letta's reflection loop for contrast.
