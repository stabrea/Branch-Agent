# Redesign phase 2 — panels: status

Branch `mac7/p2-panels`, worktree `C:/Users/bishi/Code/wt/p2-panels`, cut from trunk 7c456c73.
Brief: `claude-session-files/branch/briefs/phase2/BRIEFS.md` ("panels"). Sample parts p31-resize, p35 (Browser/Terminal
part), p33 (hide part), p12 (panel footer). Critiques #15, #16, #47, #49 (hide), #52, #53, #57, #58, #59 (+ #12/#13 see-through).

New files: `public/panels.js`, `public/panels.css`, `src/panels-work.ts`. Shared-file edits are marked `phase2/panels`.

## Pieces

- [ ] 1. One side-panel switch (the existing `#aside-toggle`, now shown in the calm window too); the tab strip
      (`#lx-pane-tabs`, same id/classes) moved inside the panel; Browser and Terminal tabs filled from
      `GET /api/panels/work?session=` (owner only: short-lived keys and household people refused).
- [ ] 2. Resizable panes: drag handles for the side list and the side panel, double-click resets, arrow keys;
      Ctrl+B / Cmd+B folds the side list; widths remembered per viewer (localStorage `branch-pane-widths`).
- [ ] 3. Conversation width (`conversationWidth`, default wide) and see-through message box (`seeThrough`, default 30,
      readability floor per theme; solid under reduced transparency / reduce motion).
- [ ] 4. Hide anything: Settings › Appearance › What's on screen (`hidden`), right-click › Hide this with Undo
      (`rightClickHide`, off by default); approvals, the Lockdown banner and Stop are never hidden; all hidden → a gear.
- [ ] 5. Footer/pane sweep at every width (#52, #57, #59); composer never collapses after answering with Terminal open (#58).

## Not built (on purpose)
- A typeable shell of your own in the Terminal tab: the sample marks it a proposal; it would be a new way to run commands.
- A live picture of the browser: Branch's browser has no live view; the tab shows the pages it opened and its last screenshot.
