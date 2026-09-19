# Redesign phase 2 — panels: status

Branch `mac7/p2-panels`, worktree `C:/Users/bishi/Code/wt/p2-panels`, cut from trunk 7c456c73.
Brief: `claude-session-files/branch/briefs/phase2/BRIEFS.md` ("panels"). Sample parts p31-resize, p35 (Browser/Terminal
part), p33 (hide part), p12 (panel footer). Critiques #15, #16, #47, #49 (hide), #52, #53, #57, #58, #59 (+ #12/#13 see-through).

New files: `public/panels.js`, `public/panels.css`, `src/panels-work.ts`. Shared-file edits are marked `phase2/panels`.

## Pieces

- [x] 1. One side-panel switch (the existing `#aside-toggle`, now shown in the calm window too); the tab strip
      (`#lx-pane-tabs`, same id/classes) moved inside the panel; Browser and Terminal tabs filled from
      `GET /api/panels/work?session=` (owner only: short-lived keys and household people refused).
- [x] 2. Resizable panes: drag handles for the side list and the side panel, double-click resets, arrow keys;
      Ctrl+B / Cmd+B folds the side list; widths remembered per viewer (localStorage `branch-pane-widths`).
- [x] 3. Conversation width (`conversationWidth`, default wide) and see-through message box (`seeThrough`, default 30,
      readability floor per theme; solid under reduced transparency / reduce motion).
- [x] 4. Hide anything: Settings › Appearance › What's on screen (`hidden`), right-click › Hide this with Undo
      (`rightClickHide`, off by default); approvals, the Lockdown banner and Stop are never hidden; all hidden → a gear.
- [x] 5. Footer/pane sweep at every width (#52, #57, #59); composer never collapses after answering with Terminal open (#58).

## Not built (on purpose)
- A typeable shell of your own in the Terminal tab: the sample marks it a proposal; it would be a new way to run commands.
- A live picture of the browser: Branch's browser has no live view; the tab shows the pages it opened and its last screenshot.

## Tests
- `tests/panels.test.mjs` (18): the route's data and refusals, a real task's waiting command, source rules, the defaults,
  and the window headless (one switch, tabs inside, Browser picture, More rows, household hiding the tabs, tabs never
  wrap or cut at 260-640 px, drag/keys/double-click/Ctrl+B, width, see-through floor, hiding + gear + Lockdown banner,
  right-click off by default then Undo, no clipping at 1440/1024/390 open and closed, the box keeps its size after answering).
- Shared tests changed on purpose: `tests/calm-ui.test.mjs` (the panel switch now shows in the calm window; a tab inside
  the panel never closes it, the switch does), `tests/goal-undo-ui.test.mjs` (opens the panel with the switch, then Plan).

## Notes for the integrator
- Two CSP warnings on every load come from settings-describe.js and settings-kit.js (inline <style>), not from this work.
- The See-through slider, width choice and What's on screen live on one card `#panels-onscreen` (data-home settings:appearance);
  p2-settings knows and will carry it. `changeAppearance(patch)` was added to public/appearance.js by both of us.
- The floating gear sits above phase2/everywhere's phone bar via `var(--ew-bar-h, 0px)`.

Proof pictures: `claude-session-files/branch/phase2-shots/panels/` (script `claude-session-files/branch/p2panels/shots.mjs`).
