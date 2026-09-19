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
