# Status: mac7/coding-next (coding reliability, round 2)

Builder: Claude (Legion). Worktree `C:/Users/bishi/Code/wt/coding-next`, branch `mac7/coding-next`, cut
from trunk 8bcfec20. Not merged into trunk: an adversarial integrator reviews after this.

Order worked: 5, 6, 3, 2, 1, 4 (2 before 1 because both touch `runtime.callTool`).

- [x] 5. `code.run` (and every other `process.execPath` spawn) runs as Node inside the desktop app
- [x] 6. Crash capture switchable, ships off (engine crash notes + Electron crash reporter)
- [x] 3. Longer first-reply wait for local models, with a status line
- [x] 2. Unknown tool arguments dropped (not refused), the model told; permission check sees cleaned arguments
- [x] 1. Read before edit
- [x] 4. "Let Branch run this project's tests?" asked once per folder
- [x] Merge latest `origin/mac/cross-platform`, rebuild, retest, push (trunk 81f9e022 merged as 2f4e8a73)

## Notes for the integrator

(filled in as each item lands)

### 5. ELECTRON_RUN_AS_NODE
One helper, `runAsNode(executable)` in `src/child-env.ts`: `{ ELECTRON_RUN_AS_NODE: "1" }` only when the
program is `process.execPath` and this is the desktop app (`process.versions.electron`), else nothing
(a plain-Node child keeps a clean environment, so an Electron project's own tests are not changed).
Every place that starts `process.execPath` to run JavaScript, and what was done:
- `src/sandbox-backends.ts` JobObjectBackend (this is `code.run` on this computer, and `process.start`
  through the same `argvFor`): **was missing, fixed**. Also the Linux wall's door bridge and the probe.
- `src/code-edit.ts` `files.validate` (`node --check`): **was missing, fixed** (a second instance of the bug).
- `src/integrations/mcp-config.ts` stdio servers: **was missing, fixed** (the example notes server is
  started with `process.execPath`; in the app it opened a second app).
- `src/never-break/api.ts` (gateway self-test) and `src/never-break/gateway.ts` (worker spawn): **fixed**
  (the self-test route runs inside the app's engine; the gateway normally inherits the variable from
  its launcher, now it does not depend on that).
- `src/benchmark-adapters.ts` code benchmarks: **fixed** through `runBenchmarkCommand`'s `env`.
- `src/code-change.ts` (`code.check` stand-in): already set; now uses the helper.
- Already right, left as they were: `code-syntax.ts`, `add-ons/walled-plugin.ts`, `safety-extras/tool-scripts.ts`,
  `add-ons/export.ts`, `server.ts` mcp-serve line, `never-break/canary.ts`, the installers.
- Not a JavaScript run: `cli.ts` daemon (the launcher sets the variable), `desktop/main.ts` (paths only),
  `prompt-examples.ts` (builds a config; the spawn is mcp-config above).
Tests: `tests/coding-next.test.mjs` "5 …" — the helper, and `code.run` with a stubbed spawner under a faked
`process.versions.electron` checks the environment handed to the spawn.

### 6. Crash capture switch
- Setting: `crashCapture: "off" | "on"` in `settings/diagnostic-log` (ships off), a *Keep crash notes*
  select on the Activity log card (en + fr), documented in `docs/configuration.md` (Activity log section).
- Engine: `DiagnosticLog.crash()` writes `crashes.jsonl` only when on. The one-line "Crashed:" entry is an
  ordinary log line and still follows the *log's* switch (split kept on purpose). `src/tracing.ts` still
  records a crash in the task record as it did before mac7/diagnostics (that is not a crash file; untouched).
- Desktop: `crashReporter.start` moved from module top level into `start()`, right after the data folder is
  known, and runs only when `crashReporterPlan(dataDir)` says on. It reads `<data>/logs/crash-capture.json`,
  which the engine writes on every save of the setting and once at engine start, so the desktop can know
  before the database opens. A change applies to Electron's crash files at the next start (the setting's
  help text says so). `BRANCH_CRASH_DUMPS` is set only when the reporter started; Report a problem already
  treats a missing folder as "no crash files" (tested).
