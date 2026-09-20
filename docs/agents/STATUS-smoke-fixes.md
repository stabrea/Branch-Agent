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
- "the Plan chip behaves the same way when nobody can be asked" — through
  `POST /api/conversation-mode {mode:"plan"}`.
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

- [ ] not started
