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
- phone-layout double tap: already fixed on trunk by e4a6188d. hardening-3 #3: fixed on trunk by
  ci-flakes-2 (e8b85d07).
- Found in passing, PRODUCT BUG (same "a refresh rewrites what you just did" family): the 3-second
  refresh applied a look it had asked for before a change made here, once that change was saved, so
  the older look flashed back until the next refresh. `adoptSaved` now also skips an answer asked for
  before the window's latest change. New test holds such answers (fails before: 60 applied over 100).

## Progress
- [x] fixes above, commits b45e1070, 1f2de612 and the fixture commit after the settings merge
- [ ] loops before/after
- [ ] merged into trunk, pushed
- [ ] two consecutive full green Checks runs on trunk
