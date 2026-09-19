# Redesign phase 2 — delight: status

Branch `mac7/p2-delight`, worktree `C:/Users/bishi/Code/wt/p2-delight` (Legion), cut from trunk
`mac/cross-platform` at 7c456c73. Not merged into trunk (an integrator does that).
Brief: `claude-session-files/branch/briefs/phase2/BRIEFS.md` section "delight" (+ COMMON-RULES.md, PHASE2-COMMON.md).
Sample: `claude-session-files/branch/branch-grown-up/` (parts p33, p34, p22, p37, p28, p29, p30, p4).
Screenshots: `claude-session-files/branch/phase2-shots/delight/` (made by `claude-session-files/branch/delight/shots.mjs`).
A clean checkout for test runs: `C:/Users/bishi/Code/wt/p2-delight-verify` (detached; node_modules is a
junction to this worktree's — remove the junction with `cmd /c rmdir node_modules` before removing it).

## Pieces

| # | Piece | State |
|---|---|---|
| 1 | Acorn corner: the dithered pixel acorn in the rail's bottom corner, no caption, stays in place (#26, #41) | [x] public/index.html `#delight-corner`, public/acorn.js (icon pause, theme colours keyed by value), `showAcorn` still off by default |
| 2 | Achievements: 505 (Bronze/Silver/Gold/Diamond/Godly x100 + 5 SSS+), from real events only, owner-only, local; note ~7 s, card + leaves by rank; reduced motion (#49, #50) | [x] src/achievements.ts, src/achievement-tallies.ts, src/delight.ts, /api/delight*, public/delight-achievements.js |
| 3 | Pets: pixel pets in the acorn's style in the corner, walk/act, one-bubble queue, tips scarcer with rank (#35, #51, #55) | [x] public/delight-pet.js (8 kinds, moods from the window + /api/activity, right-click menu) |
| 4 | Own background: picture, video, animation, 3D object; IndexedDB; scrim; size limits (#45, #46) | [x] public/delight-background.js, public/delight-3d.js (hand-written WebGL: built-in acorn/oak, own .glb) |
| 5 | 3D look for the acorn and the pet beside pixel (#46) | [x] `look.style` pixel (default) / 3d |
| 6 | Tests | [x] tests/delight.test.mjs (server), tests/delight-ui.test.mjs (headless) |
| 7 | Screenshots 1440/390 light/dark, fit at 1024x700 | [x] phase2-shots/delight/ |
| 8 | Merge latest trunk, rebuild, retest, push | [x] trunk 98beb5d8 merged; 159/159 on 2a712323 (delight, delight-ui, ui, shell-ui, calm-ui, static-assets, web-ui, handbook, household-profile, short-lived-keys, redesign-phase1, glass-select, source-hygiene, index-structure, outside-resume) |

Each of pets, achievements and own background has its own off/on switch; all ship off (`look.style` ships pixel).

## Notes for a successor

- CSP is `style-src 'self'`: never write `style="..."` in markup; use CSSOM (`el.style.setProperty`) or delight.css.
  `img-src`/`media-src` now allow `blob:` (the owner's own background, made by the page itself).
- Tests that guard the acorn: tests/ui.test.mjs (Pause/Resume rotation button), tests/shell-ui.test.mjs
  (`.acorn-art` hidden when unchecked; showAcorn default false), tests/calm-ui.test.mjs (`#keepoak-acorn` hidden when calm).
- Locale keys all start `delight.` and sit in one block after `appearance.showAcorn` (scripted:
  `claude-session-files/branch/delight/addstrings.py`), so appends at the end of the files never collide.
- "It's lonely over here" is earned when something dispatches `branch-everything-hidden` on `document`
  (the hide-anything feature belongs to p2-panels).
- Achievement names and sentences come from the server in English (505 of them); the window's own words are en + fr.

## For the integrator

- With p2-panels: its "What's on screen" list (public/panels-hide.js `HIDE`) has `.acorn-art`, which still
  matches (the acorn moved into `#delight-corner`). It has no entry for the pet (`#pet`) yet, and nothing
  dispatches `branch-everything-hidden` yet: one line where every entry is hidden,
  `document.dispatchEvent(new CustomEvent("branch-everything-hidden"))`, makes "It's lonely over here" earnable.
- Deliberate differences from the sample: the pet lives beside the acorn in the rail's corner (not movable
  to the composer or rail, no per-Trunk pets); tips are the real app's own (the sample's mentioned features
  Branch does not have); no "KeepOak connected" achievement (Branch has no KeepOak account link, #14); the
  3D is hand-written WebGL, not three.js; SSS+ "Every leaf" asks for every theme by day and night in each season.

## Integration (adversarial review, 2026-09-19)

Integrator branch `integrate/p2-delight` (builder head 4dc3da54 + fixes 5a8a8e41, 5ae0f5b7, e72650a4,
trunk merged). Fixed screenshots: `phase2-shots/delight/*-fixed.png` (corner, sheet, settings,
background; 1440 and 390, light and dark; 0 px sideways overflow, 0 console errors after settling).

Found and fixed:
- **Achievements froze the server on a big history.** Every look scanned the whole events table
  twice (and `factsFor` ran twice per look). Synthetic store, 1,000,000 events / 50,000 tasks:
  7.8–8.2 s per look, blocking. Now events are counted from the last id seen, 25,000 per look,
  kept in the owner's record (`scan`); the task pass is reused until a task finishes. Same store:
  switch-on 405 ms once, catch-up looks ≤ 126 ms (39 looks, the window re-checks every 2 s while
  `behind`), steady look 31 ms. What a long past brings while being counted arrives quietly
  (`counting`). Bench: `claude-session-files/branch/integrate-delight/bench.mjs`.
- **.glb reader (untrusted files).** `walk()` recursed with no visited set (a node loop overflowed the
  stack; a shared branch grew exponentially); `merge()` spread big arrays into `push` (a valid 100k+
  corner model was accepted, then threw uncaught in a frame callback forever); `accessor()` had no
  bounds checks and leaked raw `RangeError` text into the window. Rewritten: every length/offset/
  count/index checked against the file before use, iterative walk visiting each node once, limits
  (5 MB, 300,000 corners, 900,000 indices, 10,000 parts, 4,096 nodes), refusals as `GlbError` with
  localised words (en + fr); `view3d` returns null instead of throwing. Fuzzed in the headless test
  (every truncation, 150 garbage files, 150 bit flips, huge counts/views, bad indices, loops, a
  50^40 fan, 5,000 nodes, 200 instances, bad JSON, over-size) — all refused cleanly in < 1.5 s.
- **Own background storage.** Writes resolved on the request, not the transaction (a full disk
  could look saved); quota errors showed raw DOMException text. Now: done only on
  `transaction.oncomplete`, `QuotaExceededError` said plainly; switching the background off deletes
  the window's IndexedDB database (checked with `indexedDB.databases()` first so nothing is created
  for people who never used it).
- **Unearnable achievement.** "Follow the sun" (`follow-system`) was never reported by the window.
  Now reported from the Light/Dark "Follow this computer" control. Flags are told once per window,
  and the server writes the record only when a report changed it.
- **Acorn (#26, #57).** Same dithered ray-traced acorn, but a 40-pixel backing store was stretched to
  56 px (uneven 1.4x pixels). Now 1:1 (56 in 56) like the sample's 56-in-58 tile; test asserts 1:1,
  `image-rendering: pixelated` and dither holes.
- Pet: with Keep things still it no longer redraws every 160 ms when nothing changed; a blocked
  localStorage no longer throws every 500 ms. Achievement sentences say "light mode"/"dark mode"
  (the app's own Light/Dark), not "Moonlight"; earned dates in the window's language.

CSP decision: `blob:` stays in `img-src`/`media-src` only, for everyone, not gated on the background
switch. Verified headless that trunk's policy refused `new Audio(blob:)` (read aloud, public/voice.js
and voice-talk.js create blob: sound), so the change also fixes read-aloud; `img-src` already allows
`data:`, which untrusted content reaches more easily; a blob: URL is only minted by the page's own
script (script-src 'self', no inline/eval), artifact frames are `sandbox=""`, MCP app pages have a
`sandbox; default-src 'none'` policy, and chat markdown renders no images. Test asserts no `blob:`
in default/script/worker/connect/frame/child/object/manifest.

"It's lonely over here": p2-panels is not on trunk. Hook unchanged: dispatch
`branch-everything-hidden` on `document` when every entry is hidden (public/delight.js listens).

Audit ids: the builder claimed none (checkboxes only).
