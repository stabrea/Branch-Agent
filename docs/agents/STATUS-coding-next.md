# Status: mac7/coding-next (coding reliability, round 2)

Builder: Claude (Legion). Worktree `C:/Users/bishi/Code/wt/coding-next`, branch `mac7/coding-next`, cut
from trunk 8bcfec20. Not merged into trunk: an adversarial integrator reviews after this.

Order worked: 5, 6, 3, 2, 1, 4 (2 before 1 because both touch `runtime.callTool`).

- [x] 5. `code.run` (and every other `process.execPath` spawn) runs as Node inside the desktop app
- [x] 6. Crash capture switchable, ships off (engine crash notes + Electron crash reporter)
- [x] 3. Longer first-reply wait for local models, with a status line
- [x] 2. Unknown tool arguments dropped (not refused), the model told; permission check sees cleaned arguments
- [x] 1. Read before edit
- [ ] 4. "Let Branch run this project's tests?" asked once per folder
- [ ] Merge latest `origin/mac/cross-platform`, rebuild, retest, push

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
- The task's own writes: `CodeEditor.save` and `files.write` note the file; `ToolRegistry.execute` calls
  `afterWrites` in a `finally` after the tool and after `afterTool` (format-on-edit), which re-fingerprints
  those files as they are on disk. So a formatter's tidying never makes the next edit look like an outside change.
- Forgotten on `finishRun`; at most 500 tasks kept. Tasks with no run id (routes, "Try a tool") are not held.
- Tests: `tests/coding-next.test.mjs` "1 …": off by default (edit goes through); on: unread refused for all four
  kinds of change, nothing written; read then edit, own second edit and a whole-file write allowed; an outside
  change after the read refused, then allowed after reading again; new files (write, empty-find edit, Add
  File patch) allowed; a formatter rewriting the file after the task's edit does not refuse the next edit.
