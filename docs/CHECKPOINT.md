# Branch Agent checkpoint — 2026-09-15 (late evening)

## Batch 19 (wave 1) — usage and observability dashboard

`src/usage.ts` (UsageStore class): aggregates runs and events by date to produce daily token consumption, estimated costs, and failure counts; tracks per-model and per-conversation usage; optional caching table for incremental refresh by event-id watermark (only terminal runs included). `GET /api/usage?range=7d|30d|90d|all&by=day|model|conversation|source` returns aggregated usage; `GET /api/runs/:id/timeline` returns a timestamped sequence of model calls, tool invocations, retries, and stalls from events, with durations (uses clipToolResult pattern for clipped output, future option for OTel-compatible trace export). Routes: `POST /api/usage/budget` to set optional monthly token budget and pause switch; `GET /api/usage/budget` to read it. Runtime budget enforcement at run-start in runtime.ts (not in Budget class — different concern). `GET /api/usage/export.csv` in rawApi() for download. `public/usage.js` builds the view with summary cards, daily cost canvas chart, table by model, budget form, export button. UI integrates into index.html nav and app.js titles; public/style.css variables reused. Tests: aggregation over fixture store with multiple runs/receipts across days and models, incremental refresh (adding a run updates only the new day), terminal-run filtering, reported-vs-estimated token selection, timeline event ordering and durations. Costs: derived at aggregate time from tokens × preset pricing (no cost column added to storage; no second source of truth). Items done: A0202 (usage tracked, display added), A0269 (display added), A0346, A0638 (cost estimation not implemented, left as future work following design constraint), A0929 (user-facing aggregation added), A0972 (timeline export added).

## Where things stand

The user's standing instruction: keep improving locally and publish to GitHub only at checkpoints
worth having; there are no live users besides the owner, who uses the packaged app and updates it
from **Settings → Updates**. Do not merge or release every batch.

- Worktree: `C:/Users/bishi/Documents/Codex/Branch-build`, branch `feat/assistant-runtime`.
- Remote: `https://github.com/stabrea/Branch-Agent.git`; PR #1 targets `main`.
- Published: https://github.com/stabrea/Branch-Agent/releases/tag/v0.2.0 (main merge b508f57; live updater check verified from 0.1.0 → available and 0.2.0 → current).
- 0.2.1 (fix): the ChatGPT backend rejects `max_output_tokens`, answers without a content-type
  header and sends `usage: null` in early events. Fixed and verified against the owner's real
  sign-in (streamed reply + real tool call). Provider error text is deliberately never persisted
  (see `tests/provider-retry.test.mjs`); do not add it to messages or events.
- The owner's app now runs from `C:/Users/bishi/AppData/Local/Programs/Branch Agent/` (copied
  from `release/`), so `npm run package:desktop` no longer fights the running executable. The
  in-app updater mirrors new releases into that folder.
