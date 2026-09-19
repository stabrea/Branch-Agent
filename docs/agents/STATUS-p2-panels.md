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
- [x] 5. Footer/pane sweep at every width (#52, #57, #59); composer never collapses after answering with Terminal open (#58);
      below 1180 px the floating panel stops above the message box, so it never covers the text field.

## Not built (on purpose)
- A typeable shell of your own in the Terminal tab: the sample marks it a proposal; it would be a new way to run commands.
- A live picture of the browser: Branch's browser has no live view; the tab shows the pages it opened and its last screenshot.

## Tests
- `tests/panels.test.mjs` (20; the no-cover check was proven to fail with the fix taken out): the route's data and refusals, a real task's waiting command, source rules, the defaults,
  and the window headless (one switch, tabs inside, Browser picture, More rows, household hiding the tabs, tabs never
  wrap or cut at 260-640 px, drag/keys/double-click/Ctrl+B, width, see-through floor, hiding + gear + Lockdown banner,
  right-click off by default then Undo, no clipping at 1440/1024/390 open and closed, the box keeps its size after answering).
- Shared tests changed on purpose: `tests/calm-ui.test.mjs` (the panel switch now shows in the calm window; a tab inside
  the panel never closes it, the switch does; the Show everything save is waited for rather than read once),
  `tests/goal-undo-ui.test.mjs` (opens the panel with the switch, then Plan), `tests/shell-ui.test.mjs` (html gains data-convw).

## Notes for the integrator
- Two CSP warnings on every load come from settings-describe.js and settings-kit.js (inline <style>), not from this work.
- The See-through slider, width choice and What's on screen live on one card `#panels-onscreen` (data-home settings:appearance);
  p2-settings knows and will carry it. `changeAppearance(patch)` was added to public/appearance.js by both of us.
- Browser and Terminal are not on the What's on screen list on purpose: they are inside the side panel, which
  "The side panel button" hides. Pane widths are kept per workspace and per owner/household at this window.
- The floating gear sits above phase2/everywhere's phone bar via `var(--ew-bar-h, 0px)`.

Proof pictures: `claude-session-files/branch/phase2-shots/panels/` (script `claude-session-files/branch/p2panels/shots.mjs`).

## Last full run (f809bee9 + float fix)
- 48 `*ui*` files + suggestions, settings-descriptions, profile-badge, glass-select, panels: 300 tests, 297 pass, 0 fail, 3 skipped.
- Core set (panels, static-assets, index-structure, handbook, short-lived-keys, household-profile, web-ui, calm-ui,
  goal-undo-ui, shell-ui, settings-descriptions, redesign-phase1, glass-select, ui): 142/142.

## Integration (adversarial review, 2026-09-19) — verdict MERGE WITH FIXES

Reviewed builder head 11313f13, fixed in ff7f4670, then trunk merged four times while p2-accounts, p2-shell and
p2-rooms landed (0425641c, 72750f1f, 2424137a, cbd9d3d5; conflicts only in the two locale files and index.html's
stylesheet list, both sides kept). p2-shell's Trunks strip needed a follow-up (see below).

Found and fixed (tests in `tests/panels.test.mjs`):
- **Keys in Browser and Terminal.** The route showed full command lines (read off the messages, which the event
  scrubber never sees) and up to 1200 characters of printout, unlike the Activity view, which never echoes
  arguments. Both now go through the saved-secret scrubber and the leak guard (`[hidden key-like value: …]`),
  as a chat app's copy does. Test: an AWS key typed on the command line and an Anthropic key printed are hidden.
- **Work per poll.** Every 3-second refresh parsed the arguments of every tool call in the whole conversation;
  now only the calls of the steps being shown.
- **`branch-everything-hidden`** was not said. It is now dispatched on `document` once when every part on the
  list is hidden (again only after something came back); documented in docs/configuration.md. p2-delight is not
  on trunk yet, so it is tested by listening for the event, not through the achievement.
- **Settings unreachable on a phone.** With the title bar (or the side-list button and More) hidden at 390 px,
  the side list could not be opened and no gear showed: Settings was gone. The gear now shows whenever Settings
  cannot be reached, and on a phone it sat over the message box's corner; it now sits just above the box.
- **p2-delight landed on trunk during this review**: "It's lonely over here" is now tested end to end (achievements
  on, everything hidden, the server records `noticed:flag:lonely:1`). The acorn moved to the side list's corner, so
  its row moved to "The side list" group, and the pet (`#pet-lane`) joined the list.
- **p2-shell's Trunks strip** (landed on trunk during this review): with everything hidden it still showed, on a
  phone it lifted the message box so the floating panel covered the text field (the no-cover test caught it),
  and the corner gear sat on it. It is now on the What's on screen list ("Your computers and Trunks (the strip)";
  hidden, the window takes its room back), and the gear and the floating panel step clear of it (`--panels-left`,
  `--panels-foot` in public/panels.css). p2-shell's own Settings switch for the strip still works as before.
