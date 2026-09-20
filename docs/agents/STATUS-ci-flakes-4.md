# STATUS: CI flakes, round 4 (mac7/ci-flakes-4)

Finish what ci-flakes-3 started: trunk `mac/cross-platform` to two consecutive fully green Checks runs
on all three systems, the owner's release gate for 0.19.0. Method as in STATUS-ci-flakes.md, -2.md
and -3.md: root cause first, a product fix when a person could hit it, a test made to wait for the
condition only when the evidence says the machine was slow.

Starting point: run 35478612357 on dda44fbe, four tests red. Run 35479946361 (e18f559f, a docs-only
commit on the same tree) was in flight when this round began.

## Findings (run 35478612357)

- mac2-desktop-ui "the cards go to their homes…" (Windows 5/6, page.waitForFunction 30 s at line 531):
  **PRODUCT BUG**, the 3-second-refresh family again, and a different mechanism from the one
  ci-flakes-3 fixed in the same test. `render()` in public/os-permissions.js began with
  `for (const id of …) status(id, "")`, and that render is what the window's refresh calls every three
  seconds. So a person pressed Save, was told "Saved." — or was given the plain sentence saying why it
  could not be saved — and the message was wiped within three seconds, often before it had been read.
  It never came back: the message is written once, on the press. The test waits for "Saved." and on a
  crawling runner the refresh beat its first reading, so it waited the whole 30 s for words that were
  already gone. Now a message a press put on a card stays until the next press; only a message the
  drawing itself wrote is cleared when it draws again. Guarded in the test by the very call the refresh
  makes (`branchOsPermissions.render()`), with no sleep: fails on trunk's file, passes here.

- never-break-ui "the Keep running card…" (Windows 5/6, locator.click 30 s): **TEST / slow machine, and
  NOT a never-break failure.** It never reached a never-break assertion. It timed out opening the
  Settings window: Playwright resolved `#lx-settings-row`, found it visible, enabled and stable,
  scrolled it into view, logged "performing click action" and then sat there for the whole 30 s. That
  shard was crawling — a passing test in the same job took 153 s and another 81 s. The same shape as
  the swallowed click ci-flakes-3 saw on a select (cause not proven there either). `openSettings` in
  tests/places.mjs now presses the gear again while the window is still shut, and gives each press
  longer. This is a shared fixture, so it only changes behaviour where a click already failed outright.

- add-ons-walled "macOS for real…" (macOS 1/2, `'refused'` instead of a 403): **TEST.** The stand-in
  plugin the test writes catches every fetch error and returned the bare word "refused", and it gave
  each fetch 5 s. The door looks a named address up through this computer's own resolver before it
  answers; on a busy macOS build machine that lookup took longer than 5 s, so the test's own fetch was
  cut off and the door never got to say "api.weather.invalid could not be found". The door behaved
  correctly. The stand-in now gets 30 s and carries the reason out, so a future run says which fetch
  broke and why instead of the useless word "refused".

- coding-gap-edits "a task's deadline is the caller's…" (Windows 6/6, 'cancelled' vs 'completed'):
  **TEST.** The second arm ran a whole task — setup, the scripted model's 300 ms, the record — under a
  5 s deadline, and that took longer than 5 s on the crawling Windows runner, so it was cancelled too.
  The deadline given to the arm is the test's own number, not a product timeout. The contrast with the
  50 ms arm is what proves "a longer --timeout really is longer", and that contrast is untouched.

- delight-ui "the pet lives in the corner…" (Windows 2/6, `Cannot read properties of null (reading 'x')`
  at line 149): **TEST.** `boundingBox()` returned null because the bubble was already hidden. A status
  bubble is up only for its reading time — `readMs` floors at 3000 ms, and "Working on it…" is three
  words, so three seconds — and `pump()` then hides it and says nothing more while the same mood lasts.
  The test measured the bubble over Playwright round trips (a 1.2 s loop of eight counts, then two
  geometry reads, then two more text reads 1.2 s apart), which on a busy Windows machine ran past those
  three seconds. The watching is now set up inside the page before the task starts and reads the bubble
  every 100 ms from the moment the words appear. It proves the same three things — one bubble at a
  time, inside the rail, the words do not flicker — on every reading rather than on two, and the
  flicker check is no longer vacuous (it used to compare "" with "" once the bubble had gone).

