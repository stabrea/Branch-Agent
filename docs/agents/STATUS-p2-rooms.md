# Redesign phase 2 "rooms": status

Branch `mac7/p2-rooms`, worktree `C:/Users/bishi/Code/wt/p2-rooms`, cut from trunk `mac/cross-platform` at 7c456c73.
Brief: `claude-session-files/branch/briefs/phase2/BRIEFS.md` ("rooms"), sample parts `p19-rooms.js`, `p20-voice.js`,
critiques #32 (Trunks per conversation, rooms, @mentions) and #33 (live voice, dictation bar). Not merged into trunk:
an integrator merges it.

What was already there (0.18.1): the room engine (`src/trunks/rooms.ts`, `room-plan.ts`: 2-6 Trunks, @mentions,
pass, 3 rounds / 10 replies, answering a waiting Trunk in the room, restart resume) shown only as a plain list in
Customize › Specialists; dictation (`public/dictation.js`); Talk live (`public/voice-live.js`, `src/realtime-voice.ts`).
Most of this piece is surfacing those well, plus closing the holes that surfacing them would widen.

The rule this branch keeps: **the room's own conversation (`room.sessionId`) is where the mode lives; each member's
conversation follows it** (capped by that Trunk's own limits: its tools, its reach, its keys).

## Pieces

| # | Piece | State |
|---|---|---|
| 1 | Room turns follow the room conversation's mode (and a short-lived key's message never gets the owner's looser mode) | [x] done: `runtime.modeFollows` (src/runtime.ts) set by Trunks from `rooms.memberRooms()`; a key's message is recorded `byKey` and its turns run under that key (src/trunks/rooms.ts). tests/p2-rooms.test.mjs (4 tests; the key test fails with the fix taken out of dist) |
| 2 | Choose which Trunk a conversation uses (new switch, ships off) | [x] backend done: part `conversations` (`trunks-conversations`, off), src/trunks/conversations.ts, routes under /api/trunks/conversations (owner only), a room made from a conversation carries its last messages (`Room.context`, room-plan `roomPrompt`). Also: Talk live route wired (it was never served) and made owner-only, refused in Trunk conversations and rooms. tests/p2-rooms.test.mjs. UI in piece 3 |
| 3 | Rooms open as conversations in the chat: faces button, members popover, add/remove, @, replies signed, approvals, Stop | [x] done: public/rooms.js + rooms.css (who button in the header, Talking to on an empty conversation, glass list, room drawn in #conversation, Yes / Yes to all, Stop, signed replies in Trunk conversations). Fixed on the way: a yes in a room looped for ever (answer now remembers for that member in the room, src/trunks/rooms.ts). tests/p2-rooms-ui.test.mjs |
| 4 | @mention picker in the composer for rooms (members first, "mentioning adds it") | [x] done: rooms.js picker (Enter/Tab pick, Esc closes, never sends); public/trunks.js steps aside when rooms.js handles @ (3 marked lines). tests/p2-rooms-ui.test.mjs |
| 5 | Dictation bar in the composer | [x] done: public/voice-bar.js (Dictate as a microphone; a bar while it listens: time, nothing leaves this computer, keep ✓ / throw away ✕); dictation.js gains `branchDictation.stop(keep)` (marked). Esc still stops and keeps, as before. tests/p2-voice-ui.test.mjs (routes answered by the test, no microphone) |
| 6 | Talk live voice view (ships off) | [x] done: voice setting `liveView` off/on (Settings › Voice); public/voice-view.js (orb from real levels, captions, Mute, Cut in, Show the chat, End, folds away on a question; send button offers Talk live on an empty box); voice-live.js sends events and exposes press/stop/mute/levels (marked). `/api/voice/live` was never served: wired, owner-only. tests/p2-voice-ui.test.mjs |
| 7 | Docs, locales, screenshots, merge trunk, final tests | [x] docs/configuration.md (trunks-conversations, liveView, room mode, room yes, Talk live route), en+fr strings, 66 shots in phase2-shots/rooms (1440/1024/390, light/dark), trunk merged twice (last: 98beb5d8, hardening-3), broad run after it 310/312: tests/web-ui.test.mjs U2 timed out once and passed on rerun; tests/p2-rooms.test.mjs failed once at file level under load and passes alone and alongside web-ui (its server now closes before its folder is removed) |

## How to continue

- `npm run build`, `npx tsc --noEmit`, `node --test --test-concurrency=2 tests/p2-rooms*.test.mjs tests/trunks*.test.mjs tests/conversation-mode.test.mjs`.
- Never run tests/desktop*.test.mjs or tests/screen-control.test.mjs. Never open a real microphone in a test.
- Screenshots: `claude-session-files/branch/p2-rooms/shots.mjs <worktree> <scene...>` into `phase2-shots/rooms/`.

## Deliberate differences from the sample

- No "main one" and no "who answers when nobody is mentioned" control: the sample marks it a proposal, and the real
  room engine has one rule (nobody mentioned means everyone). No side-by-side replies (replies stack, signed).
- Adding a Trunk to a conversation makes a named room (the engine's persisted room) carrying the last messages; the
  conversation itself stays as it was, rather than the sample's in-place membership.
- The dictation bar shows no waveform: the app has no sound level for dictation, and a made-up one would be a fake.
  Esc still stops and keeps the words (as before); the bar's ✕ throws them away.
- The live view's circle moves with the real sound levels (AnalyserNode on the mic and on playback).

## Known, not ours

- trunks.js avatar() sets colours through a style attribute, which the window's CSP refuses (console errors, and it
  would be black); rooms.js re-applies them with style.setProperty. p2-shell replaces avatar() with faces.js and fixes
  both; take theirs at merge (our one `>>>` line in avatar() will conflict).
- Room member conversations appear in Recents with the room prompt as their title (pre-existing).
- "Your assistant needs you" banner (app.js) names the assistant for a Trunk's question in a room (pre-existing);
  its Open conversation leads to the member's side, which offers Open the room.

## Integration (adversarial review, Claude, 2026-09-19)

Reviewed f071bc26, merged with trunk f5b8d582 (outside-review, tests-unattended; clean) and then 5d2af697/c39d9bed
(p2-accounts; one conflict in public/index.html, the stylesheet links, both kept).
Fixes in 9a1b43a4 and the commit after it. Verdict: **MERGE WITH FIXES** (applied). Every new security test was
checked to fail with its fix taken out of `dist/` (7 of 7; the face test with the fix taken out of `public/`).

Fixed (tests marked "integration review" in tests/p2-rooms.test.mjs and tests/p2-rooms-ui.test.mjs):
- [x] **Room yes, scoped and shown.** It was already bound to the Trunk's own side of the room and to the exact
  request (tool, target, bytes) for an hour, but it outlived the seat: taking the Trunk out or removing the room
  left it standing, and the copy kept for a restart brought it back. Now it ends with the seat and with the room
  (`Runtime.endGrants`, the restart copy too); the room shows each one ("Ledger may do this in this room: …",
  until when) with **Revoke** (`POST /api/trunks/rooms/:id/revoke`, owner only). A key or a household profile
  cannot leave one standing through `/api/policy/approve` (401; a key could, for a turn its own message started).
  A request the safety check advised against is answered once, never kept (it threw before).
- [x] **A room member's own mode.** The member's side was read first, so a mode put on it (Recents, the chip)
  beat the room's; the room's mode now always wins.
- [x] **Blocking: Talk live's refusals were on the route only.** Every task's socket (`/api/runs/:id/ws`) accepts
  `{live:"start"}`, so a room member's or a Trunk conversation's task could host a live conversation whose tools
  run as the owner. The refusal is now in `LiveConversations.start` (src/live-refusal.ts), and it also refuses
  under Lockdown (the sound leaves the computer), for a household person, and in a conversation that began outside
  Branch (outside-resume's carrier). Tools in a live conversation are still judged with the conversation's mode.
- [x] **Recents.** A room's inner conversations (first message: the room's instructions to that Trunk) are kept
  out of Recents, search and the phone list (`store.hiddenSessions`, a `NOT IN` in the query so pages stay whole).
- [x] **"… needs you"** names the Trunk ("Ledger needs you in Price check") and Open leads to the room. en + fr.
- [x] **Faces.** p2-shell is not on trunk, so this branch's avatar() stays. The `>>>` fix is right; the colours
  were still refused by the window's content rules everywhere except rooms.js (the sidebar's faces drew black).
  `shape()` in public/trunks.js now sets them through the element's style; rooms.js's `keepColours` is gone.
  When p2-shell (faces.js) merges, take theirs and drop this.
- [x] **Switch off**: with "Choosing a Trunk" off nothing changes (tested by the builder); a conversation chosen
  before it was switched off can now be given back to your assistant (it was stuck).
- [x] A room's last card clears the message box's fade on a phone (padding under 700 px).
- [x] Ending a room's yeses empties only the answers carried into a restart (`dropCarriedGrants`), not the
  conversation's model or project.
- [x] Test flake (fix waits for the condition): tests/p2-rooms-ui.test.mjs's first test sent before trunks.js knew
  the Trunks on a busy machine.

Checked and fine: room turns after a restart and after a yes keep the key a message came with (`byKey` in the
persisted log); only keys reach `rooms/:id/send` from outside (chat apps, schedules and tools do not), so there is
no other outside origin to carry into a room turn; trunk's outside-review fix (a Trunk-to-Trunk message) targets a
Trunk's own chat, not room turns, so nothing to reconcile. The switch ships off and nothing changes while off.
`/api/voice/live` is 401 to keys (tested), refused to a household person, refused in Trunk conversations/rooms.
The microphone opens only on press (voice-live.js `press`), Mute stops sending; nothing is recorded before.

Per piece: 1 VERIFIED (after fixes), 2 VERIFIED, 3 VERIFIED (after the yes/Revoke/banner/Recents fixes),
4 VERIFIED, 5 VERIFIED, 6 VERIFIED (after the socket refusal), 7 VERIFIED (docs updated for the fixes).

Not fixed / notes:
- (fixed) tests/p2-voice-ui.test.mjs "the view follows the live conversation" failed on a busy machine, on the
  builder's f071bc26 too: a live conversation that began before the view's setting was read never opened the view
  (the event was spent). public/voice-view.js now shows the view after every read of the setting (`follow()`);
  3/3 in sequence, and it fails with that line taken out.
- The room's own conversation still shows in Recents under the owner's first message; the Trunks' own chats show
  "Introduce yourself to the owner…" (pre-existing, not a room's).
- The room UI offers Yes (holds for the hour, in the room) and No; no "just this once" (every re-taken turn would ask
  again). The Yes button's label says so.
- `GET /api/trunks/conversations/:id` needs only Trunks on, not the Conversations part (read only).
- Screenshots: `phase2-shots/rooms/room-fixed-*.png`, `room-allowed-fixed-*.png` (1440/1024/390, light/dark).
