# Status: mac7/coding-next (coding reliability, round 2)

Builder: Claude (Legion). Worktree `C:/Users/bishi/Code/wt/coding-next`, branch `mac7/coding-next`, cut
from trunk 8bcfec20. Not merged into trunk: an adversarial integrator reviews after this.

Order worked: 5, 6, 3, 2, 1, 4 (2 before 1 because both touch `runtime.callTool`).

- [x] 5. `code.run` (and every other `process.execPath` spawn) runs as Node inside the desktop app
- [x] 6. Crash capture switchable, ships off (engine crash notes + Electron crash reporter)
- [ ] 3. Longer first-reply wait for local models, with a status line
- [ ] 2. Unknown tool arguments dropped (not refused), the model told; permission check sees cleaned arguments
- [ ] 1. Read before edit
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
