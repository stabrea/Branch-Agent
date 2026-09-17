# mac3/reflection-skills: memory and skills that keep themselves in shape (GAPS.md top 10 #1–#3)

Area `reflection-skills`. Rules: BUILD-MAC.md, mac2/README.md, mac3/DESIGN-EVERYWHERE.md, docs/places.md.
**You own:** new `src/reflection/**`, `src/skill-authoring.ts`, `src/memory-review.ts` (the `apply` path only — the
learning core's builder `mac2/fly-core-2` adds a `learned` evidence value there; keep your change to `apply`),
cards at `library:memory` / `customize:skills`, tests. One marked hook in `src/runtime.ts`.
1. **Fix:** accepting a "skill note" suggestion really changes the skill (through `src/skill-revisions.ts`: the change is
   drafted, trial-run on recent tasks, shown as a diff, applied on accept).
2. **Reflection pass:** every N turns (setting, default 25) and when a conversation is compacted, a background run
   reads only the new turns and proposes: fixes to stale facts, merges, reorganised memory, updates to skills — all as
   one reviewable batch in the existing review queue; nothing is written without the owner (Branch's stricter design);
   three-way switch, off by default. Study Letta `letta-code/src/cli/helpers/reflection-launcher.ts`,
   `src/agent/subagents/builtin/reflection-v2.md` (Apache-2.0) and Hermes `agent/background_review.py` (MIT).
3. **Brand-new skills:** from a finished task, from repeated successful patterns (the learning core's skill ideas),
   and on `/learn` ("make this into a skill"), Branch drafts a new skill, trial-runs it, and offers it for approval.
   Also retire skills unused for a long time (proposal only). Study Hermes' skill writer and Gemini CLI
   `packages/core/src/agents/skill-extraction-agent.ts` (Apache-2.0).
Tests with the offline demo provider; no real model.
