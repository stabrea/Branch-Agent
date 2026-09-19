# Redesign phase 2 — settings: status

Branch `mac7/p2-settings`, worktree `C:/Users/bishi/Code/wt/p2-settings`, cut from trunk `mac/cross-platform` at 7c456c73.
Brief: `claude-session-files/branch/briefs/phase2/BRIEFS.md` › settings. Not merged into trunk (an integrator does that).
Screenshots: `claude-session-files/branch/phase2-shots/settings/`. Scratch scripts: `claude-session-files/branch/p2settings/`.

## Pieces

- [x] 1. Smart buckets (#48, #24): `public/settings-buckets.js` lists each page's groups and each card's level;
      `public/settings-grown.js` reorders the page's direct children (cards never leave their page, so layout.js's
      sendHome/moveInto, search and every module keep working) and draws a heading per group. Unknown cards land in
      "More on this page". Window fills the screen, two columns of cards from 1200 px, a lone card spans both.
- [x] 2. Level control (#40): `settingsLevel` preference (src/preferences.ts, optional; unset = regular, or advanced
      when showEverything was on). Regular/Advanced/Technical at the foot of the Settings list; Advanced/Technical set
      showEverything, the Show everything switch moves the level. Technical adds "Saved as" keys to each card.
      Hook for other builders: `data-level="advanced|technical"` on anything inside Settings; `globalThis.branchSettingsLevel`;
      event `branch-settings-level`; `html[data-settings-level]`.
- [x] 3. Every setting reachable (#19): `public/settings-index.js` (530 rows from the audit inventory: id, home, card,
      English label, storage key, stand-in selector). Settings search shows "Also found, elsewhere or behind a switch"
      with Go there. Fixed: the video/speech-engine cards, the Pictures & sound values, Obsidian and embeds only drew
      when the old hidden Settings button was clicked (media-programs.js, media.js, bridges.js now also draw on
      `branch-place`). Test walks `tests/fixtures/settings-inventory.json`.
- [x] 4. Gear after the account row (#37); keep place (#54): the calm Settings row and the full-window gear become one
      cog after `#owner-menu-button` (which now shows in the calm window too; calm-ui test updated). Scroll kept per
      page across close/open and re-pressing the page; level changes keep the heading you were reading in place.
- [ ] 5. Appearance laid out to be looked at (#5, #24, #25, #38, #39): themes their own place, live mirror light + dark.
- [ ] 6. Chips never overflow (#62): sweep every page at 1440/1024/390.
- [ ] Tests: tests/settings-grown.test.mjs (inventory walk, defaults, search, levels, gear, keep place, overflow).
- [ ] Screenshots, merge latest trunk, final report.

## Notes for the other phase-2 builders

- p2-panels' `#panels-onscreen` sits in Appearance › "What a conversation shows" (Regular). p2-shell's `#shell-look-card`
  sits in Appearance › "Theme and lettering" (Regular). New settings of theirs can add rows to settings-index.js.
