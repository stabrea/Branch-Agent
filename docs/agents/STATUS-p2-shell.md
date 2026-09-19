# Redesign phase 2 — shell: status

Branch `mac7/p2-shell`, worktree `C:/Users/bishi/Code/wt/p2-shell`, cut from trunk `mac/cross-platform` at 7c456c73.
Brief: `claude-session-files/branch/briefs/phase2/BRIEFS.md` › "shell" (Trunks rail, studio, people, 3D stand-ins).
Sample: `claude-session-files/branch/branch-grown-up/` (parts p6, p8, p9, p13, p21, p30, p36).
Screenshots: `claude-session-files/branch/phase2-shots/shell/`. Not merged into trunk (an integrator does that).

The sample calls it "the rail"; in the real app `.rail` / `#conversation-rail` is already the sidebar, so
the new thing is **the Trunks strip** (`#trunk-strip`, `public/strip.js`) everywhere in code and words.

## Pieces

- [x] 1. The strip (#9, #7): Branch's mark (Overview), this computer, paired computers/phones (Devices),
      Trunks each with its own face, +, Who is using Branch. Fixed at the left edge; the body grid steps aside
      by padding so the panes' own columns are untouched; a row at the foot at <= 860 px. Setting
      `shell-look.strip` (on by default: a layout the owner asked for). `public/strip.js`, `strip.css`.
- [x] 2. A Trunk's look saved on the Trunk (`look`, `src/trunks/look.ts`): face drawn/letters/emoji/pattern
      (photo = the existing picture), colour = series token 1-8 or "theme" (never a value), 7 shapes, 6
      movements, 3D. One renderer `public/faces.js` used by the strip, studio, sidebar roster (trunks.js
      `avatar()` now delegates), People, Overview and replies. Change look / Rename / Settings / Pin / Move /
      Hide / Remove from Branch's own menu (right-click, long press, ⋯); drag to reorder (#8).
- [x] 3. Add a Trunk studio (#34, #27): one dialog, one tab strip (A new Trunk / Another computer / Your
      phone) that stays; pairing steps Pair › Let it in › Name it › What it may do with Back; "Stop pairing?"
      before closing or leaving a tab with an open invitation. **Pairing without a terminal**: "Join another
      computer" on the other Branch (`src/devices/join.ts`, `/api/devices/join`) runs `pairNode` + `NodeClient`
      in-process, key in `<data>/node/`, reconnects while Branch runs; `devices-join {on}` ships off. Rename
      computers (existing `/api/devices/:id/rename`, now called). Plain words after pairing. Trunks off → the
      studio says so and offers the switch. The sample's "Your KeepOak computer" tab is left out (no such link).
- [x] 4. People (#11, #23): place `household:people` with faces, role, projects, allowance, signed-in devices,
      add/switch/role/remove (owner), own card + way back (household). Overview (`overview:here`) of this
      computer / a device / a Trunk, all real data. "Who is using Branch" on the strip's People button.
- [x] 5. Replies (#18): the assistant's own face (drawn from its name) before the author line; Trunk
      conversations get the Trunk's face unless p2-rooms' `public/rooms.js` is present (it signs those). Status is a
      ring following the face's shape (green/amber/grey), not a dot.
- [x] 6. 3D stand-ins (#46): hand-written CSS (six slabs of the shape in a slowly tilting block), per Trunk
      `depth: "3d"`, only while `shell-look.faces3d` is on (ships off). The pairing ring is a smooth conic band,
      drawn on a computer/phone asking to join (a provisional `asking:` face in the strip, which opens the studio at
      Let it in) and on this computer's face while it is joining another Branch.
- [ ] 7. Guide lightbulb (#36): **not present in the real app** (no guide, tour or compass button exists), so
      nothing to change; deliberately not invented.
- [x] Docs: docs/configuration.md "The Trunks strip, faces, Overview and People"; docs/places.md homes.
- [x] Locales: ~250 keys en + fr (strip., studio., pair., ov., household., shellLook., place.overview/household).
- [x] Tests: tests/p2-shell.test.mjs (server: look, switches, two-server join), tests/p2-shell-ui.test.mjs (window).
- [x] Merge latest origin/mac/cross-platform (clean, at 98beb5d8), dist rebuilt from scratch, retested, pushed.

## Test runs (merged tree)

- Trunk merged twice (98beb5d8, then 73f73153, both clean); dist deleted and rebuilt each time; `npx tsc --noEmit` clean.
- tests/p2-shell.test.mjs 4/4, tests/p2-shell-ui.test.mjs 12/12 (includes the French redraw and the pairing ring).
- 30 files (p2-shell*, trunks*, devices*, people*, calm-ui, shell-ui, web-ui, redesign-phase1, glass-select, mobile-shell,
  conversation-mode, suggestions, household-profile, lockdown-*, hardening-3, outside-resume, static-assets,
  index-structure, handbook) on 6dc916a6+the first-paint fix: 314 tests, 311 pass, 0 fail, 3 skipped.
- After merging 73f73153: 13 files (mine, static-assets, index-structure, handbook, trunks*, conversation-mode,
  outside-review, glass-select, devices-ui): 103/103 on the second run. The first run had one failure in
  glass-select "the list sits flush under the select" at 1440 (gap -388 px: the select moved after the list opened);
  it passed 3/3 alone and in every other run. Not proven to be unrelated to the strip.
- Earlier, a real regression this work caused and fixed: the strip arriving after load moved the page at 390 px and
  closed an open glass list; its room is now kept from the first paint (strip.js `reserveRoom`).
- shell-ui "a folded Projects group stays folded" failed once in one full run: the group's key is saved before the
  workspace name answers (a race in that code); the strip adds five start-up requests, which may widen it. It passed in
  the other full runs and twice alone.
- Screenshots: 15 scenes x light/dark x 1440/390, plus 5 at 1024x700 (panel open included): zero page errors after load,
  no sideways overflow.

## Shared-file edits (all marked `phase2/shell`)

`public/index.html` (3 css links, 3 script tags), `public/layout.js` (PLACES overview/household with `strip: true`,
lastTab fill, buildRail skip), `public/trunks.js` (avatar() delegates to faces.js), `src/server.ts` (import, route
block, static allowlist), `src/index.ts` (Devices gets `join.nodeDir`), `src/devices/{index,api}.ts`,
`src/trunks/record.ts` (optional `look`).

## Coordination

- p2-rooms: rooms.js signs Trunk replies with `.message-face[data-trunk]`; mine are `.message-face[data-assistant]`
  and skip `[data-trunk]`; asked rooms to replace a `[data-assistant]` face when it adds a Trunk face.
- p2-settings: places `#shell-look-card` (data-home settings:appearance) in its buckets; owns the gear after the
  account row. Search rows for the two settings can be added to public/settings-index.js after both land.
- p2-panels (not active when this was built): its "right-click › Hide this" must leave `#trunk-strip` to the strip's own
  menu (the strip's contextmenu handler runs in the capture phase and stops the event).

## How to continue

- `npm run build`, `npx tsc --noEmit`, `node --test --test-concurrency=2 <explicit files>`.
- Never run tests/desktop*.test.mjs or tests/screen-control.test.mjs.
- Screenshots: `node claude-session-files/branch/p2shell/shots.mjs <worktree> <scene...>` (scenes in scenes.mjs there:
  strip, strip-3d, menu, studio, studio-off, studio-computer, studio-join, studio-phone, overview, overview-device,
  people, people-page, replies). Locale strings: `python claude-session-files/branch/p2shell/fr.py <worktree>`.

## Integration (integrate-p2-shell, 2026-09-19)

Adversarial review, fixed on this branch, merged into `mac/cross-platform`.

Security (pairing without a terminal) — it runs the same protocol as `branch node pair`, so the invitation
is unchanged: 128-bit offer id + six digits, five minutes, one use, five tries, 20/min global + 10/min per
address, https or loopback/Tailscale only, the owner's explicit "Let it in", and every ability off. The
route sits under `/api/devices`: owner only, refused to a household person and to a short-lived key, and
behind the origin/`sec-fetch-site` check. Fixed here:
- [x] **Mutual check** (was missing in both paths): `keyCheck(publicKey)` (src/devices/protocol.ts) is
      shown on the joining computer while it waits, beside the request in the studio and on the Devices
      card, and printed by `branch node pair`. The key itself is never in any answer.
- [x] **A yes after Stop connected / re-saved the key**: the wait for the yes now takes an AbortSignal
      (`pairNode` `signal`); Stop, Leave, Lockdown and close abort it, so a late yes connects nothing and
      leaves no key. A new join after Leave cannot be hijacked by the old wait. Removal on the other side
      now forgets the key here too (it only switched off before).
- [x] Attack tests (tests/p2-shell.test.mjs, "integration review"): a replayed invitation is refused
      and leaves no second request; a yes after Stop; http to a public/LAN address, ftp, a cross-site
      Origin, `sec-fetch-site: cross-site` and no key are all refused; no key in either window's answers;
      Lockdown closes a joined line and it comes back after; removal forgets the key; a household person
      cannot restyle/hide/reorder/re-picture/remove a Trunk; SVG and oversized pictures refused.

Window fixes (owner nitpicks): dragging a Trunk moved it by swapping (now it moves); Hide gets an Undo in
the notice; "Let it in"/"Refuse" were stacked; "Your phone" tab was cut off at 390 (tabs share the row);
"ready · needs you · off" wrapped into a column of dots (each face now captioned); Overview/People title
was 16 px because layout.css won (now the sample's large condensed title); add-person PIN placeholder cut
off at 390; "Leave" said while only waiting (now "Stop joining"); a strip switched off could be drawn
before the first server answer (starts from the remembered choice).

glass-select `-388` on trunk: **not caused by the strip** (strip.js is not on trunk). Root cause: app.js's
3-second refresh re-renders `#policy-preset`'s options, glass-select's MutationObserver closes the open list,
and a hidden list measures `top 0`, so the gap is -select.bottom. ci-flakes-2 fixes glass-select.js
generally; here `approvals.js` just stops rebuilding unchanged options (test: an open dropdown survives two refreshes).

Guide lightbulb (#36): confirmed there is no guide/tour/compass button in the real app (Help is a text item
in More; the only "compass" is an emoji-picker entry in studio.js). Nothing to change.

Rooms black-face fix: faces.js uses unsigned shifts throughout and sets colours through CSSOM
(`style.setProperty`), which the `style-src 'self'` policy allows; a new test checks computed colours of
80+ faces (strip, faces.js and trunks.js `avatar()`) are never black or empty.

Screenshots retaken as `*-fixed.png` (asking, studio, studio-computer, join-waiting, overview, people-page,
menu, strip; light/dark, 1440/390): zero page errors after load, no sideways overflow.

Audit verdicts: 1 strip VERIFIED; 2 look + own menu VERIFIED; 3 studio + pairing VERIFIED (with fixes);
4 People/Overview VERIFIED; 5 reply faces VERIFIED; 6 3D stand-ins VERIFIED; 7 lightbulb N/A (no guide exists).

Not done / notes: the check code is shown but not enforced (the owner compares); the phone app does not
show it yet (apps/ not touched). The Overview/People pages keep the places' own floating composer, which
sits over the last lines until scrolled. The first load in a brand-new browser with the strip off on
the server still reserves the strip's room until the first answer (nothing is remembered yet).
