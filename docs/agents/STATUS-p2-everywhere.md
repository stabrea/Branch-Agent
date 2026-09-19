# Redesign phase 2 "everywhere": status

Branch `mac7/p2-everywhere`, worktree `C:/Users/bishi/Code/wt/p2-everywhere` (Legion), cut from trunk
`mac/cross-platform` at 7c456c73. Not merged into trunk: an integrator merges it.

Brief: `claude-session-files/branch/briefs/phase2/BRIEFS.md` section "everywhere" (sample part `p35-everywhere.js`,
critiques #44, #53). Screenshots and terminal frames: `claude-session-files/branch/phase2-shots/everywhere/`
(made by `claude-session-files/branch/ew/shots.mjs` and `ew/tui-frames.mjs`).

## Pieces

- [x] 1. Phone apps: the Slate fallback in the native build files (splash/launch colour, Android colours,
      iOS colour sets, app icon ground); tests in tests/mobile-shell.test.mjs read the generated files back.
      NOT done: the phone's own page still paints tokens.css's Forest ground (#03140b) for the moment before
      theme.js wears Slate (#18242C), so a Slate splash can be followed by a Forest blink. Fixing it means a Slate
      default in public/tokens.css (the window's first paint too) — left for whoever owns the token layer.
- [x] 2. Terminal view in the desktop's design language (src/terminal-*.ts): rail of Trunks/computers,
      approval card, Activity status, usage line, key hints; ASCII fallback; snapshots regenerated and read.
      New src/terminal-everywhere.ts (rail + usage data, owner only), drawing in src/terminal-screen.ts (marked
      phase2/everywhere); tests/terminal-everywhere.test.mjs; snapshot diffs: only the 120x40 chat views gained the
      key line, plus the new chat-everywhere view. Answers are headed "<assistant name>:" instead of "Assistant:"
      (tests/cli-tui.test.mjs regexes updated). Frames as text + pictures in phase2-shots/everywhere/terminal/
- [x] 3. Phone and tablet layout of the web window (public/phone-layout.js + .css): bottom places bar,
      approvals answerable, true proportions at 390x844 and 820x1180. Hooks in shared files, each marked
      phase2/everywhere: index.html (one link, one script), src/server.ts (two allowlist rows), public/shell.js
      (the side list slides over under 700 px instead of 860, so an upright tablet keeps it docked).
      tests/phone-layout.test.mjs.
- [x] 4. Merged origin/mac/cross-platform (677e7d34, then 98beb5d8: 91 targeted tests, 89 pass, 0 fail, 2 skipped), rebuilt, ran 51 files (419 tests: 400 pass, 0 fail,
      19 skipped): every UI file that sets a narrow viewport, the shell/calm/web/ui/redesign-phase1 suites,
      static-assets, index-structure, handbook, all terminal suites, mobile-shell/-rules, conversation-mode.

## Notes for the integrator

- Coordinated with p2-panels: they leave shell.js and the rail breakpoints alone; their drag handles only show
  from 861 px; they will lift their floating gear by var(--ew-bar-h, 0px) at 560 px and under.
- Left out on purpose: the sample's Trunks strip across the top of the phone (p2-shell owns the Trunks rail; the
  phone shows it in the slide-over side list). Customize is not in the bar (the sample's bar has Settings in its
  place); it stays in the side list.
- The window's viewport has no viewport-fit=cover, so env(safe-area-inset-bottom) is 0 in the phone app and the
  bar sits above the home indicator as the rest of the page does. Not changed (it would move the title bar too).
- Terminal answers are now headed "<assistant name>:" (was "Assistant:"), in the drawn and the plain view.
- The places bar only shows once the window is connected (not on the sign-in screen). The two-by-two question
  layout and the scroll-into-view apply at 900 px and under, so 1024x700 keeps the computer's layout (tested).

- The "early errors" in the proof script (401/429 and two CSP inline-style warnings) all come from the sign-in
  screen before the session token is entered; they exist on trunk too. Errors after the window settles are counted
  separately and must be zero.
