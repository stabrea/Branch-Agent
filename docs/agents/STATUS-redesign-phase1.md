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
| 2 | Suggestion bars (background, updates), quit-while-needed warning, Updates choice cards | [x] done: src/suggestions.ts + GET/POST /api/deployment/suggestion; public/suggestions.js (floats at the top of the pane); Updates choice cards in public/comfort.js; src/desktop/quit-guard.ts wired in src/desktop/main.ts before-quit (desktop not run: logic unit-tested only); tests/suggestions.test.mjs, tests/quit-guard.test.mjs |
| 3 | Default theme Slate | [x] done: default slate (window, terminal, phone fallbacks); a picked theme is always written down; a Forest the shared record holds is adopted by a window with no choice of its own; tests in tests/redesign-phase1.test.mjs |
| 4 | Permission-mode chip in the composer | [x] done: src/conversation-mode.ts (+ -api.ts), enforced in runtime.policy(source, runId) before the outside hold; /api/conversation-mode(/settings); POST /api/run `mode`; public/conversation-mode.js; tests/conversation-mode.test.mjs. New owner setting `newConversation` (ask/follow); UI tests about other things set it to follow |
| 5 | Glass dropdown replacing native selects; icon-button tooltips | [x] done: public/glass-select.js dresses every single-choice select (static and later-drawn; the native select stays the source of truth), glass listbox via public/popover.js trackPopover; glass tooltips for icon-only buttons; tests/glass-select.test.mjs. No select skipped |

## How to continue

- `npm run build`, `npx tsc --noEmit`, `node --test --test-concurrency=2 <explicit files>`.
- Never run tests/desktop*.test.mjs or tests/screen-control.test.mjs on the Mac.
- `dashboard-card.js` stays directly before `layout.js` in public/index.html.
