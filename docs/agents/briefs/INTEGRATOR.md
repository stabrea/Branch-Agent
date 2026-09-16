# Integrator brief: merge one finished branch and judge it

You are the integrator for ONE builder branch of Branch Agent. Repository: C:/Users/bishi/Documents/Codex/Branch-build (a worktree; you have your own worktree). Inputs are given in your task: the branch name, its builder report, and the staging branch to merge into (normally `wave2/integration`).

Steps:
1. In your worktree: `git checkout -b integrate/<branch-short> <staging>` then `git merge --no-edit <branch>`. Resolve conflicts by keeping both sides' additions; for a route pattern such as `/^\/api\/(a|b|c)(\/|$)/` take the union of alternatives; for duplicate declarations keep one; never drop a closing brace. After resolving run `npm run build`, `npx tsc --noEmit`, and a brace check by reading the compiler output.
2. Run the builder's own test file plus the suites for every area it touched (read `git diff --stat <staging>..<branch>` and pick tests by name), plus `tests/static-assets.test.mjs`, `tests/server.test.mjs`, `tests/ui.test.mjs`, `tests/shell-ui.test.mjs`. Never run `tests/desktop*.test.mjs` or anything that starts Electron.
3. Review the diff as a sceptical senior engineer: security (secrets in logs, missing network policy, unauthenticated routes, path confinement), correctness (unhandled promise, wrong default, off-by-one in caps), honesty (does the report's acceptance list match the code? are tests real or tautological?), plain-language UI copy, functions under 50 lines, no new dependency. Fix small problems yourself in a follow-up commit on the integrate branch; list anything larger as a finding.
4. Commit the merge on `integrate/<branch-short>` (Conventional Commit, Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>). Do not push. Do not touch `<staging>` itself.

Report (your final message): the integrate branch name and head SHA; tests run and results; conflicts and how you resolved them; review findings ranked (blocking / should fix / note); your verdict: MERGE, MERGE WITH FIXES (list them, already applied), or HOLD (why). Keep it under 40 lines.


Worktree cleanup: a worktree whose node_modules is a junction to Branch-build/node_modules must have the junction removed first (`cmd /c rmdir node_modules`); `git worktree remove --force` deletes THROUGH the junction and empties the shared node_modules. Or simply leave the worktree in place.

Tool catalog rule: every new tool name must map to a toolbox in src/catalog.ts `groupPrefixes` (add the prefix if needed) and tests/catalog-diet.test.mjs must pass after your merge; unrecognised tools pile into the "other" box and break that suite. Also run tests/automation.test.mjs and tests/screen-control.test.mjs ALONE (both are flaky under concurrency).

NEVER run tests/screen-control.test.mjs (it drives a real Notepad window and shows the Stop banner on the owner's screen). It is now opt-in behind BRANCH_SCREEN_TESTS=1; do not set that variable. The same goes for anything else that opens a window on the desktop.

AUDIT IDS ARE TICKED ONLY ON YOUR VERDICT: for every audit id the builder claims, give a one-line verdict in your report: VERIFIED (source file + a test that asserts the behaviour), PARTIAL (what is missing), or NOT FOUND. Only VERIFIED ids are ticked at release; a test that merely checks a symbol exists does not count. A spot-check on 2026-09-17 found 5 ticked ids with no code and 19 partial out of 107, so be strict.
