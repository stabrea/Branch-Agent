# mac7/outside-resume: an outside task stays an outside task when it is carried on

Branch `mac7/outside-resume`, from trunk `mac/cross-platform` at 7c456c73. Found by the redesign
phase 1 integrator (STATUS-redesign-phase1.md, "Notes, not fixed").

## The bug

A task started from a schedule, a trigger, a chat app (`source: "channel"`), MCP, A2A or ACP came
back as the owner's own when it was carried on. `runOrigin` (src/key-context.ts) already read the
right origin through `resumedFrom`, but the approval policy never asked it: `Runtime.policy`,
`checkPolicy` and the approval question took the source from the task's context, and a resumed task's
context said "owner" unless it was a chat's. So a resumed trigger task under **No approvals** wrote
files without asking (the 0.18.1 hold was lost), its question could be answered "Yes, always" and
write a standing rule, and a flow or workflow carried on by the owner ran its remaining steps as the
owner's. Carrying a task on in other ways — the owner's next message after answering its question,
"Do this again", a handed-over step's answer — started a new task with no link to the outside one at
all, so a chat's task carried on in the window lost the chat app's owner-only refusals too.

## The rule now

A task's origin (its source, and with it the chat, key and person marks `runOrigin` reads) is written
on its own `run.started` when it starts, and every way of carrying it on reads it back from that
record, never from who pressed the button:

- `Runtime.execute` calls `carryOrigin` (src/runtime.ts) before anything else. A task that resumes
  another (`resumeFrom`), says which one it carries on for (`originFrom`, new), or is a new message in
  a conversation an outside task began — or that an outside task is stopped in (waiting for an answer,
  or cut off) — gets that task's source, writes it on its own start with `originFrom` naming the task,
  and a resumed task also keeps the tools it started with. `runOrigin` follows `originFrom` as it
  follows `parentRunId` and `resumedFrom`, so every guard that reads the record (chat refusals,
  `ownersOwnTask` for the mode chip, GitHub, sign-ins, removing Branch, devices, listen address, ...)
  sees it too. src/outside-origin.ts holds `conversationCarrier` and `outsideSourceOf`.
