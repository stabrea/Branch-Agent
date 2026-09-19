# STATUS: redesign phase 2, accounts (mac7/p2-accounts)

Worktree `C:/Users/bishi/Code/wt/p2-accounts`, cut from trunk 7c456c73. Not merged into trunk (an integrator merges).
Brief: `claude-session-files/branch/briefs/phase2/BRIEFS.md`, section "accounts" (critiques #21, #22, #30, #40 files half, #60, #61).
Screenshots: `claude-session-files/branch/phase2-shots/accounts/` (harness: `claude-session-files/branch/p2accounts/shots.mjs`).

## Pieces
- [x] 1 Service marks (usage popover done; other surfaces in 3 and 5): `public/brand-marks.js` (inline paths) + `public/assets/brands/*.svg` (provenance), THIRD_PARTY_NOTICES.md, test that the two agree; neutral tile where terms forbid
- [x] 2 Thinking options (also the per-model levels in knobs; tests/thinking-levels.test.mjs K1-K4) per model: `src/thinking-levels.ts` (what Branch really sends per provider), `thinking` on each preset in /api/models, `public/thinking-levels.js` drives #session-reasoning / #models-reasoning
- [ ] 3 Accounts page (Settings › Accounts): per provider with marks, state, rename/order/pin/off/cap/kept separate, add, terms line verbatim; "When one runs low" (per-connection order + strategy + sharing switch + the models fallback order, read-only); which key each Trunk uses (API keys only)
- [ ] 4 Agent files editor: owner-only GET/POST file text + undo of the last save, size limit 8000 bytes, off/on switch shipping off, level hook
- [ ] 5 Secrets page with marks and plain labels; marks in the usage popover and chat-app list
- [ ] 6 Merge trunk, rebuild, targeted tests, screenshots 1440/1024/390 light/dark, push

## Deviations from the sample (so far)
- No single cross-provider account fallback list: Branch has none. The page shows the two real mechanisms instead.
