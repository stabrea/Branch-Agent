# How Branch Agent is built: the agent loop

This folder is the operating manual for the autonomous build loop that produced releases 0.7 through 0.15. Anyone (a person or a Claude session) can resume the work from here.

## The shape of it

1. **Themes and the ledger.** Everything to build comes from the capability audit: `docs/audit/todo.md` (786 pieces of work in 38 themes) and one GitHub issue per theme (#55–#92, index #42). A checkbox is ticked only when a reviewer names the source file and a test that asserts the behaviour. Two verification reports (`docs/audit/verification-2026-09-17*.md`) explain how strict that is.
2. **Briefs.** Each unit of work is a brief in `briefs/waveN/NAME.md`: what to read first, what to build, the tests, an acceptance list with ids, and housekeeping rules. Briefs are written so that a fresh agent with no conversation context can execute them.
3. **Builders.** One Opus agent per brief, in its own git worktree, on a branch `waveN/name` cut from the staging branch `wave2/integration`. A builder never pushes. Its final report lists what was built, tests run with counts, the acceptance ids done and not done, deviations, and what it could not prove.
4. **Integrators.** One Opus agent per finished branch (`briefs/INTEGRATOR.md`): merges the branch onto the current staging tip in a worktree, resolves conflicts by keeping both sides (route patterns become the union of alternatives), runs the suites, reviews the diff as a sceptical senior engineer, fixes small problems itself, gives a verdict (MERGE / MERGE WITH FIXES / HOLD) and a per-id verdict (VERIFIED / PARTIAL / NOT FOUND). Only then does the coordinator fast-forward or merge `integrate/name` into `wave2/integration`.
5. **Releases.** When four to six branches have landed and the full suite is green: bump the version, cut `release/x.y.z`, push to `feat/assistant-runtime`, open a PR to `main`, package from the release branch (`scripts/publish-template.sh` shows the whole chain), walk every screen of the packaged app (`scripts/walkthrough.mjs`, zero console errors), run the packaged desktop tests, wait for the pull-request CI check, merge, create the GitHub release with the zip and its checksum, rehearse the in-app update from a staged copy of the previous version (`scripts/rehearse-update.mjs`: zero console windows, previous copy kept), install on the owner's PC, tick the verified ids (`scripts/tick_theme.py`), and record the release in `docs/CHECKPOINT.md`.
6. **Community.** Outside pull requests are reviewed by an Opus agent with `briefs/PR-REVIEW.md`: decide first, then thank the contributor with the decision, then merge, request changes or decline. Licence, write-access and money questions go to the owner.

## Rules that were learned the hard way

- Never run `tests/desktop*.test.mjs` or `tests/screen-control.test.mjs` from an agent: they open windows on the owner's screen. The screen tests are opt-in behind `BRANCH_SCREEN_TESTS=1`.
- Worktrees share `node_modules` through a junction. Never `git worktree remove --force` a worktree that still has the junction: it deletes through it. Remove the junction first or leave the worktree.
- Every new tool name must map to a toolbox in `src/catalog.ts`; `tests/catalog-diet.test.mjs` has a width check that must not be raised, shorten descriptions instead.
- Integrators re-merge the current staging tip right before finishing; a stale base once dropped a whole settings block with no conflict marker.
- The pull-request CI check is the gate; the Windows runner is slow, and a handful of timing-sensitive tests flake there. Fix the test to wait, never widen a product timeout for CI.
- Report real numbers. Builders' claims are not evidence; ticks come from integrator verdicts.
- Tick an id the moment an integrator has verified it and the branch is merged, written as
  "- [x] A0245 (merged, ships in 0.17.0)", and not at release. Waiting for the release left 48
  finished items showing an empty box, which both understates the work and invites somebody outside
  to build the same thing again. At release, rewrite those markers to `(0.17.0)`.
- When a branch starts, comment on the theme issues it covers saying which ids are being built and
  on which branch, so an outside contributor can see what is taken. `CONTRIBUTING.md` explains how
  to read the boxes.
- Plain language everywhere the owner reads: UI copy, docs, release notes, error sentences. KeepOak tokens only; the design tests enforce it.

## Where things are

- Staging branch: `wave2/integration` (pushed to origin at each checkpoint). Release branches: `release/x.y.z`. PR branch: `feat/assistant-runtime`. Main: `main`.
- Packaged output: `release/` (ignored). Install location on the owner's PC: `%LOCALAPPDATA%/Programs/Branch Agent`, previous copy beside it as `Branch Agent.previous`.
- Screenshots and rehearsal folders: `%LOCALAPPDATA%/Temp/claude-session-files/`.
- Owner-facing docs: `README.md`, `docs/handbook/` (from wave 8), `docs/configuration.md` (reference), `docs/design.md`, `docs/api.md`.
