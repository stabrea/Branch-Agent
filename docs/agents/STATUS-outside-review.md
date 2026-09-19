# mac7/outside-review: adversarial review of mac7/outside-resume, and the Trunk-message hole

Branch `mac7/outside-review`, from trunk `mac/cross-platform` at 9faf5439 (outside-resume merged).

## Checklist

- [x] Every start/continue path read for re-deriving the origin from who pressed the button (table below).
- [x] Forging or clearing the origin from outside (request bodies, the waiting line, chat commands).
- [x] Mutation check: each piece of the outside-resume fix taken out makes a test fail (four needed new tests).
- [x] The window says why a conversation carried on from outside asks first, and how to work without asking (en + fr).
- [x] A message one Trunk sends another carries the sender's origin and tools (send, reply, second try, failure notice).
- [x] An outside task cut off by its allowance (`budget_exceeded`) holds the owner's next message, like `interrupted`.
- [x] Tests for both fixes; each fix taken out makes one fail.
- [x] Merged into trunk (trunk 98beb5d8 merged in cleanly; build, tsc, 271 targeted + 29 ui/shell-ui/server tests pass).

## Verdict: FIXED

The outside-resume change is sound where it reaches: no path found re-derives the origin from who pressed
the button, and nothing from outside can forge or clear it. Two holes are closed here: the Trunk message
(known) and `budget_exceeded`; and the window now says why such a conversation asks first.

## Forging or clearing the origin

- `/api/run` parses `RunInputSchema` (src/contracts.ts, `.strict()`, no `source`, `originFrom` or
  `resumeFrom`) and builds its options field by field (src/server.ts `POST /api/run`). Nothing in a body reaches them.
- `carryOrigin` takes `originFrom` out of the options and puts it back only when the named task came from
  outside, so a named task can only make a task stricter. An explicit `source: "owner"` is treated like none.
- The waiting line (`POST /api/queue`, an owner route) takes `source` from the body, limited to
  owner/schedule/trigger/mcp; "owner" there still goes through `carryOrigin` and the conversation check.
- Chat apps have no resume, retry or "do this again" command (src/commands/catalog.ts); `/goal` and `/bg` are not offered in chat apps.
- `followups:` and `flow-run-source:` records are not reachable from the settings kit (it fails closed on
  anything not in its catalogue; `flow-run-source:` is on `neverTouched` too).
- Annoyance, not escalation: A2A (`a2a.ts sessionFor`, agent-protocol) and ACP accept any conversation id
  the owner owns. A program that learns an id can leave a task waiting in the owner's conversation, and the
  owner's next message there is then held to Ask first until that task is no longer the stopped one.

## Paths checked

| Path | Result |
| --- | --- |
| `Runtime.resume`, never-break auto-resume, `cli-run --resume`, evaluation-runner resume | `carryOrigin` via `resumeFrom` |
| never-break `redoStep` | builds its context from the record; the `checkPolicy` choke point covers it too |
| `/api/run` and follow-ups in a conversation, goal rounds (`goal-mode.ts`), rewind (messages cut, tasks kept) | `conversationCarrier` |
| "Do this again" (`replay.ts`), a handed-over step's answer (`settleDeferred`) | `originFrom` |
| Branch/copy (`branchSession`, `duplicateSession`, `sessions` tool, coding worktrees) | `conversationCarrier` walks back |
| Helpers, background specialists, sub-agents (`delegate`, `execute(..., parent)`) | parent context; choke point |
| Steer | joins the running task; nothing to carry |
| Workflows: run/resume/resumeWithoutApproving, collab `/api/workflows/<id>/resume`, `workflows.run`/`workflows.resume` tools | `startedFrom`, `heldSource`; an approval's `source` is kept; `grantApproval` refuses "always" for outside |
| Graph flows: start/resume/`resumeInterrupted`, flow tools, time travel | `flow-run-source:`; tools pass `heldSource` |
| Schedules, heartbeat, triggers, autonomy runner, `/loop` | each run starts with its own outside source |
| Chat router, chat commands (`/btw`, `/compact`, `/help`) | pass `source: "channel"` |
| MCP, A2A, agent protocol, ACP, app-server | pass their own source |
| Remote Trunk messages (`reach/trunk-roster.ts`) | `source: "a2a"`, narrowed tools |
| **Trunk to Trunk messages** (`trunks/messages.ts`) | **was the owner's own; fixed here** |
| Trunk `say` and its queued fallback, Trunk introductions, rooms (`rooms.send`) | owner routes; the owner's own |
| Kanban card "work", `/bg`, voice (`onHeard`), terminal, people/lent conversations | the owner's own start, not a carry-on |
| OpenAI-compatible API (`/v1/chat/completions`) | runs as the owner (owner key); a start, not a carry-on — unchanged |
| Conversation import (from a file) | not linked to where it came from; marked imported (as outside-resume noted) |

## What was added

- `Runtime.followUp(sessionId, prompt, person, { originFrom, permissions })`: a queued message keeps the task
  it carries on and no more than that task's tools. `TrunkMessages` passes the sending task (a reply: the
  answering task) on send, reply, second try and failure notice; a task with no tools on record passes none.
  The receiving Trunk's own shape intersects its list with that (`trunkPermissions`, `caller`). Where no
  Trunk shape applies (a retired chat on a second try), the list is used as it is; before, that task had
  every tool, so it can only narrow.
- `conversationCarrier`: `budget_exceeded` counts as cut off. This is the reviewer's own addition beyond the
  brief (outside-resume held only `needs_input` and `interrupted`); one line in src/outside-origin.ts to take back.
  The test sets the status in the record rather than running a task out of its allowance.
- `/api/conversation-mode` view: `outside` (the source, or null). The chip then shows *Ask first* (or Plan),
  its title and menu say "This conversation carries on work that came from outside this window (...), so
  Branch asks before every change here, whatever you pick. To work without being asked, start a new
  conversation of your own." (en + fr).
- Docs: configuration.md and handbook chapter 4.

## Mutation check (fix taken out of `dist/`, test file run)

outside-resume pieces: branch walk, stopped-last, workflow tool, flow tool, `carryOrigin`, deferred, kept
tools, replay, workflow `startedFrom`, graph source — each fails a test in tests/outside-resume.test.mjs.
Four did not: the `checkPolicy` choke point, the record read in `Runtime.policy`, the `workflows.resume`
tool and time travel. Each now has its own test in tests/outside-review.test.mjs and fails it when taken
out. Still with no test of their own (belt and braces, each covered by another layer): `originFrom` in
`runOrigin`'s chain (carried tasks record their source themselves) and `redoStep`'s context (choke point).

This branch: Trunk send, second try, reply, tools, fail-closed, follow-up tools, `budget_exceeded`, the
view's `outside`, and the chip (title and menu note) — each fails a test when taken out.

## Notes, not fixed

- A Trunk's task that stops to ask (needs_input) marks the message receipt "failed" and sends a failure
  notice back; before this change that only happened under a stricter preset, now also for messages from outside.
- Rooms: each member's turn runs with its own tools; a narrow member's words reach a wider member in the
  same room. The room is the owner's own discussion, so its origin is right; limits across members are a design question.
- The owner's message carried on as a chat's (source channel) keeps the owner's tool list, held by the
  source (Ask first, chat refusals), not the chat's narrower list. Same as outside-resume decided.
- "Do this again" on a short-lived key's task by the owner runs as the owner's (not an outside source; pre-existing).
