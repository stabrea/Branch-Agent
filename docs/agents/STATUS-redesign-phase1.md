# Redesign phase 1: status

Branch `mac7/redesign-phase1`, worktree `/Volumes/512GB SSD/branch-wt/redesign-phase1`, cut from
`mac/cross-platform` at 926eb454 (0.18.1). Not merged: an integrator merges it.

Design sample: `~/Library/Caches/claude-session-files/branch-grown-up/index.html` (parts in `parts/`),
owner critiques in `OWNER-CRITIQUES.md` there (#17/#31 usage ring, #42 95% prompt, #43/#28 suggestion
bars and update cards, #56 Slate, #20 mode picker, #29 glass dropdowns and tooltips).

## Pieces

| # | Piece | State |
|---|---|---|
| 1 | Usage ring + "What each connection has left" popover; 95% save-progress prompt | not started |
| 2 | Suggestion bars (background, updates), quit-while-needed warning, Updates choice cards | not started |
| 3 | Default theme Slate | not started |
| 4 | Permission-mode chip in the composer | not started |
| 5 | Glass dropdown replacing native selects; icon-button tooltips | not started |

## How to continue

- `npm run build`, `npx tsc --noEmit`, `node --test --test-concurrency=2 <explicit files>`.
- Never run tests/desktop*.test.mjs or tests/screen-control.test.mjs on the Mac.
- `dashboard-card.js` stays directly before `layout.js` in public/index.html.