## Found in run 35479946361 (e18f559f, the same tree as dda44fbe: one shard red)

- flow-editor F1 "a second step is added, moved and taken out again" (Windows 2/6,
  `['approval','prompt']` where `['prompt']` was wanted): **TEST.** The press that saves the flow after
  a step is taken out was never waited for. The wait under it asked for one step on screen, which was
  already true before the press, so the flow was read back out of the store while the save was still on
  its way, and on a busy Windows runner that read the two steps that were still saved. The first save
  in the same test does wait, for "Saved." in the status line; the second now does too, with the status
  line emptied first so it waits for this save and not the one above. No product bug: `save()` in
  public/flow-editor.js writes through the server and only then says "Saved.".

## The rest of the 3-second-refresh family, which ci-flakes-3 left for somebody

All three run on the same refresh path as the one ci-flakes-3 proved (public/app.js calls
`branchMcpWorkbench.render`, `branchApprovals.render` and `branchMisc.render` beside
`branchScreenControl.render`). Each can strand a real person, so each got a product fix.

- public/mcp-workbench.js `renderConnections` wrote the saved "keep warm" minutes, "most servers at
  once" and "when to connect" straight into the boxes every three seconds. Minutes being typed were
  replaced mid-word and Save then sent the old number back. Now the saved answer is written in only
  while what is on screen is still what the file last wrote (the os-permissions.js guard).
- public/approvals.js `render` did the same to the two ceilings (tool calls a minute, model rounds a
  minute). Same guard.
- public/misc.js `renderCategories` called `host.replaceChildren()` every three seconds, throwing every
  category chooser away and making a new one, so an open list shut under the person and the keyboard
  was thrown out of it. The rows are now made again only when they really changed (the cure
  ci-flakes-2 used for glass-select and conversation-mode).

## The `verify` job

It was red in 35478612357 as well. It is only an aggregator: `needs: [test, package]`, `if: always()`,
and its one step asserts both were successes. It has no failure of its own and goes green by itself
once the shards do. Not a fifth cause.

## Progress

- [x] read COMMON-RULES, STATUS-ci-flakes, -2, -3; pulled and read all four failing job logs of 35478612357
- [x] product: os-permissions.js keeps a message a press put there; guard in mac2-desktop-ui
- [x] product: mcp-workbench.js, approvals.js, misc.js — the three refresh sites ci-flakes-3 listed;
      one guard test in tests/glass-select.test.mjs, which already owns this family. A save that did
      not land leaves the ceiling theirs (approvals.js `save` now says whether the server took it), so
      the refresh does not take away what a failed save left on screen.
- [x] tests: add-ons-walled, coding-gap-edits, delight-ui, places.mjs openSettings
- [x] before/after, in a separate worktree (ci-flakes-3-loop detached at 1a0afe01, trunk's four product
      files put back one at a time). Each new guard bites on trunk's code and passes on this branch:
      - os-permissions: mac2-desktop-ui `'' !== 'Saved.'` ("the message stays until the next press")
      - approvals: `'0' !== '42'` ("the ceiling being typed is still theirs")
      - misc: "a chooser somebody may have open is not thrown away and made again"
      - mcp-workbench: `'5' !== '17'` ("the minutes being typed are still theirs")
- [x] loops on this loaded machine, 12 runs of each file with 3 copies going at once, in the separate
      worktree: delight-ui 168/168, glass-select 120/120, mac2-desktop-ui 276/276, never-break-ui
      60/60, coding-gap-edits 276/276, flow-editor 48/48 — 948 of 948, no failure of any kind. As in every earlier round,
      none of the CI failures reproduces here by repetition; each was instead diagnosed from the log
      and, where a product bug, reproduced by driving the very call the 3-second refresh makes.
- [x] build + tsc clean, then the touched files plus four more places.mjs users (calm-ui,
      settings-grown, p2-shell-ui, panels, accounts-page — places.mjs is shared by 77 test files, so
      the change to `openSettings` was exercised beyond the four files that needed it):
      183 tests, 179 pass, 0 fail, 4 skipped. After the clean rebuild, flow-editor + static-assets +
      index-structure + handbook + glass-select: 28/28.
