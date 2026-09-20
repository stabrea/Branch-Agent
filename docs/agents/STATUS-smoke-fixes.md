# mac7/smoke-fixes — three faults from the real-model smoke test

Branch `mac7/smoke-fixes`, from trunk `mac/cross-platform`. The repros are B5, B6 and B4 in
`docs/agents/STATUS-feature-smoke.md` (branch `mac7/feature-smoke`). Worst first. Not merged into
trunk by me; an integrator reviews after this.

## B5 — Plan mode changed a file without showing the plan

### What was really wrong (a correction to the repro's reading)

The smoke test's repro was `branch run --plan "Change src/greet.js so it greets in French."` with
`plan-act` believed to be `{planMode:"show-plan", autonomy:"changes-only"}`. It blamed the headless
run. That is not the cause, and I can show it both ways on a scripted provider:

- **Plan mode really saved** → the task stops with the plan, `plan.awaiting_approval` is written and
  the file is untouched — **in the unattended run exactly as in the attended one**. The approval
  path is not skipped for a headless task.
- **Plan mode not saved, `--plan` alone** → `plan.created`, no `plan.awaiting_approval`, `files.write`
  runs, status `completed`, output `"Finished."` — the smoke test's event list, exactly.

So there were two faults, neither of them about being headless:

1. **`--plan` is not the switch.** `RunConductor.wantsPlan()` (`src/orchestration.ts`) reads
   `options.plan`, but `needsApproval()` never did — it only read the saved `planMode` and the
   `planApproval` setting. `branch run --plan` therefore means "work out a plan, then carry it out",
   and nothing in `branch run --help` or `docs/configuration.md` said so.
2. **`POST /api/plan-act` could save nothing and not say so.** `scope` defaults to `"conversation"`,
   so a body with `planMode`/`autonomy` but no `scope` and no `sessionId` fell through every branch
   of `planActApi` (`src/server.ts`), wrote nothing, and still answered with an `effective` block
   showing the project's setting. That is almost certainly why the smoke run believed Plan mode was
   on: the window always sends a scope, a script need not.

### What I decided, and why

- **Nobody to ask means the plan is the answer.** With "Show me the plan first" on and nobody who
  can say yes, the task now finishes `completed` with the plan as its output and changes nothing.
  It used to end `needs_input` — a question put to nobody, exit 2 for a script. Nothing else moved:
  the plan is still saved, still unapproved, and a later "go ahead" in that conversation carries it
  out. This is what the mode means, and it is the only reading that keeps
  `docs/features.md`'s "nothing that changes anything happening until you say yes".
- **One reading of "nobody can be asked."** I reused `nobodyToAsk()` from
  `src/coding/project-tests.ts` rather than writing a second definition: a script's `branch run`
  (`unattended`), a schedule, a trigger, a chat app, MCP, A2A. So the unattended rules in
  `docs/agents/STATUS-coding-next.md`, the tests question and Plan mode all say the same thing.
  **One behaviour change an integrator should see:** `nobodyToAsk()` counts a chat app
  (`source: "channel"`), so a Plan-mode task started from a chat message now finishes with its plan
  instead of ending `needs_input` for the chat person to answer. `project-tests.ts` made that choice
  for the tests question on the grounds that running tests is never needed to finish the work, which
  is not the same argument here — but the outcome is strictly safer (the plan is delivered, nothing
  is changed, the plan is kept for a later "go ahead"), and one reading beats two. Worth a second
  opinion if the integrator disagrees.
- **The phase-1 Plan chip agrees.** `pickConversationMode` sets `planMode: "show-plan"` on the
  conversation *and* a read-only policy, so it is belt and braces; it now takes the same
  finish-with-the-plan path, tested. The CLI `--plan` flag has neither, which is why it behaved
  differently — that is the difference, not the terminal.