- **p2-everywhere landed on trunk during this review**: on a phone the strip moves to the top and a places bar
  holds the foot. The floating panel started over the title bar there, so its own switch could not close it
  (the clip test caught it); it now starts under the title bar and stops above the places bar. The See-through
  fill (`--comp-a`) moved from `<html>` to `<body>`, because public/look-early.js must paint every colour written
  on `<html>` before the first frame (tests/phone-layout.test.mjs).
- Look: a browser step says what it did ("Opened the page", "Took a picture of the page"), so two steps on one
  page no longer read as the same row; the address is not repeated in the printout and stays on one line.
  "See-through message box" used the small mono label face beside a proportional heading; spacing under
  "Show everything again"; the corner gear moved off the window's rounded corner.

Checked and found sound:
- Route: owner-only via `ownerOnlyReads` (short-lived keys 401, household 400 through `offLimitsToHousehold`);
  scoped with `ownsSession`; the session id only reaches SQL lookups; the picture is served by
  `/api/artifacts/file`, which only serves a path the artifacts list already holds, image/audio only, sandboxed.
  Bounded: 8 tasks, 2000 events each, 40 entries per tab, 1200 characters per printout.
- Never hidden: approvals (`#live-ask-slot` in `#live-row`, outside `#conversation` and the dock), the Lockdown
  banner (placed after the header, not in it), Stop (`#live-stop` in `#live-row`) stay with everything hidden.
  A hand-edited `hidden` id is ignored (client filters to known ids; CSS has rules only for listed ids).
- See-through floor: measured at the clearest setting in all 44 themes, light and dark (88 cases): the message
  box's words ≥ 4.5:1 and its faint text ≥ 3:1 over the modelled ground in every case. Solid under
  "Keep things still" (tested) and `prefers-reduced-transparency` (CSS; not emulatable headless).
- Resizable panes: keyboard (arrows, Shift, Home/End, Enter), min/max 200-440 and 260-640, per workspace and
  per owner/household. A remembered width is applied in the same frame the redesigned layout first appears
  (measured: 272 → 440 px at the frame `lx-ready` lands), so no visible jump.
- Ctrl+B: the composer is a plain textarea (no bold), rich-text areas are skipped, the Terminal tab is read-only,
  and no other Ctrl/Cmd+B binding exists in the app or the desktop shell.
- Glass dropdown: `tests/glass-select.test.mjs` passed 10 of 10 runs on this branch (it already contained
  trunk f5b8d582); the -388 failure reported on trunk did not reproduce here; left to ci-flakes-2.
- Shared tests: the calm-ui, goal-undo-ui, shell-ui and short-lived-key-routes changes follow real behaviour
  changes (the panel switch shows in the calm window per #16, tabs moved inside the panel, the new `data-convw`,
  the new route). One caveat: calm-ui's new wait for the Show everything save may be covering extra work this
  branch adds on every appearance change (a `branch-appearance` event and the contrast probe); it is a
  wait-for-condition, not a widened product timeout.

Not changed (notes for the owner): the What's on screen rows are tick boxes, where the sample uses switches with a
small map of where each part is; the full ("Show everything") window at 1024 px shows faint text of the plan row
under the line beneath the message box, which is the dock's existing fade, not this work.

Tests after the first trunk merge: panels (18) + static-assets, index-structure, handbook, short-lived-keys,
household-profile, web-ui, calm-ui, goal-undo-ui, shell-ui, settings-descriptions, redesign-phase1, glass-select,
ui, server, catalog-diet, accounts-page, accounts-ui, agent-files, brand-marks, settings-kit-ui, profile-badge,
suggestions: 194/194. After the last merge (cbd9d3d5, with the strip fix): panels, static-assets, index-structure,
handbook, short-lived-keys, household-profile, web-ui, calm-ui, goal-undo-ui, shell-ui, settings-descriptions,
redesign-phase1, glass-select, ui, server, catalog-diet, p2-shell-ui, p2-shell, accounts-ui, settings-kit-ui:
192/192; automation alone 5/5. Pictures: `phase2-shots/panels/*-fixed.png` (taken before the strip landed).

### Merged into trunk
Pushed d22e1f80 to `mac/cross-platform` (fast-forward), Checks run 35467687170. Last targeted run on d22e1f80:
225 tests across panels, static-assets, index-structure, handbook, short-lived-keys, household-profile, web-ui,
calm-ui, goal-undo-ui, shell-ui, settings-descriptions, redesign-phase1, glass-select, ui, server, catalog-diet,
p2-shell-ui, delight-ui, phone-layout, mobile-shell, accounts-ui, p2-rooms-ui: 224 pass, 1 fail. The failure is
p2-shell-ui "on a phone the strip is a row at the foot", which fails the same way on a clean trunk a177aec4:
phone-layout.css moved the strip to the top. It was reported to integrate-p2-everywhere and is not caused by
this branch.
