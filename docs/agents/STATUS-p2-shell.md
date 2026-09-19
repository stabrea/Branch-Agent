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

- tests/p2-shell.test.mjs 4/4, tests/p2-shell-ui.test.mjs 12/12 (includes the French redraw and the pairing ring).
- 30 files (p2-shell*, trunks*, devices*, people*, calm-ui, shell-ui, web-ui, redesign-phase1, glass-select, mobile-shell,
  conversation-mode, suggestions, household-profile, lockdown-*, hardening-3, outside-resume, static-assets,
  index-structure, handbook): 312 tests, 308 pass, 3 skipped, 1 fail = shell-ui "a folded Projects group stays folded"
  (timing: it passed in the first run and twice alone; not touched by this work).
- Screenshots: 14 scenes x light/dark x 1440/390 plus 5 at 1024x700 (panel open included): zero page errors after load,
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