- Fixed on the way: `saveDiagnosticLogSettings` laid zod 4 `.partial()` defaults over the saved record, so
  saving the log's mode silently reset `maxMegabytes` (and would have reset `crashCapture`). Only sent
  fields are applied now (tested).
- Tests: `tests/coding-next.test.mjs` "6 …" (off writes nothing; on writes; saving mode keeps the switch; the
  switch file and `crashReporterPlan`; Report a problem with it off); D7/D17 in `tests/diagnostics-log.test.mjs`
  now switch crash capture on, since they test a crash note's content.
- Not tested: the Electron call itself (cannot run Electron here); `startCrashReporter` is 8 lines around
  `crashReporterPlan`, which is tested.
- Trade-off of the move: with the switch on, a crash of the desktop process between launch and the data folder
  being known (the few awaits before `start()` reads the switch) is not captured by Electron's reporter. Before
  any window or the engine exists; the brief's "read at desktop start" needs the data folder first.

### 3. Local model first reply
- Local = `presetRunsLocally` (src/models.ts), the app's existing test: the connection's own address is
  `localhost`/`127.0.0.1`/`::1`. That covers Ollama (OllamaProvider), LM Studio and llama.cpp (OpenAI-shaped
  at loopback). A model served from another machine on the network is treated as hosted, as everywhere else.
