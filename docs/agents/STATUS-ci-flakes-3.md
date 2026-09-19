# STATUS: CI flakes, round 3 (mac7/ci-flakes-3)

Trunk Checks run 35467846040 (d366b45f, after a day of merges) failed on all three systems. Find the
root cause of each, fix the product when a person could hit it, otherwise make the test wait for the
condition; then watch trunk until two full green Checks runs in a row. Method as in
STATUS-ci-flakes.md and STATUS-ci-flakes-2.md.

## Findings (run 35467846040, plus the cancelled 35469818820 on 97ead378)
- source-hygiene (all): tests/panels.test.mjs:73 carries AWS's own example key id. Marked
  `not-a-real-secret`.
- walk-rules "obsidian.read does not read a tagged note in a refused folder…" and "a rule against
  reading finance…" (Windows only): PRODUCT BUG, the refused folder was read. `byFullAddress`
  resolved the workspace with `realpathSync`, which on Windows keeps an 8.3 short name
  (`C:\Users\RUNNER~1\…`, the runner's TEMP), while the notes walker's own paths come from
  `fs/promises` realpath, spelled out in full (`runneradmin`). Every note then looked outside the
  workspace, where the rules "have nothing to say". Not an interaction with multi-target/hardening;
  it only shows on a machine whose workspace path has a short name. Fixed with `realpathSync.native`
  (same resolver as the promise one). Not reproducible here (8.3 names are off on this disk).
- delight "off by default…" (Windows, macOS, Linux; 3 runs): TEST. It counted every /api/activity
  request, but the window's context pane asks for it every 5 s and the rail on a new task; on a slow
  runner that tick lands inside the test's 2.5 s. Delight itself asked nothing. The test now counts
  requests a delight file makes (the same stack check it already uses for timers).
- rooms "a room opens as a conversation…" (macOS) and panels "hiding everything earns 'It's lonely
  over here'" (macOS): TEST, one shared cause. `body.lx-ready` is set by layout.js as the page loads,
  not when the key is accepted, so fixtures waiting on it after Connect ran before sign-in finished:
  rooms' refresh then returned early (no roster, `branchOpenRoom` false), and the hide-everything
  change made before sign-in was put back by sign-in's first refresh (no gear). Proved by slowing
  /api/state 3 s: old fixture fails exactly so, new passes. Nine fixtures now also wait for
  `#workspace` to show (conversation-mode, glass-select, p2-rooms-ui, p2-voice-ui, panels,
  profile-badge, settings-descriptions, settings-kit-ui, suggestions).
- rooms "@ in the message box…" (Linux, then macOS on 97ead378): TEST. The reply appears before the
  window has finished that send (it reloads the conversation and the state; Send stays greyed), and a
  message sent in between goes nowhere. Probe: Send was still greyed when the reply showed in 3 of 3
  local runs. With that finishing step slowed 4 s the old test fails (30 s timeout), the new one
  passes. The test waits for Send to be usable before the next message (also in "choosing who answers").
- panels "the side list and side panel can be dragged…" (macOS): TEST. It pressed Control+B; on a
  Mac the chord is Cmd+B by design (Ctrl+B moves the cursor there). Now `ControlOrMeta+b`.
- panels "See-through never goes past readable…" (macOS, alpha 1): TEST. The window keeps the box
  solid when the computer asks for reduced transparency, and a macOS build machine does. The test now
  sets the computer's answer (CDP media feature), checks glass at no-preference and solid at reduce.
- panels, found while looping here (1 of 1 first run): "More offers Browser and Terminal, and a
  household window offers neither" set data-household by hand; the 3-second refresh writes it back
  from what the server says. Now a real household profile.
- accounts-page A6 (Windows, owner card count 1): PRODUCT BUG. When the models arrived after Accounts
  was drawn, the `branch-models` listener drew the owner's fallback-order card for a household person
  (hidden when nothing is shared, visible when something is). It now checks who the page is for.
- p2-voice-ui "dictation … throwing the words away puts the box back" (Windows): PRODUCT BUG. A
  question sent while the microphone was open could answer after ✕ had put the box back, writing the
  words (and "open") back in. Questions now belong to a press; older ones are dropped, and polling
  stops as soon as a stop is pressed. New test holds such an answer until after ✕.
- p2-voice-ui "Talk live … ships off" (Linux): TEST teardown. A route handler was still in
  `route.fetch` when the browser closed. The fixture unroutes (ignoring errors) before closing.
- flow-editor F2 (Windows, page.goto 30 s): TEST. The page's load took over 30 s on a busy Windows
  runner; given 120 s like tests/places.mjs (ci-flakes-2 precedent).
- accounts-page A6, the real mechanism (reproduced): `renderModels` runs on every 3-second refresh
  and fires `branch-models`, so the old listener drew the owner's fallback card for Sam within 3 s of
  Accounts opening. Waiting 3.5 s instead of 0.5 s: old code `1 !== 0`, new code passes. A6 now looks
  past one refresh.

## After the settings merge (run 35470358144 on 2674e2ae), new
- delight "the pet lives in the corner…" (Windows): TEST. Tips start once the page is 20 s old; on a
  slow runner a tip ("Ctrl K finds…") was showing when the task started, and the pet says one thing at
  a time. Reproduced by waiting 21 s first: old fails with exactly that text, new waits for "Working on it…".
- phone-layout double tap (macOS): TEST teardown, same as the voice one: askOnPhone's route.fetch ran
  as the browser closed. The fixture unroutes first. (e4a6188d had fixed the tap itself.)
- phone-layout "the first paint is already Slate…" (Windows, once): "Cannot access rules" reading a
  style sheet right after load. Cause not proven (all sheets are same-origin links; not reproduced).
  The test now waits until every sheet can be read and names any that never can.
- phone-layout double tap (earlier): already fixed on trunk by e4a6188d. hardening-3 #3: fixed on trunk by
  ci-flakes-2 (e8b85d07).
- Found in passing, PRODUCT BUG (same "a refresh rewrites what you just did" family): the 3-second
  refresh applied a look it had asked for before a change made here, once that change was saved, so
  the older look flashed back until the next refresh. `adoptSaved` now also skips an answer asked for
  before the window's latest change. New test holds such answers (fails before: 60 applied over 100).

## After residuals merged (run 35472658073 on d7e7de13: every shard green but one)
- mac2-desktop-ui "the cards go to their homes…" (macOS, 'off' instead of 'when-needed'): PRODUCT BUG,
  the same family again. app.js redraws the screen-control card on every 3-second refresh, and these
  cards redraw with it, writing the saved answer into the three choosers (Your computer's own voice,
  screen sharing, Keychain). A choice made and not yet saved was replaced by the old one within 3 s,
  and Save then sent the old value back and said "Saved." Now the saved answer is written in only
  while the choice on screen is still the one this file last wrote. Reproduced: with a 3.5 s wait
  between choosing and saving, trunk's file fails with exactly 'off' !== 'when-needed', the fix passes.
  The test keeps that wait.

## Run 35474392706 on 024f4531 (one shard red, everything else green)
- thinking-levels K3 (Linux): PRODUCT BUG, the same family a third time. `presetOptions` in app.js
  rebuilds the model lists on every 3-second refresh and sets them back to what is saved, so a model
  picked in Settings › Models was swapped back within 3 s (and while the list had the keyboard, the
  pick was dropped and nothing put back). The thinking levels then followed the old model, which is
  what the test saw. Now the list is rewritten only when its choices really changed, and a pick that
  is not saved yet is kept. Reproduced: with a 3.5 s wait after picking, trunk's file fails ("the pick
  is still theirs"), the fix passes. The test keeps that wait.

## Run 35475559161 on aeed473d (one shard red)
- ai-comments A0344 "one burst of changes becomes one task…" (macOS, nothing at all within 60 s): a
  folder watcher can miss what happens in the moment after it starts, and every one of the three
  writes went in right after `watchAIComments` returned. The test now gives the watcher a change of no
  interest first, and writes the burst again if nothing at all was heard (which cannot make a second
  burst, since a heard burst starts its task in well under the 15 s it waits). Not reproducible here
  (Windows): 15 runs, 3 at once, 90/90 before and after.

## Left for somebody: more of the same family, not failing CI today
The window's refresh every 3 seconds redraws whole cards, and these write over what a person is in the
middle of typing or choosing, so the value saved can be the old one:
- public/mcp-workbench.js renderConnections: "keep warm" minutes, most servers at once, when to connect.
- public/approvals.js render: the two limits (tool calls a minute, model rounds a minute).
- public/misc.js: the category choosers.
Each wants the same treatment as public/os-permissions.js here (write the saved answer in only while
what is on screen is still what the file last wrote), or the `document.activeElement` guard that
public/panels-hide.js uses for the see-through slider.

## Progress
- [x] fixes above: b45e1070, 1f2de612, 8e9df59b, the walk-rules spelling test, bf8073a5
- [x] after merging trunk 2674e2ae (settings redesign): clean dist, tsc, the 14 touched files +
      phone-layout + static-assets + index-structure + handbook at 3 at once: 170/170
- [x] loops, 3 copies of a file at once on this loaded machine, in a separate worktree
      (C:/Users/bishi/Code/wt/ci-flakes-3-loop at 7a7c5fb5), after the fixes:
      panels 12 runs 240/240, p2-rooms-ui 15 runs 75/75, p2-voice-ui 15 runs 90/90,
      delight-ui 12 runs 154 pass and one run whose process died before any test reported
      (no output at all, machine under load; the same non-event ci-flakes saw once),
      accounts-page 15 runs 90/90, phone-layout 12 runs 192/192, walk-rules 15 runs 435/435.
      Before the fixes, these files pass here as well (rooms 12 runs 60/60 measured): none of the
      CI failures reproduces on this machine by repetition, which is why each one was instead
      reproduced by making the one slow step slow (see the findings: /api/state held 3 s, the
      finishing step held 4 s, a 3.5 s wait past a refresh, a 21 s old page).
- [x] merged into trunk: 7a7c5fb5 (run 35472328214, cancelled by the residuals push), then the rest
- [ ] two consecutive full green Checks runs on trunk
