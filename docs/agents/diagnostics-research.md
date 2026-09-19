# Diagnostics & crash reporting research — for "Report a problem" + Activity log

Research on how well-known apps handle diagnostics, crash reports, and issue reporting, done to design Branch Agent's "Report a problem" feature and local activity log. Branch Agent is an Electron + Node local AI agent app; the owner is non-technical, so the design favors plain words over jargon.

## Claude Code

- `/doctor` runs a static, read-only checkup of installation and settings (invalid settings files, unused extensions, duplicate subagent names) and proposes fixes; `claude doctor` from the terminal prints the same diagnostics without starting a session.
- `/debug [issue]` turns on debug logging for the session and has Claude read the log to diagnose a live problem; `claude --debug` (optionally scoped, e.g. `--debug=mcp`) writes verbose output to `~/.claude/debug/<session-id>.txt`.
- `/bug [report]` (alias `/share`) lets the user choose how much session history to include and shows a **consent screen before anything is sent**; without a first-party connection it writes a local archive under `~/.claude/feedback-bundles/` that the user forwards themselves instead of auto-uploading.
- `/context`, `/status`, `/hooks`, `/mcp` give layered visibility (what loaded, which settings source won, hook matches, server connection state) rather than one giant dump.
- Source: [Debug your configuration](https://code.claude.com/docs/en/debug-your-config), [Commands reference (/bug)](https://code.claude.com/docs/en/commands)

## OpenAI Codex CLI

- `RUST_LOG` controls verbosity (`error|warn|info|debug|trace`, or targeted filters like `codex_core=debug,codex_tui=debug`); plaintext logging to a file is opt-in via `log_dir`, e.g. `RUST_LOG=debug codex -c log_dir=./.codex-log`.
- Default runtime log, when enabled, lives at `~/.codex/log/codex-tui.log`; a `doctor`-style command reports the running binary, loaded config, auth status, network path, and actual log/state locations.
- Logs rotate automatically and old files are safe to delete — bounded local storage by default rather than unbounded growth.
- Source: [Codex environment variables](https://developers.openai.com/codex/environment-variables)

## VS Code

- **Help > Report Issue** opens a prefilled GitHub issue flow scoped to "VS Code" or a specific extension (e.g. GitHub Copilot Chat), so the bug report already carries version/extension context instead of a blank form.
- Command Palette → **Developer: Open Extension Logs Folder** opens the on-disk logs directory directly; **Output: Show Output Channels...** lets the user pick a specific channel's log.
- **Developer: Set Log Level...** sets verbosity globally or per output channel (Trace/Debug/Info/Warning/Error), so routine use stays quiet and troubleshooting can dial up detail only where needed.
- Source: [Troubleshoot AI in VS Code](https://code.visualstudio.com/docs/copilot/troubleshooting)

## Electron `crashReporter`

- `crashReporter.start()` (called early, before `app.on('ready')`) uses **Crashpad** to catch crashes in all subsequently created processes and produces **minidumps** — small, standardized crash snapshots, not full memory dumps.
- `uploadToServer` (default `true`) can be set to `false` so dumps are **collected and stored locally only, never transmitted**; it's toggleable at runtime via `setUploadToServer()`.
- Dumps land under the app's user-data directory in a `Crashpad` folder by default (e.g. `~/Library/Application Support/<app>/Crashpad` on macOS); `app.setPath('crashDumps', ...)` overrides the location, and `app.getPath('crashDumps')` reads it back.
- Source: [Electron `crashReporter` docs](https://www.electronjs.org/docs/latest/api/crash-reporter)

## Sentry

- SDKs auto-collect **breadcrumbs** (nav, clicks, console, network, prior log statements) as a timeline leading up to an error; breadcrumbs and stack-locals can carry PII if the app logs sensitive values, so Sentry explicitly warns not to log PII into anything that becomes a breadcrumb.
- Events are tagged with `release` and `environment` so the same crash can be filtered/grouped by version and by dev/staging/prod.
- **`beforeSend`** (and `beforeBreadcrumb`) is a callback the app supplies to inspect, scrub, or drop an event/breadcrumb before it leaves the process — the standard hook for redacting secrets or PII at the point of capture.
- Source: [Scrubbing Sensitive Data](https://docs.sentry.io/platforms/javascript/guides/react-router/data-management/sensitive-data/)

## Bugsnag

- `releaseStage` distinguishes errors by where they happened (development/production/etc.), similar to Sentry's environment tag; breadcrumbs auto-capture error, log, navigation, request, state, and user events, each independently toggleable.
- `redactedKeys` is a built-in allowlist/denylist mechanism (exact match, case-insensitive, prefix match) that redacts sensitive keys before send — defaults to redacting `password`, and apps add their own (tokens, card numbers).
- Dedicated "sensitive data management" tooling lets teams redact or scrub PII retroactively for compliance (GDPR/CCPA/HIPAA), not just at capture time.
- Source: [Bugsnag: sensitive data management](https://docs.bugsnag.com/product/sensitive-data-management/)

## OpenTelemetry (logs)

- The Logs Data Model defines `TraceId`/`SpanId` fields so a log line emitted inside a traced operation carries the same ids as the trace/span — this is what lets you jump from "this request was slow" to "here are the log lines written during it."
- `SeverityNumber` is a normalized integer scale (TRACE 1–4, DEBUG 5–8, INFO 9–12, WARN 13–16, ERROR 17–20, FATAL 21–24) so backends can sort/filter consistently even when different components use different native log levels.
- The pattern generalizes beyond OTel: any per-task/per-request correlation id embedded in every log line it produces is what makes a "recent structured logs" view actually diagnostic instead of a scrollback dump.
- Source: [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)

## GitHub Desktop

- **Help > Show Logs...** opens the log folder directly in the OS file browser (macOS: `~/Library/Application Support/GitHub Desktop/logs/*.desktop.production.log`; Windows: `%APPDATA%\GitHub Desktop\logs\*.desktop.production.log`).
- Its bug-report issue template explicitly instructs users to attach the log file from that folder when filing on GitHub — logs are opt-in, user-attached, not auto-uploaded.
- Source: [desktop/desktop issue #10388 (bug report template referencing Help > Show Logs)](https://github.com/desktop/desktop/issues/10388)

## 1Password and Signal (privacy-first pattern)

- **1Password**: diagnostics are generated only when the user chooses to share them (e.g. a Settings toggle to share extension diagnostic logs, or a `basic-diagnostics.html` file attached only when the user submits a support request); no 1Password data, account password, or Secret Key is ever included. Nothing leaves the device without an explicit user action.
- **Signal**: Settings > Help > **Submit Debug Log** produces a locally scrubbed log (personal info stripped via a scrubbing log formatter) and gives the user a **link to review** before deciding whether to share it with support — the log is generated on demand, reviewed, and only sent if the user follows through.
- Both products treat diagnostics as strictly opt-in, user-reviewed, and narrowly scoped — the opposite of always-on telemetry.
- Source: [1Password diagnostics privacy](https://support.1password.com/diagnostics-privacy/), [Signal: Debug Logs and Crash Reports](https://support.signal.org/hc/en-us/articles/360007318591-Debug-Logs-and-Crash-Reports)

---

## Must-haves to pinpoint a problem

- App/build version, OS + arch, install type (installer vs portable/dev), Electron/Node runtime versions.
- Redacted config snapshot (feature flags, model/provider selection, paths — with secrets stripped).
- Recent structured logs with severity levels and a correlation id per task/request, so one action's log lines can be pulled out of the noise.
- A process/service map: gateway server, main window, background helper processes, updater, IPC channels, connected MCP servers, local model runtime — which ones are alive, which crashed.
- Crash dumps plus the last N breadcrumbs leading up to the crash (recent actions, not just the stack trace).
- Update/rollback history (what version was running when, what changed).
- Health checks (are required local services actually up) and network reachability (can the app reach the services it depends on).
- Disk space and file/permission checks (can the app write to its data folder, is it out of space).
- Timing and uptime (how long the process has been running, when the problem started relative to launch/update/sleep).

## Privacy must-haves

- Diagnostics collection is **off by default** wherever it's a "feature" rather than a bare-minimum local log.
- **Local-first**: everything is written to disk on the user's machine; nothing assumes a remote collector exists.
- **Redaction at write time**, not just at send time: API keys, tokens, bearer/auth headers, email addresses, home-directory paths, and message/prompt contents are stripped or replaced by default unless the user opts in to including them.
- The user **previews exactly what will be sent** before any report leaves the device — no silent uploads.
- **Per-item remove**: the user can drop individual log lines/fields from the preview, not just accept-or-cancel the whole bundle.
- **Nothing sent automatically** — no background telemetry server, no auto-upload on crash.
- **Retention caps**: logs rotate and expire by both size and age, so the log folder doesn't grow unbounded or retain sensitive history indefinitely.

## What Branch adopts

- **Recent structured logs with correlation ids** → JSON-lines log file with rotation and a retention cap (size + age), written to Branch's data folder.
- **Redaction at write time** → a write-time redactor (API keys, tokens, bearer headers, emails, home-directory paths, message contents unless opted in) that runs before a line ever hits disk, not as a filter applied later.
- **Electron crashReporter local-only** → `crashReporter.start({ uploadToServer: false, ... })` so Crashpad minidumps land in `app.getPath('crashDumps')` and are never phoned home automatically.
- **1Password/Signal opt-in review pattern + Claude Code's `/bug` consent screen** → a `branch report` CLI command and a "Report a problem" window action that builds the bundle, shows the user a **preview** of exactly what's in it, and only then lets them save it as a zip or open a **prefilled GitHub issue** (title/body only — the zip is attached by the user, never auto-uploaded).
- **VS Code's Output channels / Show Logs + GitHub Desktop's Help > Show Logs** → an in-app **Activity log** view (readable, per-task/per-service, filterable by level) backed by the same JSON-lines log. The log lives in `<data folder>/logs/` for anyone who prefers to open the files directly.

## What Branch already had (audit, mac7/diagnostics, 2026-09-19)

| Piece | Where | Gap it left |
|---|---|---|
| Diagnostics folder (health, versions, events, spans, pricing, allowed, tools, memory; secrets scrubbed, payloads dropped) | `src/diagnostics.ts:126`, route `src/server.ts` `/api/diagnostics/bundle`, card `public/index.html` `#diagnostics-card` | No preview, no per-item remove, no log, no process map, no update history, no disk/network; no zip; emails and home paths not removed |
| Uncaught errors / unhandled rejections recorded as spans | `src/tracing.ts:140` `recordUncaughtErrors` | No breadcrumbs of what happened before |
| Window and helper-process deaths | `src/desktop/main.ts:317` `watchDesktopCrashes`, `src/tracing.ts` `recordDesktopCrash` | Electron crash reporter never started, so no minidumps; window JavaScript errors not recorded |
| Event log to an embedding program's logger | `src/log-bridge.ts` `bridgeLogs`, `levelFor` | Nothing written to a file of Branch's own |
| Per-task timeline | `branch logs <task>` (`src/cli.ts:666`) | One task at a time; no services |
| Health check / doctor | `src/health.ts:76`, `branch doctor` (`src/cli.ts:817`) | Fine; reused as a report item |
| Tamper-evident activity chain | `src/safety-extras/activity-chain.ts`, `branch activity verify` | About what was allowed, not about failures |
| Audit record of permissions | `src/audit.ts` | Same: permissions, not diagnostics |
| Event-loop stall watch | `src/event-loop-watch.ts` | Its stalls reach the log through task events only |
| Never-break journal and activation ledger | `src/never-break/journal.ts`, `src/never-break/activation.ts` (`activation.sqlite`) | Update/rollback history not shown anywhere a helper could read it |
| "Getting what a stopped task is missing" | `src/adapt/` | Unrelated to diagnostics; used as the owner-only route pattern |

## What was built

- `src/diagnostic-log.ts`: the activity log (JSON lines in `<data>/logs/branch.jsonl`, rotated into at most 5 files within the owner's size cap, older files removed after N days), `redactForLog` (leak-guard + scrub + auth headers + emails + home folder, applied at write time), in-memory breadcrumbs, `crashes.jsonl` with the last 30 breadcrumbs, `crashReporterOptions()` (uploads off).
- `src/diagnostic-report.ts`: the report items (about, health, services, settings, log, crashes, updates, tasks, disk, network), zip, GitHub issue link (title/body only).
- `src/diagnostic-api.ts`: `/api/diagnostics/*` routes, the engine's log start-up (task events, crashes), the settings summary.
- `src/diagnostic-cli.ts`: `branch report` and `branch report log`.
- `public/activity-log.js` + cards in Settings › Advanced (Activity log) and Settings › Updates & about (Report a problem), and a Help link.
- Log lines from the gateway (failed requests with a request id), updater, MCP servers, chat apps, window errors, desktop crashes.

Modes: the activity log ships **off** (off / when needed / on). Crash notes are always written, locally, because they already were (spans) and a report after a crash is useless without them.
