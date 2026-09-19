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
- [x] Final: merged origin/mac/cross-platform (f5b8d582) cleanly at 48c02b88; rebuilt in a separate checkout; 913 tests over
      86 files (every Playwright UI file but desktop*, static-assets, index-structure, handbook, every preferences user,
      outside-review): 889 pass, 0 fail, 24 skipped. 54 screenshots, all without sideways scroll or console errors.
- [x] Earlier: merged origin/mac/cross-platform (98beb5d8) cleanly; rebuilt; 902 tests over 85 files (every Playwright UI file but
      desktop*, plus static-assets, index-structure, handbook, preferences users): 876 pass, 24 skipped, 2 fail, both fixed
      after (S9's churn check was too strict; glass-select's 390 click raced the window's rise animation).

- [x] Household (integration-style self-review): a window on somebody else's profile always shows Regular (level
      greyed, "The owner keeps this profile on Regular."), and search leaves out owner-only settings (index column 8).
      S8 switches the window to a household profile and checks both.

## Test-side changes to know about

- `tests/places.mjs` `openSettings` now calls `branchSettingsLevel.peekPage()`, so the ~32 UI files that use it see every
  card of the page they open, as before this branch; they no longer exercise the Regular default. S5–S8 and S11 in
  tests/settings-grown.test.mjs cover what each level hides and shows. On narrow windows it uses the page picker.
- `tests/glass-select.test.mjs` (phase 1's) passed on base 7c456c73. At 390 px my taller Settings header left
  `#policy-preset` at the bottom edge (the list rightly opened upwards) and the click raced the window's rise animation;
  the test now centres the select and waits for the window's animations to finish (a wait for the condition, no
  product timeout touched).