- `withStallWatchdog` takes an optional `{ firstMs, quiet }`: the first silence may last `firstMs`; after the
  first piece the ordinary `modelStallMs` runs. Applied per model call (each reply's first word), since a
  local model can be unloaded between rounds (Ollama's keep-alive).
- Setting: launch `reliability.localFirstReplyMs` (default 300 s) and the owner's knob
  `localFirstReplySeconds` (limits card, Settings › Advanced, next to API retries; empty = launch figure).
  Hosted connections are unchanged (60 s). Documented in docs/configuration.md (reliability paragraph and knobs table).
- `src/activity.ts` still reports "Thinking" while the last event is `model.loading` (it only looked for
  `model.started`). Other consumers pair `model.started`/`model.completed` and ignore the new kind.
- Status line: after 10 s of silence (or the stall time, if shorter) on a local connection, one `model.loading`
  event; the live row shows "Waiting for the model on this computer to start. It may be loading into memory…"
  (en + fr key `live.localLoading`), and the activity feed lists it. Chose a new event kind over a field on
  `model.started` because a status on `model.started` would say "loading" on every local round, warm or not;
  consumers that do not know the kind ignore it.
- Deviation from "ships off": this changes the default wait for local connections (as the brief decided).
- Tests: `tests/coding-next.test.mjs` "3 …" with a real slow HTTP server on 127.0.0.1 (completes inside the
  longer window with one `model.loading`; stalls when the window is shorter), a hosted fake that still stalls
  at the ordinary time with no `model.loading`, the watchdog unit, and the knob. `tests/hidden-knobs.test.mjs`
  defaults updated for the new field.
- Seen once: `tests/empty-completion-adversarial.test.mjs` failed at file level (no subtest failed) under
  `--test-concurrency=2`; passed alone and twice more concurrently. Looks like a teardown flake, not this change.

### 2. Extra tool arguments
- `ToolRegistry.clean(name, args)` (src/registry.ts): parses with the tool's own schema; if every issue is
  `unrecognized_keys`, removes exactly those keys (nested ones too, e.g. `edits.0.line`) and parses again
  (at most 3 rounds). It returns cleaned arguments only when they now parse; a wrong type or a missing field
  leaves the arguments exactly as sent, so the call is refused as before. Works through `files.edit`'s
  preprocess wrapper (its alias names are mapped first, then unknown keys reported).
- `Runtime.callTool` cleans immediately after `JSON.parse`, before anything else looks at the call, and hands
  the cleaned arguments to all of it: the file note, the policy check and approval (`gate`/`checkPolicy`,
  `targetOf`, `describeToolCall`), the wall, the tool, the troubleshooter. The body that used to be
  `callTool` is now `runToolCall(call, context, args, validArgs)`, unchanged apart from taking `args`.
- Deliberately NOT changed: the approval fingerprint and the bytes shown on the approval card are still those
  of the exact request sent (`call.arguments`). That can only make a yes narrower (the same call without the
  junk is asked about again), never wider, and keeps the replay/journal semantics as they were.
- The model is told in one line, as a sibling of `result` in the envelope (so signed receipts do not change):
  `note: "Ignored an argument this tool does not take: format."`; event `tool.arguments_ignored` lists the keys.
- No switch: precedent is the merged coding-gap fixes (whitespace-tolerant edits, patch placement, alias
  names), which shipped unswitched as refusal-quality fixes. It never runs anything the call did not ask for.
- Scope: model calls through `callTool` only. `executeTool` (routes, "Try a tool", tools.script) and the MCP
  server that exposes Branch's tools to other agents still refuse unknown keys.
- Tests: `tests/coding-next.test.mjs` "2 …": clean() cases (dropped, untouched, wrong type, missing field,
  nested, files.edit aliases); a real run with an extra key succeeds with the note; a wrong type is still
  refused; and a deny rule for `keep.txt` still fires when the model adds a `url` that would have made the raw
  call's target a different host (policyTarget reads `url` before `path`).

### 1. Read before edit
- **Ships OFF.** The brief allowed default-on for coding tasks only if precedent says safety guards like this
  default on. It does not: every top-level coding and safety switch defaults off, and
  `src/safety-extras/settings.ts` says it outright ("every one ships off, the scans that can only tighten
  included (no owner design asks for them to start on)"). The only `default(true)` values found are sub-fields
  inside features that are themselves off (`format-on-edit.diagnostics`, `notebooks.outputs`,
  `code-approvals.releaseNeedsCode`).
- Setting: a twelfth coding part, `read-first` (`settings/coding-read-first`, off / when needed / on; both
  non-off modes hold every task). It appears on the Coding card by itself (public/coding.js, en + fr), `POST
  /api/coding/switch` like the others, and is documented in the Coding polish table of docs/configuration.md.
- `src/coding/read-first.ts` `ReadFirstGuard`: per task (run id) a sha256 of the text `files.read` returned,
  path keyed by full address (lower-cased on Windows). `require()` reads the file now: missing -> new file,
  allowed; no record -> "read it with files.read first"; different fingerprint -> "has changed since this task
  last read it". A content fingerprint rather than mtime/size, so a change within the same second or of the
  same size is still caught, and a touch with no change is not.
- Held: `files.write`, `files.edit`, `files.patch`, `code.patch`, `code.change_set` (checked for every file before
  any file is written; change_set checks before looking for the text, so "read it first" is the refusal a
  blind edit gets). Not held: `code.rename` (language server, via `applyPlanned`), `code.format`,
  `files.restore`, undo/redo, documents.* — they are not the model writing from what it thinks a file says.
- Known interaction, on purpose: `files.restore` and `workspace.undo`/`redo` write through the history, not
  through the guard, so after them the next edit of those files asks for a fresh read (the task does not know
  exactly what came back). The refusal says only "has changed since this task last read it", not who changed
  it. `code.format` (by hand or after an edit) notes the files it tidied, so it does not cause a refusal.
- The task's own writes: `CodeEditor.save` and `files.write` note the file; `ToolRegistry.execute` calls
  `afterWrites` in a `finally` after the tool and after `afterTool` (format-on-edit), which re-fingerprints
  those files as they are on disk. So a formatter's tidying never makes the next edit look like an outside change.
- Forgotten on `finishRun`; at most 500 tasks kept. Tasks with no run id (routes, "Try a tool") are not held.
- Tests: `tests/coding-next.test.mjs` "1 …": off by default (edit goes through); on: unread refused for all four
  kinds of change, nothing written; read then edit, own second edit and a whole-file write allowed; an outside
  change after the read refused, then allowed after reading again; new files (write, empty-find edit, Add
  File patch) allowed; a formatter rewriting the file after the task's edit does not refuse the next edit.

### 4. "Let Branch run this project's tests?"
- Where: `code.check`'s stand-in (`node --test` in the workspace, only when no check is configured and the
  folder has a package.json). That is the only path that runs a project's tests without the owner having
  named the program; an owner-configured check is the owner's own yes and is not asked about. After
  `code.patch`/`code.change_set` nothing but the configured check runs (unchanged).
- With the script switch (`code-run.enabled`) on, the stand-in runs as before without asking (that owner
  already said yes to running scripts; not changing behaviour for them). Off, as shipped: `CodeChanges.testsRefusal`
  asks `projectTestsVerdict` (src/coding/project-tests.ts), wired in src/index.ts through the runtime's approvals.
- The question is an ordinary approval: `ApprovalRequiredError("code.tests", <workspace folder>, …, "always")`
  thrown from the tool; `Runtime.callTool`'s existing catch puts it with `askApproval` (pending list,
  `policy.ask` event, the app's question card, chat apps). Two optional fields ride along: `question`
  ("Let Branch run this project's tests? It would run node --test in <folder>.") and `kind: "project-tests"`,
  which the two question cards (public/live-run.js, public/approvals.js) use to show **Always for this folder /
  Once / No** instead of the usual four (en + fr keys `live.testsAlways`, `live.testsOnce`).
- Answers: Always = `approve(..., "always")` → the existing `addPolicyRule({ tool: "code.tests", match: folder })`,
  so it is stored and revocable like any rule; Once = a single pass (`ApprovalGate.grantOnce/takeOnce`, cleared
  by Lock and when the conversation is forgotten) — needed because the existing "Yes, just now" records nothing;
  No = remembered for the conversation, and the model is told to work from the test files.
- Only an exact `code.tests` rule for this folder counts; a broad allow rule (e.g. a "Full access" preset) does
  not stand in for the yes. Owner-only Always: refused when answered from a chat app (`answeredOn`), for a task
  a chat app or anything but the owner started (existing check), for a household person's task, or while the
  window is switched to a household profile. Lockdown: `code.check` is refused by the existing Lockdown rule for
  `code.execute` without asking (tested). The Lockdown line in `projectTestsVerdict` is belt-and-braces for any
  future caller that is not a `code.execute` tool; it is the same refusal text, not a second rule.
- New `ToolContext.askable`: set on a model's own tool call (`runToolCall`). A tool run by hand ("Try a tool",
  manual actions) has nowhere to put the question, so there `code.check` answers with the old "no check is set
  up" note, as before (existing coding-gap test unchanged). Workflow steps (`approvalKey`) are asked, as the
  existing ApprovalRequiredError design intends.
- **Per permission mode, for whoever wires `mac7/redesign-phase1`'s picker** (no picker built here):
  - *Plan*: never run. A dry run (`context.dryRun`) simulates `code.check` today, since it is not read-only; the
    picker's Plan mode must map to dryRun, or call `projectTestsVerdict` and refuse. Not tested here.
  - *Ask first*: ask (this behaviour).
  - *Auto* and *Full access*: still ask once per folder unless "Always for this folder" was given. The verdict
    reads only the exact `code.tests` rule, so a mode that works by adding broad allow rules will not skip it;
    a mode implemented some other way must not bypass `projectTestsVerdict`.
- Tests: `tests/coding-next.test.mjs` "4 …": nothing runs before the answer; the question's kind, tool, folder
  and words; Once runs the next call and then asks again; Always writes the folder rule and a new conversation
  runs without asking; No is remembered and the model gets the note; Always refused from a chat app and for a
  chat-started task (Once still works, no rule written); Lockdown refuses without asking; script switch on runs
  as before. These run a real `node --test` on a one-test temp project (no window).

### Merge with trunk 81f9e022
- One conflict, `src/diagnostic-log.ts` `crash()`: trunk's e1c540b8 (a crash after the database closes must
  not throw) against item 6's switch. Kept both: the switch is read through `capturesCrashes()`, which falls
  back to the switch file in the log folder when the settings cannot be read, and the log line keeps trunk's
  `try`. Trunk's D20 asserted a crash note is always written; updated for the switch (off: none; on: written
  without the database).