- [x] merged into trunk: pushed e18f559f..b837d52e (fast-forward). Checks run 35481505692.
- [ ] two consecutive full green Checks runs on trunk

## Run 35481505692 on b837d52e (green candidate 1): every shard green but two Windows ones

Every fix above held — flow-editor, coding-gap, add-ons-walled and delight were all green this time.
Two left:

- mac2-desktop-ui "the cards go to their homes…" (Windows 5/6): the message fix worked (it got seven
  lines further, to line 538), and then a press on the voice card's Save sat in Playwright's
  "performing click action" for the whole 30 s and nothing happened. That is the THIRD time this exact
  signature has shown up — the Settings gear in this round's never-break-ui, a select in ci-flakes-3
  ("cause of the swallowed click not proven"), and now a Save button. The cause is still not proven. It
  is not the product: the button keeps the one listener `switchCard` gave it and the card is never
  drawn again (`place()` returns early once it exists). So the cure is the one a person would use —
  press again when nothing happened. `pressUntil` in tests/places.mjs now does that for any control,
  and the gear helper is built on it.
- hardening-3 "3 a model on this computer that never starts answering…" (Windows 4/6, 2570 ms):
  **TEST.** The clock check `took < 2000` had a 1 s first-reply wait, a 300 ms deliberate event-loop
  hold and a 100 ms grace inside it, so it left only about 600 ms for everything else a run does, and a
  crawling Windows machine used more. The waits are now 3 s and a 300 ms grace with a 500 ms hold, and
  the bound is 5 s: the thing it guards (ci-flakes-2's bug, a retry given a whole first-reply wait
  instead of the grace) would land at 6 s and still fails the check, so nothing it proves is weakened.

## Loops after those two fixes (same worktree, 12 runs each, 3 copies at once)

mac2-desktop-ui 276/276. hardening-3 193 of 194: one run's process ended at 2.88 s partway through
test 3 with no named test failing and nothing printed — `'test failed'` against the file itself and no
stack. That is the same non-event ci-flakes, ci-flakes-2 and ci-flakes-3 each recorded once on this
loaded machine ("the test process ended with no output at all before any test reported"); its cause is
still unknown and is not chased here. Test 3 itself passed in the other eleven runs, at 3797 ms and
3819 ms under three-at-once load, which is the room the new 5 s bound was meant to give it.

## Run 35483029723 (cancelled by another agent's push, but one shard had already failed)

- panels "with achievements on, hiding everything earns …" (Windows 1/6): **TEST.** Hiding everything
  fires `branch-delight-noticed` and public/delight-achievements.js asks the server 1.5 s after the
  last one, so the earning is never instant; the loop gave that debounce plus a round trip only 5 s of
  polling. It is still the window's own asking that earns this; only the waiting is longer (60 s).

## Run 35484288929 on b766c6ad: two Windows shards, both the crawling kind

- flow-editor F2 (Windows 2/6): **TEST.** After pressing Run this flow, the timeline had 20 s to catch
  up, and on a machine where this one test took 103 s the run had not finished by then. Given the 120 s
  tests/places.mjs gives the window.
- p2-shell-ui "the strip sits at the left edge…" (Windows 5/6): **TEST.** ci-flakes-3 gave the strip
  15 s, then 60 s; this machine went past 60 s too, and the same test has taken 153 s in full on that
  shard while passing. It now has the same 120 s the window gets two lines above it. Checked first for
  a real race in `whenReady` (public/strip.js): the strip is drawn only when `body.lx-ready` and a shown
  `#workspace` coincide, and a MutationObserver watches both. `#workspace` is static in index.html and
  layout.js only appends to it, never replaces it, so the node the observer holds is the node that
  later unhides — no deadlock. It really is slowness.
- Shard times in that run were 19-26 minutes against the job's 45-minute cap, so the shards themselves
  are not near the edge; it is single tests inside them that run long.

## Where the two green runs stand

Run 35479946361 (e18f559f, the same tree as dda44fbe) finished while this round was working: every
shard green on all three systems except Windows 2/6, which was the flow-editor F1 wait above. So one
test stood between trunk and a green run, and it is fixed here.
