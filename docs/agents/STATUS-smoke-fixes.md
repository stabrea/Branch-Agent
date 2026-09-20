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

- [ ] in progress

## B4 — the terminal while the window is open

- [ ] not started