- Clean `dist/` rebuild; checked `localFirstReplyMs`, `askable`, `capturesCrashes` are in `dist/`.
- Tests on the merged tree: 33 files with `--test-concurrency=2` — 426 tests, 419 pass, 0 fail, 7 skipped
  (platform skips), incl. static-assets, index-structure, handbook, source-hygiene, catalog-diet;
  `tests/automation.test.mjs` alone 5/5. `npx tsc --noEmit` clean.

- After the merge (trunk had not moved again), review fixes in 1f9ea91a: `code.format` notes the files it
  tidied for the read-first guard (new test), the refusal no longer guesses who changed a file, and
  `src/activity.ts` treats `model.loading` as the model's turn. Re-run: coding-next, coding-polish,
  coding-polish-holes, interop, reach, handbook, static-assets, index-structure, source-hygiene — 89 tests,
  88 pass, 0 fail, 1 skipped; tsc clean.

## Integration (adversarial review, Claude, 2026-09-19)

Reviewed 2a773919 against trunk 81f9e022; fixes in 5ba94e15. Verdict: **MERGE WITH FIXES** (applied).

Fixed (each with a test in `tests/coding-next.test.mjs` "review …"; every review test was checked to fail with its fix
removed, by editing `dist/`, and so were the builder's item-2 and item-4 owner-only tests):
- [x] **4, should have blocked:** the question was thrown with `remember: "always"`, which is the *default* answer
  wherever no choice is made. Carrying a waiting workflow on (`POST /api/workflows/:id/resume` with no `remember`,
  the documented "just this workflow" default) and a flow's approve wrote the standing `code.tests` rule, and the
  terminal chat's plain `y` did too. Now `"never"` (a plain yes is Once), and `Runtime.grantApproval` treats
  `code.tests` like the card: Always goes through the same owner-only check, Once is a single pass for that workflow.
- [x] **2:** a dropped key could change meaning: `code.patch` with `dry_run: true` was applied for real, and the
  approval card and the second-model reviewer showed the raw bytes (a person could say yes to what reads as a dry
  run). Now a key that respells a declared one (`dry_run`, `replace_all`) or asks for nothing to really happen
  (`preview`, `simulate`, `whatIf`, `noop`, `checkOnly`, `validateOnly`) is not dropped — the call is refused as
  before; and the card/reviewer see the call as it will run. The fingerprint stays that of the bytes sent.
- [x] **5:** `runSweTests` in `src/benchmark-adapters.ts` still started `process.execPath` without the variable. Fixed;
  a source scan test now fails on any start of this program without `runAsNode`/`ELECTRON_RUN_AS_NODE` nearby.
- [x] **1:** with the switch off, `files.write` and the editor still resolved the path through `checked()` before
  the guard said "off", which could change which refusal a bad path got. Now `ReadFirstGuard.holds()` is asked
  first and nothing else runs while off.
- [x] **6:** a damaged/odd switch file (`{not json`, `"yes"`, a bare string, empty) means off, and a crash with the
  database closed still never throws (tested). The desktop doc comment for the crash watcher was moved back onto it.
- [x] **Plan (dry run):** `code.check` in a dry run is simulated by the gate — no question, no tests (tested).

Per item: 1 VERIFIED, 2 VERIFIED (after fix), 3 VERIFIED, 4 VERIFIED (after fix), 5 VERIFIED (after fix), 6 VERIFIED
(the Electron `crashReporter.start` call itself is untested; nothing else depends on it starting before `start()`:
`BRANCH_CRASH_DUMPS` is set before the engine or any window exists).

Checked and fine: MCP and client tools use `z.record` parameters, so `clean()` never touches them (the outside
server judges its own arguments). `files.read` has no range, so a partial read cannot unlock an edit; editing
tools share its 32 KiB cap. `checked()` refuses `..`, absolute paths, `\`, `:` and links before the guard sees a
path, and both sides key on `resolve(base, path)`. Owner-only Always: short-lived keys are refused by the route,
chat apps by `answeredOn`, household tasks/profiles by the builder's check (tested). A task nobody watches stops on
the question (`needs_input`) like any other.

Notes, not fixed (judgement calls, fail closed or pre-existing):
- A hung local model now ends after up to 3 x 300 s (two stall retries by default) instead of 3 x 60 s; the message
  is the ordinary "No response for 300 seconds", with "may be loading into memory" shown meanwhile.
- The loop guard compares raw argument bytes, so a model varying a junk key each round is seen as not repeating.
- `code.rename` and other changes through `applyPlanned` are not held but still count as reads afterwards.
- Read-set: at most 500 tasks, evicted oldest-first, so a very long task can be asked to read again; short
  (8.3) names or different letter case on macOS key differently and ask for a read (fail closed).
- On purpose, fail closed: `meantSomething` compares with property names anywhere in the tool's schema, so a stray
  top-level `path` on `code.change_set` (which has `path` inside each edit) is refused rather than dropped.
- In `grantApproval` (workflows, flows) there is no task to look up, so the owner-only Always rests on the
  existing `source !== "owner"` refusal and `store.profiles.isOwner()`; the workflow routes are owner-only too.
- Pre-existing, not this branch: a tool whose schema is not `.strict()` strips extra keys silently, while
  `policyTarget` still reads the raw `url`/`path`.

## Follow-up: mac7/tests-unattended (2026-09-19)

The tests question ended every unattended task (`branch run` from a script, the coding bench) with
`needs_input` after 1–2 model calls. Now, when nobody can answer, `code.check` skips the project's tests
with one plain line and the task carries on.

- [x] "Nobody can answer" = `ToolContext.unattended` (new; set by `branch run` when stdin/stdout are not a
  terminal — the same `looksInteractive` test `branch` itself uses — and always by
  `branch headless`) or a task started by a schedule, trigger, chat app, MCP or A2A (`nobodyToAsk` in
  `src/coding/project-tests.ts`). The app window, `branch chat`, `branch run` typed in a terminal and an
  editor over ACP (which has its own answer loop) are still asked, exactly as before.
- [x] Skip path: in `CodeChanges.testsRefusal`, only after the verdict says "ask" (Lockdown and a No keep
  their own answers); returns `testsSkippedNote(folder)` before anything is started. Nothing is saved or
  remembered.
- [x] Outside-started work: CHANGES still wait for the owner (`cappedPolicy`, 0.18.1) — `code.check` itself
  is asked for such a task first; only the tests question after that yes is skipped instead of waiting.
  Chat apps are skipped as the brief decided, although a chat person could answer Once before.
- [x] `branch run --allow-tests` (and `branch headless --allow-tests`): `RunOptions.allowProjectTests`, for
  that one task (every `code.check` in it, and its own specialists), never saved; the CLI refuses it under
  Lockdown, in a household profile and under a short-lived key; the runtime re-checks (owner source, no
  short-lived key/household person/chat along the recorded origin, Lockdown). A standing or conversation No
  still wins; a Once is not used up. Not in `RunInputSchema` (strict), so it cannot come in over HTTP.
- [x] Help: `branch run --help` / `branch headless --help` list it with a sentence (`notes` on the command
  entry). Docs: `docs/configuration.md` "For scripts" and "The project's check".
- [x] Tests: `tests/coding-next.test.mjs` "unattended: …", "--allow-tests …", "the real branch run …" (the
  last two start the real CLI in a child process against a model on 127.0.0.1; `FORCE_TTY=1` stands in
  for a terminal). Mutation-checked by editing `dist/`: the unattended skip, the flag's verdict line.
- [x] Targeted run on this branch (before merge): 14 files, 216 tests, 213 pass, 0 fail, 3 skipped.

## Not done / not proven
- No benchmark re-run (as instructed); none of these has been measured on the coding bench.
- Electron itself was not run: `crashReporter.start` placement and `ELECTRON_RUN_AS_NODE` are tested through
  stubs (faked `process.versions.electron`, a stubbed spawner, `crashReporterPlan`).
- Read-before-edit ships off, so it changes nothing until the owner switches it on.
