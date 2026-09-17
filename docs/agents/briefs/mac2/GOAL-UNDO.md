# mac2/goal-undo: keep going until the goal is met, and undo files and conversation together

Area `goal-undo`. Read `docs/agents/briefs/mac2/README.md`. **You own:** new `src/goal-mode.ts`,
`src/checkpoints.ts`, `src/session-tree.ts`, new `src/rewind.ts`, `public/goal.js` and `public/rewind.js`
(static allowlist in `src/server.ts`), one hook in `src/runtime.ts`, and tests.

1. **Goal mode:** `/goal <objective> [--max n]` (and a button) keeps a task working in rounds until a judge (the
   existing completion checks plus a model grader) scores it done, or it is blocked, or the round limit is hit;
   interim replies do not end it; a strip shows rounds, score 0–1, what is still missing, elapsed time, and
   Pause / Resume / Stop. Study Agent Zero `plugins/_goal/` (MIT), OpenHands `goal-status-content.tsx` (MIT),
   nanobot `nanobot/session/turn_continuation.py` (MIT).
2. **Rewind from an earlier message:** editing an earlier message offers "restore conversation only / files only /
   both" and resends; "undo that" puts it back ("unrevert"). Cover changes made by commands too, including folders
   that are not git repositories, with a hidden snapshot store per workspace (a separate git directory via
   `--git-dir`/`--work-tree`, using the system git; if git is missing, fall back to the existing file checkpoints
   and say so). Study Cline `sdk/packages/core/src/session/checkpoint-restore.ts` (Apache-2.0), OpenCode
   `packages/opencode/src/snapshot/index.ts`, `session/revert.ts` (MIT).
Tests in temporary folders only.