- `tests/calm-ui.test.mjs`: the account row now shows in the calm window (#37); `tests/shell-ui.test.mjs`: tab order
  (the cog is at the foot, right after the account row) and the look record includes `settingsLevel`.

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

## Integration (adversarial review, 2026-09-19)

Reviewed 9f8df897, merged trunk twice (26e5b47e: p2-accounts, p2-shell, p2-rooms; then d366b45f: p2-panels,
p2-delight, p2-everywhere), fixed on the branch, then pushed to `mac/cross-platform`. Screenshots retaken as `*-fixed.png` in `phase2-shots/settings/` (report-fixed.txt).

### Found and fixed
- [x] **CSP (coordinator's addition):** `settings-describe.js` and `settings-kit.js` wrote an inline `<style>` the page's
      policy (`style-src 'self'`) refuses, so the "Applies to everything" scope chip was plain text on every card and
      every load logged two CSP errors. Now `public/settings-kit.css` (allowlisted in `src/server.ts`, linked in
      index.html; the CSP is unchanged). S16: zero CSP refusals from load through Settings, and the chip has its edge.
- [x] **Regular hid safety controls:** a second look at approvals (`approval-reviewer-card`) and using apps in the
      background (`reach-background-card`) were Advanced. Both Regular. S15 (1440 and 390, nothing peeked): Lockdown
      in the More menu, what Branch may do, the stop switches, approvals, updates, background work, keep-running.
      (`updates-card` is hidden in a browser by `app.js` — desktop only — not by the level; S15 checks its level.)
- [x] **Search slop (#48):** 36 chat-app rows read "Switch", 8 read "Saved secret with its key", 3+3+2 "Your own
      accounts" rows were alike, and 20 labels were placeholders ("(list of shares)", "short name | name | …").
      Each now says which one it is. S1 fails on two rows that read the same or a placeholder label.
- [x] **French:** search showed the index's English. A drawn control is now named from the (translated) words beside it,
      its card from its heading. S19. Rows whose control is not drawn yet still show English (see not done).
- [x] **Coverage going forward:** S14 reads every setting `src/` declares, with `scripts/check-docs.mjs`'s own reader
      (`settingKeys`, now exported) — the list `docs/configuration.md` is held to — and fails for one with no search
      entry and no stated reason. Before the second merge it found 12 real settings missing: the usage ring and save-progress prompt (phase 1),
      the activity log's three, matching memories by meaning, the local first-reply wait, leak-guard exceptions,
      add-ons on Windows without the wall, and after the merge the Trunks strip, 3D faces (p2-shell) and Talk live in
      its own view (p2-rooms). All indexed; the live-voice limits now say where they are saved. S2 checks every row
      added since the audit has a real control at the home it gives.
- [x] **Other builders' cards:** Accounts (p2-accounts' own page) is grouped there at Regular; its two settings moved
      to `settings:accounts` in the index and the audit fixture. The assistant's files (p2-accounts) stand in "Who your
      assistant is" at Advanced. `agent-files.js` called `branchSettingsLevel` as a function (it is an object here) —
      a page error once both branches met — and marked itself hidden at Regular for good; it now relies on
      `data-level` alone. Dead `settings-kit-files` bucket entry removed.
- [x] **Second trunk merge:** both this branch and p2-panels exported `changeAppearance` from `public/appearance.js`;
      the module failed to load and the window never finished starting (no test had run yet — found by loading the
      page). Kept p2-panels' one. p2-delight's pet, achievements and background cards stand together under Appearance ›
      "Just for fun" (Regular: each is off until turned on). p2-panels' "What's on screen" was already placed by the builder.
- [x] **The settings check missed the look:** `scripts/check-docs.mjs` needed a word before "Preferences", so
      `src/preferences.ts`'s own `PreferencesSchema` (the look, Show everything, the level, p2-panels' four fields) was
      held neither to `docs/configuration.md` nor to search. Now `\w*`; all 15 were already documented (322 settings,
      check passes). S14 then found p2-panels' see-through, width and right-click-to-hide and p2-delight's switches:
      indexed; the look rows now say where they are really saved (`preferences.*`).
- [x] **Mirrors (#25):** below 1200 px they scrolled away with the themes; now they ride along at the top (smaller, an
      opaque strip) at 1024 and 390. S18 at all three sizes: in sight at the last tile, not covering it, following it.
- [x] **Mirror requests:** real iframes (about:blank, same origin, scripts/iframes/media stripped, inert, redrawn at most
      once a second and only while on screen). The server answers files `no-store`, so the copy's two logos were
      fetched again at every redraw. The copy is now cloned in the window and its pictures become data first. S20: no
      request from a mirror across three redraws. Each frame still loads the stylesheets and fonts once, on first show.
- [x] **Phone header (390):** the search box read "Search setting" and the picker "Computer & browse:"; each has a row.
- [x] **glass-select:** the builder's wait masked a small real bug: a list opened while the Settings window rises
      (0.22 s) stayed up to 8 px off. The list now follows its select frame by frame while anything around it moves
      (`placeWhenSettled`); new test presses mid-rise. The flush test keeps a wait for the rise because Playwright's
      own click retries with a scroll that closes the list — a mouse click at the same point does not (6/6).

- [x] **How much to show** is itself found by search now (it had a reason line instead; the one setting this branch added).

### Merged and tested
- Pushed `19c6d4ad` to `mac/cross-platform` (four trunk merges, last at 97ead378); Checks run 35470311313.
- Final runs on the merged code (verify worktree, build-fast): 25 targeted files 293/294 before the last S14 fix
  (S14 rightly caught p2-delight's two switches), then 13 of them again 174/175 (one p2-panels test, "It's lonely over
  here", timed out waiting for the corner gear under load; passed alone and in its whole file, 19/19);
  the 55 other UI files that use tests/places.mjs 406 pass, 0 fail, 16 skipped; automation.test.mjs alone 5/5;
  pre-push set at the pushed SHA (settings-grown, static-assets, index-structure, handbook, catalog-diet, calm-ui,
  shell-ui, glass-select, hardening-3) 120/120.
- Screenshots: 13 scenes × 1440/1024/390 × light/dark as `*-fixed.png`, report-fixed.txt: no sideways scroll, no page
  or console errors after settle, 0 CSP notes at load (the originals had 2).
- Trunk-wide: `scripts/check-docs.mjs` now reads `PreferencesSchema` too, so a new field in `src/preferences.ts` must be in
  `docs/configuration.md`, and S14 wants it in `public/settings-index.js` or named in `NOT_IN_SEARCH` with a reason.
  A second helper exported from `public/appearance.js` under an existing name kills the whole page silently.

### Checked, no change
- Cards that waited for the old Settings button: values load on opening Settings (`branch-place` fires on open and on
  Go there, not on page clicks, so no reload per page). S17 sets 7000/2/90000, opens from the cog, saves untouched:
  7000/2/90000 kept (the empty-box save used to send 0, which the server refused). S3 covers fresh-install defaults.
- Household: level forced to Regular and greyed, `/api/preferences` owner-only, search leaves out every owner-only
  row (all but `documents-repository`; the rows added here are owner-only) — S8.
- `tests/places.mjs` peeks every card for the 32 UI files; Regular's own coverage is S5–S8, S11 and now S15.

### Brief items (verdicts)
1. Groups, full width, no "N settings" rows or chip bars — VERIFIED (settings-buckets.js; S9, screenshots).
2. Regular / Advanced / Technical — VERIFIED (S6, S7, S8, S11, S15).
3. Every setting reachable and searchable — VERIFIED for the audit's 530 + 12 added (S1–S4, S14); PARTIAL overall: see below.
4. Cog after the account row, place kept — VERIFIED (S10, S11).
5. Appearance with live light/dark mirrors — VERIFIED (S13, S18, S20).
6. Chips never overflow — VERIFIED (S12 at three sizes, now including the scope chips).

### Not done / for a successor
- S14's `NOT_IN_SEARCH.notYetReviewed` holds 96 declared settings with no search entry that nobody has looked at one by
  one (many are set through the assistant, a command or the API; some may have a control the sweep missed). Take names
  off as they are indexed or given a reason; the list may only shrink. 47 more are launch-configuration keys, 8 are
  written by Branch itself, 2 are switches beside the message box.
- In French, a setting whose control is not drawn yet (behind a switch, in a place not visited) is named in English.
- Mirror frames load the stylesheets and fonts once each on first show (about 20 requests, once).
