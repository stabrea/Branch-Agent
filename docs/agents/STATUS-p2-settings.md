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
- [x] 5. Appearance (#5, #24, #25, #38, #39): `public/settings-look.js`. Two small live mirrors side by side (dark, light)
      copy the window's panes into blank same-origin iframes (own document: no id clashes, no app watchers), dressed in
      the chosen theme or the tile under the pointer; redrawn at most once a second while visible. Plain-word tile tags
      ("Easiest to read" ≥16:1, "Softer" <9:1, never numbers). Eye beside Light and dark clears the view.
- [x] 6. Chips never overflow (#62): S12 sweeps every page and Models tab at 1440/1024/390 at Technical with every safe
      switch on; long paths now wrap inside cards (the video-programs card pushed Models › Pictures & sound sideways).
- [x] Tests: tests/settings-grown.test.mjs S1–S13 (inventory walk, defaults, search, Go there, levels, household, groups,
      cog, keep place, overflow sweep, mirrors). Other UI tests: tests/places.mjs openSettings shows every card of the
      page it opens (`showEveryCard`) and uses the page picker on narrow windows.
- [x] Screenshots: `claude-session-files/branch/phase2-shots/settings/` (10 scenes × 1440/1024/390 × light/dark, report.txt:
      no sideways scroll, no console errors after settle).
- [x] Merged origin/mac/cross-platform (98beb5d8) cleanly; rebuilt; 902 tests over 85 files (every Playwright UI file but
      desktop*, plus static-assets, index-structure, handbook, preferences users): 876 pass, 24 skipped, 2 fail, both fixed
      after (S9's churn check was too strict; glass-select's 390 click raced the window's rise animation).

## Found and fixed on the way

- Cards and values that only loaded when the old hidden Settings button was clicked (the calm window never shows it):
  video programs, other speech services, Pictures & sound values, Obsidian, embeds, how Branch runs on this computer
  (start quietly showed ticked), second opinion limits (empty boxes). Now also drawn on `branch-place`.
- A redraw loop of my own (headings rewrote themselves every frame); guarded writes + test.

## Deliberate differences from the sample

- Real cards are grouped and reordered, not regenerated as the sample's inline rows: their controls live in ~60 modules.
  Two columns on wide screens instead of one full-width column, since real cards put controls under their labels.
- Places' settings (Customize, Library, Automations, Inbox) stay in their places; Settings reaches them through
  "Elsewhere in Branch" and search (Go there), rather than duplicating them.
- "Show everything" is merged into the level (as in the sample), kept working both ways.
- No theme filter chip bar (#48); plain-word tags instead. No see-through / width / background / season-art controls
  (p2-panels and p2-delight own them). No agent-files editor (p2-accounts; hook: data-level / branchSettingsLevel).
- Technical shows where each card is saved ("Saved as"); no launch-variables card.
- Mirrors are side by side (#38), not stacked; icons are line icons, not dithered tiles.

## Notes for the other phase-2 builders

- p2-panels' `#panels-onscreen` sits in Appearance › "What a conversation shows" (Regular). p2-shell's `#shell-look-card`
  sits in Appearance › "Theme and lettering" (Regular). New settings of theirs can add rows to settings-index.js.
