# STATUS: redesign phase 2, accounts (mac7/p2-accounts)

Worktree `C:/Users/bishi/Code/wt/p2-accounts`, cut from trunk 7c456c73. Not merged into trunk (an integrator merges).
Brief: `claude-session-files/branch/briefs/phase2/BRIEFS.md`, section "accounts" (critiques #21, #22, #30, #40 files half, #60, #61).
Screenshots: `claude-session-files/branch/phase2-shots/accounts/` (harness: `claude-session-files/branch/p2accounts/shots.mjs`).

## Pieces
- [x] 1 Service marks (usage popover done; other surfaces in 3 and 5): `public/brand-marks.js` (inline paths) + `public/assets/brands/*.svg` (provenance), THIRD_PARTY_NOTICES.md, test that the two agree; neutral tile where terms forbid
- [x] 2 Thinking options (also the per-model levels in knobs; tests/thinking-levels.test.mjs K1-K4) per model: `src/thinking-levels.ts` (what Branch really sends per provider), `thinking` on each preset in /api/models, `public/thinking-levels.js` drives #session-reasoning / #models-reasoning
- [x] 3 Accounts page (Settings › Accounts, `public/accounts.js` rewritten; one line in layout.js SETTINGS_PAGES): per provider with marks, state + ring, quick buttons in sight, the rest under "More for this account", search past six accounts, terms line and pooling notice verbatim; "When one runs low" (the connection's own order + the models' fallback order read-only, button to Models); "Which key each Trunk uses" (API key connections only, saved on the Trunk through `POST /api/trunks/:id { keys }`). Messages that sent people to Settings › Models for accounts now say Settings › Accounts. tests/accounts-page.test.mjs A1-A5; accounts-ui U1 now expects `settings:accounts`
- [x] 4 Agent files editor: Branch already had one (R17-S05, src/settings-kit/file-map.ts, owner-only, never-break guard, 8,000-byte limit) buried on General. Reused its routes; added undo of the last save (`POST /api/settings-kit/files/undo`, refuses when the file changed since); new card `public/agent-files.js` on Settings › Assistant replaces the old list (Write/Preview, counter, starter, Undo); `data-level="advanced"` + `branchSettingsLevel` hook. No new switch: nothing new is reachable (same routes, same owner-only rule). tests/agent-files.test.mjs F1-F4; settings-kit-ui R17-S05 moved to the new card
- [x] 5 Secrets rows: mark + plain name ("OpenAI key", "Supplier API key") + "Commands use it as NAME" (hook in app.js renderSecrets, `public/service-marks.js`); the name field says what it is in plain words; marks on the chat apps (Customize › Channels), the ChatGPT/Gemini cards and the fallback list on Models, and the usage popover
- [ ] 6 Merge trunk, rebuild, targeted tests, screenshots 1440/1024/390 light/dark, push

## Deviations from the sample (so far)
- No single cross-provider account fallback list: Branch has none. The page shows the two real mechanisms instead.