- The choke point: `Runtime.policy`, `checkPolicy` and the approval question hold a piece of work as
  its context's source or its task's recorded source, whichever is from outside (`sourceOf`, read once
  per task). A context built by hand (restart recovery, a helper, a tool's own context) cannot drop it.
- Workflows keep who set a run going (`startedFrom` on the workflow); carrying one on after a pause, a
  wait or the owner's yes keeps it. Starting it afresh from the first step (idle, finished or failed)
  is whoever starts it, as the task limit already works.
- Graph flows keep an outside source with the run (`flow-run-source:<run>` in settings, refused by the
  settings kit like `flow-run-limit:`); `FlowGraphRunner.work` reads it on every carry-on, and a copy
  from an earlier step (time travel) is held as the run it was copied from.
- A flow or workflow a task sets going through its tool is held as that task (`heldSource`), read
  from the record when the tool's context was built without a source.

**Owner take-over.** There is no feature that lets the owner, in the window, take an outside task over
as their own work (searched for take over / takeover / hand over; the only hand-over is the
browser's "take over the page", which is about a web page, not a task). So nothing lifts the hold:
the owner answering the question, pressing Continue, "Do this again", typing in the conversation,
branching or copying it, or picking Full access on the mode chip all leave the task held to Ask
before changes. What the owner can do is answer each question (Once or for this conversation; a
standing yes stays refused), or start a new conversation of their own and ask for the work there —
that is the owner's own task, and it is not linked to the outside one.

## Every resume path, and how it carries the origin

| Path | Code | How the origin is carried | Test (tests/outside-resume.test.mjs) |
| --- | --- | --- | --- |
| Continue on an interrupted task (`POST /api/runs/<id>/resume`) | `Runtime.resume` → `execute({resumeFrom})` | `carryOrigin` reads `runOrigin(resumed)`: source + recorded tools | "Continue on an interrupted outside task", "keeps the tools it started with" |
| Resume after a restart (never-break auto-resume) | src/never-break/resume.ts → `runtime.resume` | same as above | "Continue on an interrupted outside task" |
| A step redone during restart recovery | never-break `redoStep` builds its own context | context built from the record (`outsideSourceOf` + recorded tools); `checkPolicy` choke point | "a step redone after a restart" |
| `branch run --resume` | src/cli-run.ts → `runtime.run({resumeFrom})` (not `Runtime.resume`) | `carryOrigin` in `execute` | "branch run --resume" |
| Evaluation runner resume | src/evaluation-runner.ts → `runtime.resume` | same as Continue | (owner's own evaluation tasks; same code as Continue) |
| Carrying on after answering a question in the window ("send your next message to carry on") | `/api/run` with the conversation → `execute` | `conversationCarrier`: the outside task the conversation began with or is stopped in | "carrying on after answering its question" |
| Queued follow-up message (follow-up box, page notes, boards) | `followUp` → `drainFollowUps` → `execute` | same | "carrying on after answering its question" (queued part) |
| Answer in a chat app, then the chat sends again | chat router starts the next task with `source: "channel"` | the caller passes it (unchanged, pre-existing) | chat-source.test.mjs |
| ACP / app-server "Go ahead with the step you were waiting on" | src/acp.ts, src/asks/app-server.ts | new task with `source: "acp"` (unchanged) | interop tests |
| MCP call waiting for an answer | src/mcp-server.ts | the client's next try is judged with `source: "mcp"` (unchanged) | mcp-server.test.mjs |
| A steer (a note to a running task, from the window or a chat) | `Runtime.steer` | no new task: the note joins the running task, whose context is unchanged | (nothing to carry) |
| "Do this again" | `POST /api/runs/<id>/replay` → `replayRun` | `originFrom: <the task>`; an outside task's replay is held as it | "Do this again" |
| A handed-over step's answer | `settleDeferred` → `followUp(..., originFrom)` | `originFrom: <the task that handed it over>` | "a handed-over step's answer" |
| Helpers and background specialists | `execute(..., parent)` | context copied from the parent; `parentRunId` in the record; choke point | chat-source.test.mjs, conversation-mode.test.mjs |
| Conversation branched off or copied | `branchSession`, `duplicateSession` | `conversationCarrier` walks to the conversation it came from | "branched off or copied" |
| An outside task that joined the owner's conversation | e.g. a Trunk message (a2a) | held while it is the one stopped (waiting or cut off); once it has finished, the owner's next message is theirs again | "joined the owner's conversation" |
| Goal rounds (resume a paused goal) | src/goal-mode.ts → `runtime.run` in the conversation | `conversationCarrier` (same code as a follow-up) | (covered by the follow-up test) |
| Workflow: owner's yes, carry on after a pause or wait, the `workflows.resume` tool, collab server | src/workflows.ts `run` / `resume` | `startedFrom` kept on the workflow (`heldSource`) | "a workflow a schedule set going" |
| Workflow started by a task's tool | `workflows.run` tool | `heldSource(context, record)` | (same code as the flow tool test) |
| Graph flow: Carry on / approve, restart (`resumeInterrupted`), `workflows.resume` on a graph | src/flows.ts → `FlowGraphRunner.resume` → `work` | `flow-run-source:<run>` | "a graph flow a schedule set going" |
| Graph flow: go back to an earlier step (time travel) | src/flows-boards/time-travel.ts | copy held as `graphs.sourceOf(original)` | (read, not run: needs the time-travel part switched on) |
| Graph flow started by a task's flow tool | `flows.<name>` tool → `startGraph(..., source)` | `heldSource(context, record)` | "a flow an outside task sets going" |
| Schedule re-runs | autonomy runner, heartbeat, triggers | each run is a new task started with its own outside source (never re-derived) | policy-outside-hold.test.mjs |

The owner's own work is unchanged: "the owner's own interrupted task resumes exactly as before", the
owner half of the chat, replay, mode, workflow and flow tests, and the existing suites.

## Checklist

- [x] Origin read from the record on every resume/carry-on path (`carryOrigin`, `originFrom`, `runOrigin`).
- [x] Choke point in `policy` / `checkPolicy` / the approval question (`sourceOf`).
- [x] Workflows and graph flows keep who set them going; flow/workflow tools held as the calling task.
- [x] Restart recovery's redone step judged as the outside task, with its tools.
- [x] Tests for every path above (16 in tests/outside-resume.test.mjs). With the fix taken out of
      `dist/` (a worktree at 7c456c73, built, with this test file), 13 of the first 14 failed on the
      assertion they exist for and the owner's-own test passed; the two added after that (branch/copy,
      workflow tool) were written the same way but not re-run against the old build.
- [x] Regression run: 97 related files, 1471 tests, 1 failure — tests/settings-descriptions.test.mjs
      (`#mode-new-conversation has no description`, a redesign phase 1 control in public/; this branch
      touches nothing in public/).
- [x] Docs: configuration.md and handbook chapter 4 say an outside task stays held when carried on.
- [ ] Merged into trunk.

## Not done / notes

- A "Trunk" message from another Trunk queued with `followUp` (src/trunks/messages.ts) starts as the
  owner's (no source at all). That is how it starts, not how it is resumed; outside this fix.
- An imported conversation (from a file) is not treated as outside; it is marked imported already.
- A resumed outside task now keeps the tools it recorded when it started (a chat's always did); a
  tool installed since it started is not in its list.
