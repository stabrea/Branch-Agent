# Wave 1 build brief (shared by every builder)

You are building ONE feature area of Branch Agent, a local Windows desktop assistant for a non-technical owner. You work in your own git worktree (already created for you; check `git branch --show-current` and `git log -1`). Base branch: feat/assistant-runtime. Create your feature branch from it: `git checkout -b wave1/<area>` before editing.

Read first: README.md, docs/CHECKPOINT.md (architecture and every batch so far), docs/configuration.md (routes and settings), docs/audit/todo.md (your theme's section lists the audited capabilities; build the highest-value ones, not all), src/index.ts (wiring), src/server.ts (routes; `isExecution` list; auth), src/contracts.ts (ToolContext, permissions), src/registry.ts and one existing tool module (e.g. src/files.ts) for the tool pattern, public/app.js and public/index.html for the UI pattern, tests/*.test.mjs for the test pattern.

Rules (non-negotiable):
- Node 24, strict TypeScript, ESM, zod v4 for every input schema, `node:sqlite` for storage (add tables through the existing store/migration pattern). Functions under 50 lines. Clarity over cleverness. No speculative features.
- No new npm dependency unless you write a one-paragraph justification in your final report AND there is no reasonable way with Node built-ins. Prefer built-ins.
- Every outbound network call goes through the existing network policy (see src/network-policy.ts and how src/web*.ts / src/mcp*.ts use it). Every tool is gated by the existing permission mechanism (ToolContext / permissions). Secrets go through the existing locker/settings, never plain files.
- UI copy in plain language for a non-technical person (no jargon; say "read aloud", not "TTS"). Reuse the existing look: CSS variables and components in public/ (KeepOak redesign). No new front-end frameworks. Keep new UI in its own file (public/<area>.js, plus minimal hooks in index.html/app.js).
- Tests: add tests/<area>.test.mjs using node:test against dist/ (run `npm run build` first). Cover the happy path and one failure path per public behaviour. Do NOT run the Electron/desktop tests. Run `npm run build && node --test tests/<area>.test.mjs` and also the two or three existing test files closest to what you touched; all must pass. Then `npx tsc --noEmit`.
- Keep edits to shared hot files (src/index.ts, src/server.ts, src/contracts.ts, public/app.js, public/index.html, README.md, docs/configuration.md) small and additive, in clearly separated blocks, so six branches can merge without conflicts. Put the substance in new files.
- Do not change the version in package.json. Do not touch the updater or desktop code. Do not push. Do not open PRs or issues.
- Documentation: one bullet in README's feature list, one short section in docs/configuration.md (routes, settings, plain-language description), and a "Batch 19 (wave 1) — <area>" paragraph appended under the newest batch in docs/CHECKPOINT.md.
- Commit on your branch with a Conventional Commit message ending with the line: Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
- Final report (your last message): branch name, commit SHA, what was built in plain language (5-10 lines), files added/changed, test command and result, any dependency added with justification, anything you deliberately left out and why, and which docs/audit/todo.md item ids (Axxxx) you consider done so the theme issue can be ticked.


Worktree cleanup: a worktree whose node_modules is a junction to Branch-build/node_modules must have the junction removed first (`cmd /c rmdir node_modules`); `git worktree remove --force` deletes THROUGH the junction and empties the shared node_modules. Or simply leave the worktree in place.

Tool catalog rule: every new tool name must map to a toolbox in src/catalog.ts `groupPrefixes` (add the prefix if needed) and tests/catalog-diet.test.mjs must pass after your merge; unrecognised tools pile into the "other" box and break that suite. Also run tests/automation.test.mjs and tests/screen-control.test.mjs ALONE (both are flaky under concurrency).

NEVER run tests/screen-control.test.mjs (it drives a real Notepad window and shows the Stop banner on the owner's screen). It is now opt-in behind BRANCH_SCREEN_TESTS=1; do not set that variable. The same goes for anything else that opens a window on the desktop.

AUDIT IDS ARE TICKED ONLY ON YOUR VERDICT: for every audit id the builder claims, give a one-line verdict in your report: VERIFIED (source file + a test that asserts the behaviour), PARTIAL (what is missing), or NOT FOUND. Only VERIFIED ids are ticked at release; a test that merely checks a symbol exists does not count. A spot-check on 2026-09-17 found 5 ticked ids with no code and 19 partial out of 107, so be strict.
