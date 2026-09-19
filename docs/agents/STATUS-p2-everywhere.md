# Redesign phase 2 "everywhere": status

Branch `mac7/p2-everywhere`, worktree `C:/Users/bishi/Code/wt/p2-everywhere` (Legion), cut from trunk
`mac/cross-platform` at 7c456c73. Not merged into trunk: an integrator merges it.

Brief: `claude-session-files/branch/briefs/phase2/BRIEFS.md` section "everywhere" (sample part `p35-everywhere.js`,
critiques #44, #53). Screenshots and terminal frames: `claude-session-files/branch/phase2-shots/everywhere/`
(made by `claude-session-files/branch/ew/shots.mjs` and `ew/tui-frames.mjs`).

## Pieces

- [x] 1. Phone apps: the Slate fallback in the native build files (splash/launch colour, Android colours,
      iOS colour sets, app icon ground) and the phone page's first paint; tests in tests/mobile-shell.test.mjs
- [ ] 2. Terminal view in the desktop's design language (src/terminal-*.ts): rail of Trunks/computers,
      approval card, Activity status, usage line, key hints; ASCII fallback; snapshots regenerated and read
- [ ] 3. Phone and tablet layout of the web window (public/phone-layout.js + .css): bottom places bar,
      approvals answerable, true proportions at 390x844 and 820x1180
- [ ] 4. Merge latest trunk, rebuild, retest, push

## Notes for the integrator

- The "early errors" in the proof script (401/429 and two CSP inline-style warnings) all come from the sign-in
  screen before the session token is entered; they exist on trunk too. Errors after the window settles are counted
  separately and must be zero.