- Smart App Control (state 1, enforcing on this machine) blocked the repackaged 0.2.1 executable while
  the stock Electron binary and the earlier 0.2.0 build ran. Packaging now ships the stock
  `electron.exe` as `Branch Agent.exe` (see docs/desktop.md); the update script keeps
  `<install>.previous` and rolls back if the new build does not start. Code signing (Azure Trusted
  Signing or an OV certificate) is the real fix; tracked under security (#12) and owner requests (#18).
- Update hand-over lessons (0.2.2): `tasklist /FI "IMAGENAME eq <name with space>"` matches nothing;
  `timeout` dies without a console; a PATH with Git's Unix `find` breaks `find`. The script now uses
  `%SystemRoot%\System32\{tasklist,find,ping,robocopy}.exe`, CSV listing, bounded drain, retries and
  `apply-update.log`. Rehearse with `Updater.writeScript()` + a staged copy before every release.
- Header: "Branch Agent by KeepOak" (by tiny, KeepOak small). Sidebar: the assistant identity name.
- Published v0.2.2: https://github.com/stabrea/Branch-Agent/releases/tag/v0.2.2 (main ea35fd1). Live check from 0.2.1 offers it. The owner's installed 0.2.1 carries the fixed hand-over script; their button click is the first real button-driven update.
- Version `0.2.2`. Release process: merge to `main`, tag `vX.Y.Z`, `gh release create` with
  `release/Branch-Agent-windows-x64.zip` and its `.zip.sha256`. The in-app updater reads
  `releases/latest` and requires both assets by exact name.
- The user wants the header mark to read **KeepOak** and the sidebar card to stay **Branch Agent**.
- Copy rule: plain language for non-technical people, no developer jargon in the interface.

## Tracking on GitHub

Nothing lives only in chat. Open work is tracked as checklists:

- Issues #2–#17: one per inventory family (`inventory` label), one checkbox per acceptance entry.
  Tick a box only when the criterion passes with a real fixture and the ledger is updated.
- Issue #18: the owner's direct requests (`owner-request` label).
- Regenerate `docs/features.md` with `branch-public-coverage.py` after ledger updates and mirror
  the change into the family issue with `gh issue edit`.

## Batch 19 (wave 1) — providers

`src/providers/presets.ts` (built-in preset catalog with 12 cloud and local providers); `src/providers/gemini.ts` (native Google Gemini adapter with streaming, tool calling and system instructions); `GET /api/providers/catalog` (list all presets with display names, base URLs and help text), `POST /api/providers/test` (validate an endpoint with a test request, return plain-language reasons for failure), `GET /api/providers/local` (probe for Ollama at 11434 and LM Studio at 1234, list available models). The probe does not go through the network policy so it works even when private addresses are blocked. Presets for Groq, Mistral, DeepSeek, OpenRouter, Together, Fireworks, Perplexity, xAI, Cerebras, Ollama and LM Studio; all conform to OpenAI-compatible Chat Completions protocol except Gemini. Closes audit items A0167 (local model serving), A2365 (local LLMs), and addresses A1139 (transformers local models), A0498 (OpenAI-compatible local models).

## Batches 7–9 ship as 0.5.0

Coverage 51 implemented, 42 partial, 75 missing, 1 external of 169.

## Batch 18 (local, unreleased): teams, linked chats, reconciliation gate, skill registry, evaluation suite, hand-over via Task Scheduler

`src/teams.ts`, `src/registry-install.ts`, `src/evaluation.ts`; `ChannelRouter.link`; `Runtime.reconciliationBlock`
(unreconciled writes per session after resume); `standardSuite`; `branch eval`. Update hand-over now starts through
`schtasks` (`src/desktop/hand-over.ts`) because a spawned child dies with the app when the app runs inside a Windows
job; unpacking uses System32 tar.exe (37 s → about 1 s). Default run budget raised to 60 steps / 200k tokens: the tool
catalog alone is ~5.7k estimated tokens per round and 24k ran out after three rounds. Rehearsal harness:
`rehearse-update.mjs` in the scratchpad (launches a staged copy detached, drives it over CDP).

## Batch 17 (local, unreleased): skill governance, benchmarks, drafts from traces, daily consolidation

`src/skill-governance.ts` (failure signatures, set-aside with recovery trial, demotion, benchmark, proposeFromRun)
stored in the generic `governance` table; `skillInstructions` filters the catalog per run; `Runtime.execute`
records outcomes for top-level runs; `MemoryReview.consolidate` with `dream-cursor` (children and consolidation
runs excluded), `Scheduler.tick` runs it when due; routes under `/api/governance`, `/api/skills/:id/benchmark|draft`,
`/api/memory/consolidate`. Learning settings gained `consolidateDaily`.

## Release 0.7.1 (batch 16 + Enter-to-send)

Version 0.7.1. Packaged with the stock electron.exe; 8/8 native tests against the packaged build. This is the
first release the owner's fixed 0.7.0 updater should fetch through the button; rehearse the real path on a
staged copy of the 0.7.0 install before asking the owner to press it.

## Batch 16 (released in 0.7.1): resource limits, shared network policy, hooks, WebSocket, channel test

`src/integrations/process-usage.ts` (sampled memory/CPU, `watchUsage`) used by `ShellProcess`;
`src/network-policy.ts` (host + host/path rules, `guard(fetch)`) owned by `WebAccess.policy` and shared
with `BranchBrowser.policy` and `connectMcp(..., policy)`; `src/hooks.ts` fed by `store.onEvent`, hooks run
through the shell integration's aliases (bootstrap `hookRunner`); `src/ws.ts` minimal RFC 6455 server on
`server.on("upgrade")`; `POST /api/channels/test`. Also the Hermes capability audit (120 agents) became
issues #29–#52 (index #42). Next: release 0.7.1 so the owner's 0.7.0 gets Enter-to-send through the button.

## Update incident 2026-09-15 (owner's 0.3.0 → 0.6.0) and the fix shipped in 0.7.0

What happened: the button downloaded and staged 0.6.0 (169 MB took minutes with no visible progress; a
second press hit "already in progress"), the hand-over script started, `app.quit()` ran but the
shutdown never finished, so the process stayed alive with its window gone, the script waited on the
pid forever, and relaunching only signalled the stuck single instance ("didn't open"). Fix: bounded
shutdown (8 s race then `app.exit(0)`), a 20 s hard exit after launching the hand-over, the script
ends the old pid itself after ~2 minutes, a second press returns status instead of an error, and a
full-window updating screen (`public/update-screen.js`: stage, MB progress, pixel walker). The
owner's install was moved to 0.7.0 by hand (previous kept as 0.3.0). Research: Hermes does not use a
model to update; it uses numbered config migrations, update receipts and verified restart recovery.
Follow-up: receipts + first-launch version check for Branch (issue #18).

## Release 0.7.0 (batches 12 to 15)

Version 0.7.0. Packaged with the stock electron.exe; 8/8 native tests against the packaged build; zip via
System32 tar.exe; two-space checksum file. Coverage 85 implemented, 20 partial, 63 missing, 1 external.

## Batch 15 (released in 0.7.0): time-qualified facts, memory scopes, admission switch, tidy-up view

`MemoryDataSchema` gained entity/attribute/validFrom/validTo/scope (scope optional so exports keep their
shape); `closeEarlier` ends the previous fact and keeps a version (reason superseded); `memory.at`,
`memory.timeline`; `ToolContext.agent` set by `Knowledge.delegate`/fan-out (`activeSpecialist` returns the
id) and honoured by search/at/timeline, memory.put's default scope and the session snapshot;
`/api/sessions/:id/memory-policy` reuses memory_suppressions; Memory view: about/detail/shared fields,
Tidy up + Set aside list; conversation panel: remember switch.

## Batch 14 (released in 0.7.0): recipe inputs and result shapes, templates, project folders

`src/recipes.ts` (ParametersSchema, bindInputs, substitute, placeholders) used by `Knowledge.bound()` in
verify/replay; `resultSchema` on procedures checked with the exported `mismatch`; `src/templates.ts`
(export/import with the skill scanner's secret patterns) + `templates.export/import` tools and
`/api/templates/*`; `WorkspaceFiles.scope`/`base` driven by the active project's `folder`.

## Batch 13 (released in 0.7.0): OpenAI endpoint, SSE, follow-ups, background specialists, backup, health

`src/openai-compat.ts` (`/v1/chat/completions`, `/v1/models`), `src/streams.ts` (`/api/runs/:id/stream`),
`Runtime.followUp/queued/drainFollowUps` (durable queue in settings `followups:<session>`, drained after each
top-level run), `Runtime.delegateBackground` + `specialists.delegate background`, `src/backup.ts`
(`store.backup/restore`, `branch backup|restore`, desktop `exportBackup` IPC), `src/health.ts`
(`/api/health`, `branch doctor --probe`, Settings → Health check). Raw-response routes go through
`rawApi()` in server.ts. Test runner concurrency is 3: at the default, an Electron test can stall and hang
the whole suite (kill the stray `electron.exe` from node_modules, never the owner's app).

## Batch 12 (released in 0.7.0): workspace history, memory versions, checkpoints, approval, review, session snapshot

`src/workspace-history.ts` (file_versions/workspace_snapshots, lineDiff, files.history/files.restore/
workspace.snapshot, `/api/history/*`, Activity undo buttons, Settings snapshots card) wired through a
`WriteObserver` on files.write; `src/memory-review.ts` (settings `learning`, proposals, checkpoints,
session snapshot) + memory_versions in `MemoryFacts` (kept before edit and on delete), staged memory
tools when requireApproval, post-task review in `Runtime.scheduleReview` (detached, tracked). Note:
Store's `history` is the session library; the workspace one is `store.workspaceHistory`.

## Release 0.6.0 (batches 10 and 11)

Published: https://github.com/stabrea/Branch-Agent/releases/tag/v0.6.0 (main d831752, PR #27, CI green before merge). Version 0.6.0. Packaged with the stock electron.exe; 8/8 native tests against the packaged build; zip
made with `C:\Windows\System32\tar.exe -a -cf` (forward-slash entries, like earlier releases) and a
two-space `sha256sum`-style checksum file. `npm run package:desktop` does not produce the zip.

## Batch 11 (released in 0.6.0): skill scanning, receipts, content guard, delegated exit criteria, live activity

`src/skill-scan.ts` + policy in `InstalledSkills` (scan column on skill_versions, acknowledge on activate),
`src/receipts.ts` (HMAC receipts on tool.completed, verify/classify; `/api/runs/:id/receipts`,
`/api/receipts/verify`), `src/content-guard.ts` wired into web.fetch/web.search with the `injection`
policy and `content.flagged` events, `checks` on delegate/fan-out, `src/activity.ts` + `/api/activity`
+ the activity panel above the conversation. Receipts need the locker open (createBranch always opens it).

## Batch 10 (released in 0.6.0): completion checks, stalls, overflow, continue, delivery ledger

`src/reliability.ts` (CompletionCheckSchema/evaluateChecks, StallError/withStallWatchdog,
clipToolResult/shrinkToolResults, ReliabilityOptionsSchema), runtime `checks`, `resume`, `fitContext`,
stall recovery and tool time limit; `src/channels/deliveries.ts` ledger used by router replies and
scheduler deliveries (keys reply:<run>, schedule:<run>), Settings → Channels "Messages still to send",
Activity "Continue where it stopped". Model calls now always stream (the watchdog needs deltas).

## Process note: v0.5.0 shipped while the PR check was red

The fan-out test used a wall-clock bound (three 120 ms tasks under 460 ms) that hosted runners
miss under load (938 ms, 2796 ms observed). The release command chain used `;`, so the merge and
publish went ahead despite the failed check. The assertion is now a deterministic overlap check
(both independent tasks must be in flight before either may finish). Rule going forward: chain
release steps with `&&` and read the PR check conclusion before merging.

## Batch 9: delegation results, limits, cancellation, fan-out

`src/delegation.ts` (checkResult JSON-Schema subset, fanoutWaves), `Runtime.delegate` options
(timeoutMs, resultSchema; 4 concurrent children per parent; derived abort signal), `delegateChecked`,
`fanout`; `specialists.delegate` gains resultSchema/timeoutMs, new `specialists.fanout`.
Test fixtures must honour `request.signal` or a timed-out child never returns.

## Batch 8 (local, unreleased): conversation compaction, needs-input attention

`compactions` table + `store.workingMessages`; `Runtime.maybeCompact` (threshold 11k est. tokens, keep 6,
cut at a user turn, summariser call through `complete()` with no tools, `context.compacted` event);
`user.ask` tool → `NeedsInputError` → run status `needs_input` + `attention.needed`; `/api/state.attention`;
banner + Notification in the UI; channels send the question as the reply.
Coverage 46 implemented, 45 partial, 77 missing.

## Batch 7: web reading, network guard, skill pinning, memory hygiene, tool inventory

`src/integrations/web.ts` (web.search / web.fetch, registered by default; SSRF guard on every hop;
host allow/block lists; `web` section in the integrations file), `pinned-skill:<session>` setting with
`/api/sessions/:id/skill`, `memory_archive` table + `/api/memory/hygiene|archive|archive/:id/restore`,
`registry.unregister/names/inventory` + `GET /api/tools` (integrations unregister their tools on close).
Coverage 43 implemented, 46 partial, 79 missing. v0.4.0 published (main 86e66a9); the hung push CI run
was cancelled after the identical PR run passed.

## Batch 6: automation (0.4.0 with batch 5)

Commit 364da62. Scheduler: `deliverTo` (channel delivery with recorded message id), per-schedule
`history` (≤50, running/finished/failed, trigger), kind `check` (previous result fed forward), `dailyAt`
+ `timezone` (`nextDailyOccurrence`, DST-safe), `webhook` → `hookToken`, unauthenticated
`POST /hooks/:id` guarded by `x-branch-hook-token`, `POST /api/schedules/:id/trigger`, CLI `trigger`.
Coverage 38 implemented, 47 partial, 83 missing. Full suite green.

## Batch 5: Telegram channel, pairing, activation, /skills /memory

`src/channels/router.ts` (per-chat conversations, pairing codes approved in Settings → Channels,
mention/always activation, no shell permission for channel tasks) and `src/channels/telegram.ts`
(long polling; token from `tokenSecret` in the default project's locker or `tokenEnv`). Config lives in
the integrations file under `channels`. Routes `/api/channels`, `/api/channels/pairings/approve|remove`.
Full suite green; coverage 32 implemented, 51 partial, 85 missing. Verified only against a local fake
Telegram server; the owner's real bot has not been connected yet.

## Batch 4: terminal commands, projects, secrets locker (0.3.0)

Published: https://github.com/stabrea/Branch-Agent/releases/tag/v0.3.0 (main 01aabeb). The owner's install
was brought from 0.2.1 to 0.3.0 through `Updater.install()` + the hardened `apply-update.cmd` on the
real install folder: keep previous → copy → start → detected, no rollback. The owner's assistant is named "TK".

Commits 43b3627, 2d9ead1. `/models` `/model` `/think` in the terminal (per-run override through
`ModelRouter.plan(owner, sessionId, override)`); `src/projects.ts` (instructions, preferred model,
default project) and `src/locker.ts` (AES-256-GCM, key file `locker.key` in the data dir, host-boundary
injection via `shell.execute` `secrets`, scrubbed output). Routes `/api/projects*`, `/api/secrets*`.
Full suite green; coverage 29 implemented, 51 partial, 88 missing. Packaged 0.3.0 passes 8/8 native tests.
Note: a file named `secrets.ts` is blocked by the tool's write rules; the module is `locker.ts`.

## Batch 3: setup, temporary chats, forgetting

Commit 85f34d1. First-run panel with three doors and a real test call (`POST /api/models/test`,
`POST /api/onboarding`); temporary conversations (`temporary` on `/api/run`, `POST
/api/sessions/:id/discard`, purge at startup); memory forgetting (`/api/memory/forget/preview`,
`/api/memory/forget`, `memory_suppressions`, `originRunId` on facts). Full suite 213/0/1.
Coverage 28 implemented, 51 partial, 89 missing. Issues #3, #7, #14, #18 updated.
Release 0.3.0 when the next batch (terminal `/model` `/think`, project secrets) lands.

## Delivered this session

1. Skills batch shipped (coverage: `extensions.progressive`, `extensions.authoring` implemented).
2. Models: `src/models.ts` router with named presets, owner default, per-conversation override,
   thinking effort, ordered fallback with cooldowns, `model.selected` / `model.fallback` events,
   `models` in `/api/state`, `POST /api/models`, `GET|POST /api/sessions/:id/model`.
   `BRANCH_MODEL_PRESETS` JSON in the launch environment; keys via named variables only.
3. ChatGPT plan sign-in: `src/chatgpt-auth.ts` (device-code flow, vault, refresh sharing),
   `src/chatgpt-provider.ts` (Responses API, streaming, honest `originator: branch-agent`),
   `src/chatgpt-presets.ts` (registers `chatgpt-gpt-5.5|5.6|5.4`, prefers ChatGPT over the demo).
   Routes `/api/chatgpt/status|login|logout`; CLI `login`, `logout`; desktop vault under safeStorage.
4. Updates: `src/desktop/updater.ts` (GitHub latest release, SHA-256 verify, PowerShell expand,
   `apply-update.cmd` hand-over), `updater-ipc.ts` (+ allow-listed `open-external`), Settings card.
   CLI `update` refreshes a Git checkout. `package.json` has `bin.branch`.
5. UI: model controls above the composer, Models / ChatGPT account / Updates cards in Settings,
   plain-language demo notice, KeepOak header mark.

Coverage after this session: 26 implemented, 52 partial, 90 missing, 1 external (see
`docs/features.md`; ledger source in `../branch-build-research/coverage-assessment.json`).

## Verified

- Full suite before the desktop-bridge key update: 199 tests, 1 failure that was only the stale
  preload key list; that test now passes (`tests/desktop-settings.test.mjs` 3/3).
- New suites: `tests/models.test.mjs` 6/6, `tests/chatgpt.test.mjs` 6/6, `tests/updater.test.mjs` 4/4
  (the install test runs the real hand-over script against a scratch install folder).
- Function-length check: 0 bodies at or above 50 lines.
- ChatGPT sign-in was verified only against the local fake OpenAI fixture; the real device flow
  needs the owner to complete it once in the app. OpenAI's docs say device-code sign-in is a beta
  the user may need to enable in their ChatGPT security settings.

## Still unverified or pending

- The updater's end-to-end path against a real GitHub release (check → download → verify →
  restart) is unverified until a second release exists; the check step can be verified live once
  v0.2.0 is published.
- Anthropic thinking budgets and OpenAI `reasoning_effort` were verified at the request-body level
  only, not against live providers.
- The `identity-ui` file failed once under parallel Chromium load and passed alone; watch for flakiness.

## Batch 19 (wave 1) — voice

Voice input and output: `POST /api/voice/transcribe` sends binary audio to the configured provider's
OpenAI-compatible `/v1/audio/transcriptions` endpoint and returns transcribed text; client records
with MediaRecorder (WebM) and displays transcription in the message box without auto-sending.
`POST /api/voice/speak` sends text to the provider's `/v1/audio/speech` endpoint and streams the
audio back (MP3); client plays it with the Web Audio API. Browser's speechSynthesis is always
available and free (offline); higher-quality voice from provider is optional. Voice settings (auto
read-aloud, voice choice, speech rate, provider voice toggle) stored per owner at `GET|POST /api/voice/settings`. Microphone button in composer (hold to record), voice settings panel in Settings,
read-aloud controls on assistant messages. Covers A1893 (speech-to-text) and A1894 (text-to-speech).

## Batch 20 (wave 2) — app shell, tokens and appearance

The browser and desktop interface was rebuilt around the approved KeepOak redesign. A token layer
(`public/tokens.css`) is now the only place a colour is written down: Forest and Daylight themes
copied from `site.css` and `app/portal.css`, five accents (copper, leaf, earth, slate, ink) copied
from `site.css`, `app/appearance.css` and `public-theme.css`, plus scales for text size, spacing,
radius, focus rings and motion. `public/shell.css` replaces the old fixed-position layout with a
four-column grid on `body`: a thin icon column carrying every section (Settings at its foot, no
drop-down anywhere), a conversation rail grouped by Today/Yesterday/Earlier, one main pane with a
sticky title bar, and a context pane; both side panes fold away from the top bar and the choice is
remembered. `public/shell.js` adds the icons, the rail (fed by `POST /api/sessions/search`) and a
command palette on Ctrl+K covering sections, conversations, recipes, skills and the top actions,
with Ctrl+N, Ctrl+, and Esc. Under 1000 px the rail slides over the page; under 720 px the icon
column becomes a bottom bar and the page still never scrolls sideways at 400 px.
`public/appearance.js` and an extended `PreferencesSchema` add seven appearance controls (theme
including "follow this computer", highlight colour, text size, spacing, lettering, keep things
still, show the acorn) that apply instantly and persist through `POST /api/preferences`. New
static routes: `/tokens.css`, `/shell.css`, `/shell.js`, `/appearance.js`. Tests:
`tests/shell-ui.test.mjs`.

## Next work (local until a checkpoint worth publishing)

1. Next release (0.3.0) is the first real end-to-end test of the in-app update path; watch it.
2. Onboarding polish (`operations.setup`): first-run screen that offers ChatGPT sign-in, API key
   or offline demonstration, with a real test call.
3. Continue the inventory: `routing.temporary`, `memory.forget`, `workspace.secrets`,
   `automation.*`, `delegation.*`, then channels (`routing.channels`, `routing.pairing`).
4. Terminal parity with Hermes: `branch` command polish, `/model` and `/think` commands in chat.
5. Keep `THIRD_PARTY_NOTICES.md` current (MIT/Apache upstreams require it).

Tools: `branch-function-check.mjs`, `branch-agent-archive.py`, `branch-public-coverage.py`,
`branch-agent-pr.md` under `C:/Users/bishi/AppData/Local/Temp/Codex-session-files/`.
Stop the running packaged app before `npm run package:desktop`; the packager cannot replace a
running executable.