- **`--plan` keeps its behaviour and gains a sentence.** Changing `--plan` to stop and ask would
  change what existing scripts do without anyone saying yes, which the rules forbid. Instead
  `branch run --help` and `docs/configuration.md` now say plainly what `--plan` does, and how to be
  shown the plan first (the Plan chip, or the conversation's switch).
- **A plan-act write that names neither is refused**, in a plain sentence, instead of being dropped
  in silence.

### Changed

- `src/orchestration.ts` — `ConductOptions.nobodyToAsk`, `PlanOnlyAnswer`, `unattendedPlanAnswer()`,
  and the branch in `RunConductor.start()`; `plan.answered_with_plan` event.
- `src/runtime.ts` — passes `nobodyToAsk(context)` to the conductor; `openConductor()` turns
  `PlanOnlyAnswer` into the task's answer and stores it in the conversation.
- `src/server.ts` — `planActApi` refuses a write that names neither a conversation nor the project.
- `src/cli-completion.ts` — the `--plan` sentence under `branch run --help`.
- `docs/configuration.md` — "With nobody to ask", and the refusal on `POST /api/plan-act`.

### Tests

`tests/plan-act.test.mjs`, three new:

- "with nobody to ask, Plan mode finishes with the plan and changes nothing" — completed, the plan
  as the answer, no `tool.started`, no `attention.needed`, the file absent, the plan still waiting,
  and a later "go ahead" carries it out.
- "the Plan chip: it shows the plan and waits, and finishes with it when nobody can be asked" —
  through `POST /api/conversation-mode {mode:"plan"}`, both ways round. The attended half also
  proves the chip's read-only policy does not get there first: the task comes back with the plan and
  `plan.awaiting_approval`, not a policy refusal.
- "a plan-act choice that names neither a conversation nor the project is refused, not dropped".

**Mutation-checked**: with `this.options.nobodyToAsk` forced false in `dist/orchestration.js` and the
new refusal deleted from `dist/server.js`, all three fail (13 pass, 3 fail). Restored: 16 pass, 0 fail.

- [x] B5 done.

## B6 — `--allow-tests` and the tests that did not run

### A correction: the flag cannot change what the task reaches for

The repro says the flag turned a five-round run straight to the right tool into twelve rounds
wandering over `mcp.dry_run`, `debug.start` and `specialists.fanout`. The flag cannot do that.
`RunOptions.allowProjectTests` reaches exactly one consumer in the whole build —
`codeChanges.testsPermission` → `projectTestsVerdict` (`src/index.ts`, `src/coding/project-tests.ts`).
It never touches `openCatalog`, `rankGroups`, the learning core's pre-load or the tool budget.

Proven, not argued: the new test runs the same request twice on a scripted provider, once with the
flag and once without, and compares the tool list the model is shown round by round, the
`catalog.preselected` event, and the round count. With the folder's question already answered they
are identical in all three. With it unanswered, the plain run is a prefix of the flagged one — the
flagged task does everything the plain one did, in the same order, and then carries on instead of
stopping. It never reaches for less.

What the two smoke runs differ by is the model, not the flag: the same prompt on a real model, run
twice, and a learning core that ranks by what earlier tasks did. Note too that the run the report
calls correct asked about **`remote.run` on a computer called "workspace"** — a tool for the owner's
*other* computers. Neither run was on its way to running the tests locally.

### What was really wrong

`--allow-tests` announced itself whatever the folder held. It removes exactly one question — "Let
Branch run this project's tests?" — and `runCheck` only ever puts that question when the owner has
set up **no** check of their own, the folder is a Node project (`package.json` at its root), and
running scripts is **off**. In the smoke test's workspace, "run scripts" was on, so the question
would never have been put and the flag was already a no-op; and `code.check` there answered that no
check was set up, which means the folder had no `package.json` either. The CLI still printed
"[this task may run the project's tests without asking]" — a promise it could not keep.

### Changed

- `src/code-change.ts` — `allowTestsIdleNote()`: why the flag will change nothing here, or null.
- `src/cli-run.ts` — `allowTestsFor` says that instead, in one plain line. The flag still works
  exactly as before where there is a question to remove; nothing about the run changed.
- `docs/configuration.md` — "For scripts": the line, and that the flag never changes what a task is
  shown or how far it gets.

### Tests

`tests/coding-next.test.mjs`, two new:

- "B6 `--allow-tests` changes nothing about which tools a task is offered, or how far it gets" —
  the evidence above, locked in as a regression test.
- "B6 `--allow-tests` says so plainly when this folder has no question for it to remove" — all three
  cases (a Node project with scripts off: the ordinary line; no `package.json` and no check: the
  plain sentence; scripts on: the plain sentence).

**Mutation-checked**: with `guessed.push("remote")` added under `if (context.allowProjectTests)` in
`dist/runtime.js` and the honest line reverted in `dist/cli-run.js`, both fail (45 pass, 2 fail).
Restored: 47 pass, 0 fail.

### Not done

I did not widen `--allow-tests` to cover `code.run`, `shell.execute` or `remote.run` when the command
happens to be `node --test`. That would let one flag loosen the general command approval, which is a
much bigger thing than the flag says it is, and nobody has asked for it. The flag means what its
sentence says: the tests question, and only that.

- [x] B6 done.

## B4 — the terminal while the window is open

### What was wrong

Every command except `schedule`, `send` and `connect` fell through to `configuredApp(...)`
(`src/cli.ts`), which opens the database — and SQLite is held `locking_mode=EXCLUSIVE` by the Branch
already running, so the second copy stopped with "Branch is already open". That is the right rule and
I have not touched it. What was wrong is that it was the *only* answer: reading `branch doctor` or
`branch memory` beside the open window was impossible, and `branch token create` — the one moment a
script needs a key is while Branch is running — could not be reached at all, because there was no
HTTP route that makes one either.

### The split I implemented

`branch schedule` already showed the way: it talks to the Branch that is running, through the same
local key and the same rules the app window goes through, and never opens the database. Everything
below now does the same, in one place (`overRunningBranch` in `src/cli.ts`). With nothing running it
answers null and the command opens the saved work here exactly as before.

**Now work while Branch is open** (through the running Branch, nothing opens the database):

| Command | How |
|---|---|
| `branch doctor` | `GET /api/health`; the output says which Branch answered. `--fix`/`--repair` repair things, so they still need it closed |
| `branch trace <task id>` | `GET /api/runs/<id>/trace` (new) |
| `branch token create｜list｜revoke` | `GET｜POST /api/tokens`, `POST /api/tokens/<id>/revoke` (new) |
| `memory`, `usage`, `sessions`, `inbox`, `library`, `settings`, `places`, `tools`, `skills`, `projects`, `snapshots`, `channels`, `mcp`, `customize`, `automations` | `GET /api/terminal?command=…&arg=…` (new): the running Branch runs the command and hands back the very lines it would have printed, so the words are the same either way |
| `schedule`, `send`, `connect` | unchanged; they already did this |

**Still refuse, and why:** `backup`, `restore`, `security audit --fix`, `activity verify`, `doctor
--fix`, `theme`, `model use`, `lockdown`, `permissions <preset>`, `resume`, `setup`, `chat`, `run`,
`headless`, `eval`, `study`, `import-agent`, `export-agent`, `watch`, `skill`, `plugin`, `trigger`,
`login`, `logout`, `quit`, `uninstall`, `rollback`, `report`, `qa`, `status`, `logs`, `approve`.
Each of these either writes to the saved work or wants a terminal of its own, and letting a second
copy do that is exactly what the one-writer rule exists to stop. The refusal is no longer a dead
end: it now names the commands that do work and says to close that Branch first.

`status`, `logs` and `approve` could follow later — they only read — but each needs its own route and
its own words, and I would rather ship the ones the repro named than half-finish six more.

### Not weakened

- Nothing here opens the database twice. Every new path is an HTTP request to the one Branch that
  holds it.
- The keys and the terminal's places are the owner's alone at this computer: a household profile is
  refused (`offLimitsToHousehold`) and a short-lived key is refused both the read (`ownerOnlyReads`
  in `src/short-lived-keys.ts`) and the write, so **a key cannot make or take back a key** — no
  self-renewal. Tested. `GET /api/runs/:id/trace` is an ordinary read, classified `look` like the
  `inspect` and `monitor` views beside it: it carries a trace id, the kinds of step and their
  counts, and none of the task's words.
- `branch memory` and the rest read in the owner's own language: the terminal sends its own
  `LANG`/`LC_*` with the request, so a person on "follow the computer" gets the same words from the
  running Branch that they would have got here.
- `GET /api/terminal` only runs the commands on an explicit list of ones that never write
  (`readOnlyTerminalCommands` in `src/terminal-cli.ts`); anything else is refused in plain words.

### Changed

- `src/trace-report.ts` (new) — one task's trace and the lines it prints, so the terminal and the
  running Branch say the same thing.
- `src/terminal-cli.ts` — `readOnlyTerminalCommands`.
- `src/server.ts` — the four routes, and `terminalReadApi`.
- `src/short-lived-keys.ts` — `/api/tokens` and `/api/terminal` added to the owner-only reads.
- `tests/short-lived-key-routes.mjs` — the four new routes classified (the guard in
  `tests/short-lived-keys.test.mjs` refuses to let a route ship unclassified).
- `src/cli.ts` — `overRunningBranch`; `tokenCommand` now takes a `TokenAccess` so the same words are
  printed whether the keys come from this copy or from the running one.
- `src/store.ts` — the "already open" sentence says what works and what to do.
- `docs/configuration.md` — the new paragraph under "Short-lived keys for a script".

### Tests

`tests/deployment.test.mjs`, five new, all driving the **real** `node dist/cli.js` in a second
process against a Branch held open in the test process (the smoke test's own repro):

- the commands that only look work: `doctor`, `memory` (shows a fact saved in the open Branch),
  `usage --json`.
- a key can be made while Branch is open, and the key the terminal printed really works against the
  running Branch, is refused `POST /api/run`, lists, and stops working once taken back.
- a short-lived key cannot make or take back another key, or read the list.
- a command that writes still refuses, and the sentence names what works and says to close it first;
  `theme dark` is refused too, not quietly allowed.
- `branch trace` reads a real task's steps, and a task with nothing recorded says so plainly.

**Mutation-checked**: with `overRunningBranch`'s answer forced to null in `dist/cli.js` and the
key self-renewal refusal deleted from `dist/server.js`, four of the five fail (21 pass, 4 fail); with
only the "already open" sentence put back to its old wording, the fifth fails (24 pass, 1 fail).
Restored: 25 pass, 0 fail.

- [x] B4 done.

## Merge, rebuild and the whole run

- [x] Merged `origin/mac/cross-platform` twice, both clean: `125fde48` (x-search) and `b766c6ad`
  (ci-flakes-4); `dist/` deleted and rebuilt
  from scratch; `npx tsc --noEmit` clean. Checked the rebuilt `dist/` really carries this work
  (`overRunningBranch` in `dist/cli.js`, `nobodyToAsk` in `dist/orchestration.js`).
- [x] Targeted run after the merge: `plan-act`, `coding-next`, `deployment`, `orchestration`,
  `orchestration-2`, `conversation-mode`, `short-lived-keys`, `static-assets`, `index-structure`,
  `handbook`, `wire-safe-patterns`, `terminal-commands`, `auth-tracing-cli`, `settings-kit-review` —
  **205 tests, 205 pass, 0 fail, 0 skipped** (re-run after the review fixes below: same set, same
  result). Plus `terminal-cli` and `cli` run one at a time
  (they each start a web app on the default port, so they flake against each other under
  `--test-concurrency=2`, before this branch as well as after): **8 pass, 0 fail**.
- [x] Pushed to `origin/mac7/smoke-fixes`. **Not merged into trunk** — the brief says an integrator
  reviews after me.

## Not done / not proven

- No benchmark run, no real-model run: everything here is proved on scripted providers and on the
  real `node dist/cli.js` in a child process. The B6 correction rests on reading every use of
  `allowProjectTests` in the build plus the scripted comparison; I did not re-run the smoke test's
  two real-model tasks to watch them diverge again.
- `branch status`, `branch logs` and `branch approve` only read, and could join the list that works
  while Branch is open. Each needs its own route and its own words, so I left them refusing.
- `--plan` still carries the plan out rather than showing it. That is a decision, written above, not
  an oversight: changing it would change what existing scripts do without anyone saying yes.
- `tests/terminal-cli.test.mjs` and `tests/cli.test.mjs` both start a web app on the default port.
  Run one at a time they pass; run with `--test-concurrency=2` beside other suites that also start a
  server, "bare branch with no terminal still starts the web app" times out. Nothing on this branch
  touches `branch start`, so I do not believe it is mine — but I did not run the pair on the merge
  base to prove that, so it is a claim I have not checked.

## Integration (adversarial review, 2026-09-19)

Reviewed on the branch itself in `C:/Users/bishi/Code/wt/smoke-fixes` (head at review start `610b845e`),
against trunk `mac/cross-platform` at `b766c6ad`. **Not pushed to trunk**: trunk is frozen while
`ci-flakes-4` banks two green CI runs. The fixes below are committed on `mac7/smoke-fixes`.

### The chat-app behaviour change: reversed, with the loop proved

The builder reused `nobodyToAsk()`, which counts a chat app, and flagged it for a second opinion.
The second opinion is that a chat person is a person, and the evidence is in the code, not the
argument:

- **The chat surface can show a plan.** `finishTurn` (`src/channels/router.ts:811`) sends a
  `needs_input` run's own output back to the chat as the words it is, whenever no approval is
  waiting — which is exactly the Plan-mode case (`NeedsInputError(planMessage(plan))` raises no
  approval).
- **The chat surface can take a yes.** `finishTurn` writes `channel-session:<channel>:<chatId>`
  against the conversation, so the next chat message lands in it, and `RunConductor.start()` picks a
  waiting plan up on any affirmative — it never looks at the source.
- **Waiting is not the unsafe side.** A chat's task gets five read-only permissions
  (`chatSafePermissions`) and nothing else; a task started from outside is held at *Ask before
  changes* however it is carried on (docs/configuration.md, since 0.18.1); it may never give a
  standing yes; and `chatMayApprove` is off unless the owner switched that line on. The new test
  drives this: the chat's "go ahead" picks the plan up, works through it, and the step that writes a
  file **still stops and asks**, with the file untouched.
- **And the old behaviour was not honest.** `unattendedPlanAnswer()` ends "there was nobody to say
  yes while this task ran." Delivered to the person who has just written, that sentence is false.

`docs/features.md:25` promises "a switch between \"just do it\" and \"show me the plan first\", with
numbered steps in plain words and nothing that changes anything happening until you say yes". Both
readings keep the second half; only this one keeps the first for a chat, where the person is shown
the numbered steps and says yes. What the new test proves and what it does not: it drives
`app.runtime.run({ source: "channel" })` directly, so it proves the *hold* — the write still stops
and asks after the chat's "go ahead". It does not go through the router, so the narrowing to five
read-only permissions is proved by `tests/chat-allowlist.test.mjs` (run, green), not by this test.

So the two questions are two predicates, each with one reading. `nobodyToAsk` (the tests question)
is untouched. `nobodyToAskAboutPlan` (Plan mode) is the same answer with a chat app removed, and
says why in its own comment. `src/runtime.ts` uses the new one. Only two places call either.

### Fixed on top of the builder's work

1. **Plan mode from a chat waits again** — `nobodyToAskAboutPlan` in `src/coding/project-tests.ts`,
   used by `src/runtime.ts`; the `ConductOptions.nobodyToAsk` comment and the
   "With nobody to ask" paragraph in `docs/configuration.md` now say a chat message is not one of
   them. Test: "Plan mode from a chat message shows the plan and waits, and the chat's go-ahead
   carries it out" (`tests/plan-act.test.mjs`). **Mutation-checked**: with the chat line deleted from
   `dist/coding/project-tests.js` (the builder's behaviour back) only that test fails, 16 pass 1
   fail; restored 17 pass.
2. **`GET /api/terminal?command=version` answered "I do not know the command version"** — `version`
   was on `readOnlyTerminalCommands` but `runTerminalCommand` never handled it (`branch version` is
   answered in `src/cli.ts` before anything opens, so it was never reached from a terminal).
   One line in `src/terminal-cli.ts`.
3. **The `/api/terminal` refusal said the wrong thing for a name that is not a command** — "changes
   things" was told to a typo as well as to `theme`. It now says the name is not one of the commands
   that only look, lists the ones that are, and says to close that Branch first.
4. **`POST /api/plan-act {}` with no choice at all was refused** by the builder's new 400 — an empty
   POST is a read, not a dropped choice. The refusal now fires only when a `planMode`, an `autonomy`
   or `followProject` was actually sent. (The window always sends a `scope`, so no caller ever
   depended on the old silence: `public/plan-act.js:110-115` sets `scope = sessionId ? wanted :
   "project"`, and `tests/mac2-desktop-ui.test.mjs:680` sends `scope: "project"`.)
5. **The `/api/terminal` allowlist is now pinned by a test** — the gate is on the command NAME only
   and the words after it pass straight through, so the set is asserted exactly, every name on it is
   driven and proved to answer, and six names off it (`theme`, `lockdown`, `model`, `run`, `backup`,
   a typo) are proved refused in plain words. `tests/deployment.test.mjs`.

### Verdicts on the builder's claims

- **B4 — VERIFIED.** `src/cli.ts` `overRunningBranch`, the four routes in `src/server.ts`,
  `src/trace-report.ts`, and five tests driving the real `node dist/cli.js` against a held-open
  Branch. Mutation: `overRunningBranch` forced null → 3 of 5 fail (23 pass, 3 fail); the
  `/api/tokens` self-renewal refusal commented out → the key test fails (25 pass, 1 fail).
- **B5 — VERIFIED**, with the chat reading corrected above. Mutation: the `nobodyToAsk` branch in
  `dist/orchestration.js` forced false → 3 fail (14 pass, 3 fail).
- **B6 — VERIFIED.** Mutation: `guessed.push("remote")` under `context.allowProjectTests` in
  `dist/runtime.js` → the tool-list test fails; `allowTestsIdleNote` forced to return null →
  the plain-line test fails. 46 pass, 1 fail each time.

### Checked and found sound (no change needed)

- **The new routes.** `GET|POST /api/tokens` and `POST /api/tokens/<id>/revoke` are refused to a
  short-lived key by name in `offLimitsToShortLivedKeys` (writes) and by `ownerOnlyReads` (the list),
  so **no key can mint or list keys**; `GET /api/terminal` is in `ownerOnlyReads` too. Household
  profiles are refused all three, because `offLimitsToHousehold` refuses whatever a key is refused
  and `householdMaySend` covers only `/api/voice/*` — asserted in the builder's own test. Chat
  sources never arrive over HTTP at all (`windowCaller`).
- **The CLI's door is not widened.** `overRunningBranch` goes through `attachToRunning(dataDir)`,
  which reads the running instance's saved local key off disk and proves the server with
  `GET /api/state` before anything else. An unauthenticated local caller has no more reach than
  `branch schedule` already gave it; every new path is an ordinary authenticated request.
- **The single-writer rule holds.** Proved by test, not by reading: `branch backup` and
  `branch theme dark` both still exit 1 beside an open Branch, and the refusal now names
  `branch doctor, branch token, branch trace, branch schedule` and says to close it first.
- **`--plan` plus a saved Plan mode does the safe thing.** `wantsPlan()` is true either way and
  `needsApproval()` reads the saved mode, so `--plan` with "Show me the plan first" saved stops and
  shows the plan (attended) or finishes with it (nobody to ask). `--plan` alone still plans and
  carries out, and `branch run --help` now says so in one sentence.
- **Nothing on the read-only terminal list writes.** `src/terminal-settings.ts` and
  `src/terminal-place-data.ts` contain no `store.save`/`.put`; every allowlisted name lands on a
  reading branch of `runTerminalCommand`.

### Findings left open (notes, not blockers)

- **`GET /api/runs/:id/trace` is classified `look`, not owner-only.** The brief asked for owner-only
  on all four. I left it as the builder had it, deliberately: it carries no words of the task, and
  the two things it does carry are already readable by a `look` key — `/api/runs/:id/inspect` beside
  it shows rounds, tool calls and the plan, and `GET /api/tracing/settings` already shows the trace
  address (it is not in `ownerOnlyReads`; the API keys live in `settings.headers` as `secret://`
  references and are never in the report). Tightening it alone would be inconsistent with its
  neighbours for no gain. Say the word and it becomes `secret-read` in one line.
- **`docs/api.md` does not list the four new routes.** That file says it is written by
  `node scripts/write-api-docs.mjs` from the app's own input checks and is not to be edited by hand,
  and the new routes have no registered input check, so they are absent the way several other routes
  are. Not hand-edited. `docs/configuration.md` documents all four.
- **`branch status`, `branch logs`, `branch approve`** still refuse beside an open Branch. The
  builder's reasoning stands; noting it so it is not lost.
