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
| 3 | Rooms open as conversations in the chat: faces button, members popover, add/remove, @, replies signed, approvals, Stop | [ ] |
| 4 | @mention picker in the composer for rooms (members first, "mentioning adds it") | [ ] |
| 5 | Dictation bar in the composer | [ ] |
| 6 | Talk live voice view (ships off) | [ ] |
| 7 | Docs, locales, screenshots, merge trunk, final tests | [ ] |

## How to continue

- `npm run build`, `npx tsc --noEmit`, `node --test --test-concurrency=2 tests/p2-rooms*.test.mjs tests/trunks*.test.mjs tests/conversation-mode.test.mjs`.
- Never run tests/desktop*.test.mjs or tests/screen-control.test.mjs. Never open a real microphone in a test.
- Screenshots: `claude-session-files/branch/p2-rooms/shots.mjs <worktree> <scene...>` into `phase2-shots/rooms/`.
