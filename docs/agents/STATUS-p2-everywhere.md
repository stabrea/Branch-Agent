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

## Integration (adversarial integrator, 2026-09-19)

Verdict: MERGE WITH FIXES (fixes below, on `integrate/p2-everywhere`). The builder claimed no audit ids.

- [x] Review: household profiles see only this computer on the terminal rail and no usage line (usageGlance and
      railItems both check the owner; tested). The phone bar's Inbox count mirrors the side list's badge and the bar
      lists the same five places the side list shows everyone, so it shows nothing the side list does not.
- [x] "Assistant:" renamed to the assistant's name: nothing parses it (grep of src/tests/scripts/apps/public; only the
      updated cli-tui regexes and the terminal-view fixture). Plain view (NO_COLOR/TERM=dumb) prints plain lines; ASCII
      glyphs for the rail and usage bar; rail only from 100 columns; no new escape sequences.
- [x] Fix: the first paint is Slate. `public/tokens.css` gains a block for a page that names no theme (or names
      Slate) holding exactly the values layout.js wears for Slate (catalogue + BRIDGE + --surface, plus the shell
      grounds); `public/look-early.js` (classic, in the head, before tokens.css) names a chosen theme first, so a chosen
      Forest paints Forest from the first frame as before. The phone app's own screens (apps/mobile/web) now paint
      Slate too. Tests: first paint equals the worn Slate colour for colour; the block equals the catalogue (dark and
      light); a chosen Forest/Slate paints its own; redesign-phase1 passes unchanged.
- [x] Fix: `viewport-fit=cover` on the window, with env(safe-area-inset-*) on the page margins, the places bar, the
      slide-over side list, Settings and its close button, toasts and the floating side pane. Tested with Chromium's
      safe-area override (47 px notch, 34 px home bar); margins at 1440/1024/820/390 unchanged without insets.
- [x] Fix: a question's answers lock on the first press (live-run.js answerOnce), so a double tap sends one answer
      (test fails without the fix: 3 requests); a failed send gives the buttons back. On a phone/tablet "No" is the
      quiet outline answer and all answers share one height. "Yes, always" still hidden for a task the owner did not start.
- [x] Breakpoint sweep 390/560/561/699/700/820/860/861/900/1024/1440: nothing sideways, the text field on top, bar only
      at 560 and under, side list a column from 700.
- Screenshots: `phase2-shots/everywhere/window/*-fixed.png` (ask/talk at 390 with notch, 820, 1440, light and dark;
  firstpaint-none/forest-390-fixed.png).
- [x] Household check made a test: a household person's bar lists the same places their side list holds (no place is
      removed for anyone; the calm window folds them into More) and carries the side list's own Inbox count.
- [x] Fix: a saved run recording (src/run-recording-page.ts) names Forest on its page, so it keeps the look it always
      had instead of taking the new Slate first paint (tests/run-recording.test.mjs asserts it).
- Wider effect, on purpose: pages that load tokens.css and never name a theme (pair.html on a phone, people.html, the
  dashboard before it wears its theme) now paint Slate, the default, instead of Forest.
- Not visible, so not changed: `src/desktop/main.ts` sets the Electron window's background to Forest, but the window is
  shown on ready-to-show, after the page's first paint. The phone app's
  own screens paint Slate first for a Forest chooser, then Forest once the window reports its theme (the native splash
  was already Slate). On the computer "No" still looks like the yeses (outside this branch's phone layout).
