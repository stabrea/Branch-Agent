# STATUS: redesign phase 2, accounts (mac7/p2-accounts)

Worktree `C:/Users/bishi/Code/wt/p2-accounts`, cut from trunk 7c456c73. Not merged into trunk (an integrator merges).
Brief: `claude-session-files/branch/briefs/phase2/BRIEFS.md`, section "accounts" (critiques #21, #22, #30, #40 files half, #60, #61).
Screenshots: `claude-session-files/branch/phase2-shots/accounts/` (harness: `claude-session-files/branch/p2accounts/shots.mjs`).

## Pieces
- [x] 1 Service marks (usage popover done; other surfaces in 3 and 5): `public/brand-marks.js` (inline paths) + `public/assets/brands/*.svg` (provenance), THIRD_PARTY_NOTICES.md, test that the two agree; neutral tile where terms forbid
- [x] 2 Thinking options (also the per-model levels in knobs; tests/thinking-levels.test.mjs K1-K4) per model: `src/thinking-levels.ts` (what Branch really sends per provider), `thinking` on each preset in /api/models, `public/thinking-levels.js` drives #session-reasoning / #models-reasoning
- [x] 3 Accounts page (Settings › Accounts, `public/accounts.js` rewritten; one line in layout.js SETTINGS_PAGES): per provider with marks, state + ring, quick buttons in sight, the rest under "More for this account", search past six accounts, terms line and pooling notice verbatim; "When one runs low" (the connection's own order + the models' fallback order read-only, button to Models); "Which key each Trunk uses" (API key connections only, saved on the Trunk through `POST /api/trunks/:id { keys }`). Messages that sent people to Settings › Models for accounts now say Settings › Accounts. tests/accounts-page.test.mjs A1-A5; accounts-ui U1 now expects `settings:accounts`
- [x] 4 Agent files editor: Branch already had one (R17-S05, src/settings-kit/file-map.ts, owner-only, never-break guard, 8,000-byte limit) buried on General. Reused its routes; added undo of the last save (`POST /api/settings-kit/files/undo`, refuses when the file changed since); new card `public/agent-files.js` on Settings › Assistant replaces the old list (Write/Preview, counter, starter, Undo); `data-level="advanced"` + `branchSettingsLevel` hook. No new switch: nothing new is reachable (same routes, same owner-only rule). tests/agent-files.test.mjs F1-F4; settings-kit-ui R17-S05 moved to the new card
- [x] 5 Secrets rows: mark + plain name ("OpenAI key", "Supplier API key") + "Commands use it as NAME" (hook in app.js renderSecrets, `public/service-marks.js`); the name field says what it is in plain words; marks on the chat apps (Customize › Channels), the ChatGPT/Gemini cards and the fallback list on Models, and the usage popover
- [x] 6 Trunk merged (bfd51975, then pushed), rebuilt, `tsc --noEmit` clean. 25 targeted files: 202 tests, 201 pass; the one failure
      (glass-select "sits flush", gap -388 at 1440) passes alone. After narrowing service-marks.js's watcher to the Settings
      window and Customize, the same 25 files ran 202/202 green; the same set on trunk 9faf5439 in a separate checkout under the
      same load failed that same glass-select test (and short-lived-keys), so it is trunk's flake, not this branch's. Screenshots of
      accounts, accounts-more, accounts-low, files, files-edit, thinking, usage-pop, secrets, channels at 1440/1024/390 × light/dark:
      no sideways overflow, zero console errors after load (the ~47 before settling are the app's own load-time CSP/401/429 noise)

## Last merge
- Trunk merged again at 2a866c8e (hardening-3 had changed public/accounts.js: its household rule is kept in the new page:
  someone else sees shared accounts only, no buttons, list controls, fallback order or Trunks). Rebuilt from an empty dist;
  16 files 132/132 and tests/hardening-3.test.mjs 17/17 green.

## For the integrator
- When the settings builder's level control lands, `globalThis.branchSettingsLevel() === "regular"` hides "Your assistant's
  files" (as the brief asks). Today R17-S05's list shows at every level, so a Regular owner loses it from sight then.
- `public/assets/brands/*.svg` are provenance, not served assets: the marks are drawn inline from `public/brand-marks.js`
  (tests/brand-marks.test.mjs M1 keeps the two identical). No allowlist entries are missing.
- The undo record of an agent file holds its earlier text in the settings store, so backups copy it (documented).

## Deviations from the sample
- No single cross-provider account fallback list: Branch has none. The page shows the two real mechanisms instead.
- No "whose it is" owners, per-person/per-project account defaults, colours or bulk actions: Branch has none of them; the
  real assignments are the conversation chip and the Trunk key picker.
- Accounts rows are a plain list, not the sample's virtual list of 200+ (the server caps a list at 50); a search appears past six.
- Agent files: Branch already had an owner-only editor (R17-S05); the new card reuses it and adds undo, preview, counter and
  starters, rather than a second editor. No "Write it for me", no per-Trunk files, no multi-version history (only the last save).
- Marks: Google, Meta, Microsoft, Apple, Amazon, Slack, X/xAI, Cisco Webex and MiniMax get neutral tiles (terms), unlike the
  sample, which drew several of them. Password managers have no list in the app to decorate.
- Secrets keep the name commands use visible under the plain name at every level (it is what commands need); the level
  control can hide `.secret-raw` later.

## Integration (adversarial review, 2026-09-19)
Reviewed against the brief, the account-sharing rule (STATUS-account-pooling.md) and the sample; fixed with tests:
- [x] Thinking levels: Azure OpenAI reuses `openaiBody`, so it sends `reasoning_effort`, but the map (and K1) said it
      took none. Added; o1-mini, o1-preview and the GPT-5 chat models (which refuse the field) now get none. `sent` on
      each model says whether a saved level is still sent: the window no longer calls such a level "unused" (it said
      so while Branch still sent it); it says the service may refuse it. K2 now also finds providers that reuse the
      shared body builders and checks every provider they define against the map. Nothing about what is sent changed.
- [x] Agent-files undo: it trusted the path saved with the record, so after the project changed or its folder lost
      trust it still wrote there. Now refused unless the record's path is still the slot's file and may be written
      (F5). The saved texts sit one level down in the record, so the diagnostics summary (top-level short values)
      can never copy a word of a file (F5). Backups still copy the record (owner-only, documented).
- [x] Accounts page: a household person with nothing shared fell through to the owner's "When one runs low" and
      "Which key each Trunk uses" cards (and the mode switch they cannot change). `household: true` on their view;
      the page shows neither card nor the switch (A6).
- [x] Terms line: several links all read "Read the terms ↗". Each now names whose terms (keyed, en + fr; the ChatGPT
      page says it is an unofficial guide) (A1, accounts-ui U2).
- [x] Marks: M5 checks every mark file is exactly one title and one path of drawing commands (no script, foreign
      object, style, event, href or url()). All 49 are Simple Icons CC0/MIT, or OpenAI's own brand page, recorded in
      THIRD_PARTY_NOTICES.md; Google, Meta, Slack, Microsoft, Amazon, Apple, Cisco, MiniMax, X/xAI get neutral tiles.
- [x] shell-ui counted twelve Settings pages; Accounts makes thirteen.
Checked and fine: the Trunk key picker lists API-key lists only and the server refuses a sign-in for a Trunk anyway
(pool-provider `forTrunk`); "When one runs low" is read-only text plus a link to Models; search is a local filter;
no new control can rotate between the owner's own plans. The undo route is owner POST, and the short-lived-key and
household rules refuse it (F3); the 8,000-byte limit is enforced on the server (F2); slots are a fixed enum.
Not fixed (trunk, not this branch): `settings-describe.js` and `settings-kit.js` add their CSS with an inline
`<style>`, which the CSP blocks, so the "Applies to everything" scope chip shows as plain text on every Settings card;
glass-select "flush under the select" fails the same way (gap -388) on a trunk-only checkout.
Tests after merging trunk 73f73153: 26 files 230/230, automation 5/5 alone; build and tsc clean from an empty dist.
Screenshots: `phase2-shots/accounts/*-fixed.png` (accounts-low with named terms links, thinking-sent), 1440/1024/390,
light and dark, no sideways overflow, no console errors after load.
