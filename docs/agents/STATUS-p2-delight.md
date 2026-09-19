# Redesign phase 2 — delight: status

Branch `mac7/p2-delight`, worktree `C:/Users/bishi/Code/wt/p2-delight` (Legion), cut from trunk
`mac/cross-platform` at 7c456c73. Not merged into trunk (an integrator does that).
Brief: `claude-session-files/branch/briefs/phase2/BRIEFS.md` section "delight" (+ COMMON-RULES.md, PHASE2-COMMON.md).
Sample: `claude-session-files/branch/branch-grown-up/` (parts p33, p34, p22, p37, p28, p29, p30, p4).
Screenshots: `claude-session-files/branch/phase2-shots/delight/`.
A clean checkout for test runs: `C:/Users/bishi/Code/wt/p2-delight-verify` (detached; node_modules is a
junction to this worktree's — remove the junction with `cmd /c rmdir node_modules` before removing it).

## Pieces

| # | Piece | State |
|---|---|---|
| 1 | Acorn corner: the dithered pixel acorn in the rail's bottom corner, no caption, stays in place (#26, #41) | [ ] |
| 2 | Achievements: 505 (Bronze/Silver/Gold/Diamond/Godly x100 + 5), from real events only, owner-only, local; toast ~7 s, pop-out + confetti by rank (#49, #50) | [ ] |
| 3 | Pets: pixel pets in the acorn's style in the corner, walk/act, one-bubble tip queue, tips scarcer with rank (#35, #51, #55) | [ ] |
| 4 | Own background: picture, video, animation, 3D object, stored locally, readability scrim, size limit (#45, #46) | [ ] |

Each of pets, achievements and own background has its own off/on switch; all ship off.

## Notes for a successor

- CSP is `style-src 'self'`: never write `style="..."` in markup; use CSSOM (`el.style.setProperty`) or delight.css.
- Tests that guard the acorn: tests/ui.test.mjs (Pause/Resume rotation button), tests/shell-ui.test.mjs
  (`.acorn-art` hidden when unchecked; showAcorn default false), tests/calm-ui.test.mjs (`#keepoak-acorn` hidden when calm).
