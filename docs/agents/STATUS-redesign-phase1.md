# Redesign phase 1: status

Branch `mac7/redesign-phase1`, worktree `C:/Users/bishi/Code/wt/redesign-phase1` (Legion; earlier `/Volumes/512GB SSD/branch-wt/redesign-phase1` on the Mac), cut from
`mac/cross-platform` at 926eb454 (0.18.1). Not merged: an integrator merges it.

Design sample: `~/Library/Caches/claude-session-files/branch-grown-up/index.html` (parts in `parts/`),
owner critiques in `OWNER-CRITIQUES.md` there (#17/#31 usage ring, #42 95% prompt, #43/#28 suggestion
bars and update cards, #56 Slate, #20 mode picker, #29 glass dropdowns and tooltips).

## Pieces

| # | Piece | State |
|---|---|---|
| 1 | Usage ring + "What each connection has left" popover; 95% save-progress prompt | [x] done: src/usage-glance.ts, GET /api/usage/glance (non-owner: `{available:false}`), POST /api/usage/save-progress (steers running tasks), settings ring/saveProgress on the Usage screen; public/usage-glance.js; tests in tests/redesign-phase1.test.mjs |
| 2 | Suggestion bars (background, updates), quit-while-needed warning, Updates choice cards | not started |
| 3 | Default theme Slate | [x] done: default slate (window, terminal, phone fallbacks); a picked theme is always written down; a Forest the shared record holds is adopted by a window with no choice of its own; tests in tests/redesign-phase1.test.mjs |
| 4 | Permission-mode chip in the composer | not started |
| 5 | Glass dropdown replacing native selects; icon-button tooltips | not started |

## How to continue

- `npm run build`, `npx tsc --noEmit`, `node --test --test-concurrency=2 <explicit files>`.
- Never run tests/desktop*.test.mjs or tests/screen-control.test.mjs on the Mac.
- `dashboard-card.js` stays directly before `layout.js` in public/index.html.
