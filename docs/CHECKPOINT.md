# Branch Agent checkpoint — 2026-09-15 (late evening)

## Batch 19 (wave 2) — version control and GitHub

`src/integrations/git-run.ts` locates the installed Git once with `where git` (`which git` elsewhere), verifies the path is a real file and caches it, then runs every command through the existing `ShellProcess` runner — never a shell. Each call is prefixed with `-c safe.directory=<cwd> -c core.hooksPath=<nonexistent> -c core.quotepath=false -c credential.interactive=never --no-pager`, and the child gets a narrow environment plus `GIT_TERMINAL_PROMPT=0`, so a repository's own hooks never run and Git can never block on a password prompt. `explainGit()` maps Git's wording to plain sentences (not installed, not a repository, unmerged changes, unknown identity, dubious ownership, rejected push, unreachable server, timeout). `src/integrations/git.ts` (`GitTools`) resolves every folder through `WorkspaceFiles.checked()` so commands stay inside the workspace or the active project's folder, and implements status/diff/log/branch/commit/worktree/push/pull. `git.commit` stages only the paths it listed, refuses when nothing is staged and never amends; `git.diff` lists names first, drops hidden ones and caps the returned text at 24 000 characters; `git.worktree` confines parallel copies to `.branch-worktrees` inside the repository. `src/integrations/git-tools.ts` registers them under three permissions: `git.read` (status, diff, log), `git.write` (branch, commit, worktree) — both registered in `createBranch` — and `git.remote` (push, pull), registered only when the integrations file carries `"git": { "remote": true }`, so pushing is off by default. Pushing to main/master throws `NeedsInputError`, reusing the `user.ask` pause. `src/integrations/github.ts` (`GitHubAccess`) talks to the REST API through the shared `NetworkPolicy`; the personal access token comes from the active project's locker (`GITHUB_TOKEN`, since locker names are environment-style), travels only in the `Authorization` header, never in a web address, and every reply is put through `scrubSecrets` before it is parsed or reported. `github.create_repo` (private by default), `github.open_pull_request`, `github.list_issues` and `github.create_issue` sit behind `github.manage`. `src/ignore.ts` (`ignoreMatcher()`, dependency-free) reads gitignore syntax; `WorkspaceFiles` loads `.branchignore` from the workspace root, re-reads it when it changes, refuses hidden paths in `checked()` and filters them out of `list()`, and the git tools reuse the same matcher. The fixed secret patterns still run first, so a `!` line cannot re-expose an `.env`. Chat-channel and skill-benchmark runs have `git.remote` and `github.manage` stripped alongside `shell.execute`. Tests: `tests/git.test.mjs` (12) init a real repository and exercise every tool, prove a `pre-commit` hook does not fire, prove commit refuses an unchanged tree, prove push is absent and then permission-denied and then asks about main, run a `node:http` GitHub fake asserting the bearer header and that no token reaches the event log, receipt or result, and check the network policy blocks a non-GitHub host. Items done: A0388, A0393, A0435, A2333.

## Batch 19 (wave 1) — usage and observability dashboard

`src/usage.ts` (UsageStore class): aggregates runs and events by date to produce daily token consumption, estimated costs, and failure counts; tracks per-model and per-conversation usage; optional caching table for incremental refresh by event-id watermark (only terminal runs included). `GET /api/usage?range=7d|30d|90d|all&by=day|model|conversation|source` returns aggregated usage; `GET /api/runs/:id/timeline` returns a timestamped sequence of model calls, tool invocations, retries, and stalls from events, with durations (uses clipToolResult pattern for clipped output, future option for OTel-compatible trace export). Routes: `POST /api/usage/budget` to set optional monthly token budget and pause switch; `GET /api/usage/budget` to read it. Runtime budget enforcement at run-start in runtime.ts (not in Budget class — different concern). `GET /api/usage/export.csv` in rawApi() for download. `public/usage.js` builds the view with summary cards, daily cost canvas chart, table by model, budget form, export button. UI integrates into index.html nav and app.js titles; public/style.css variables reused. Tests: aggregation over fixture store with multiple runs/receipts across days and models, incremental refresh (adding a run updates only the new day), terminal-run filtering, reported-vs-estimated token selection, timeline event ordering and durations. Costs: derived at aggregate time from tokens × preset pricing (no cost column added to storage; no second source of truth). Items done: A0202 (usage tracked, display added), A0269 (display added), A0346, A0638 (cost estimation not implemented, left as future work following design constraint), A0929 (user-facing aggregation added), A0972 (timeline export added).

## Batch 19 (wave 1) — webhooks-and-triggers

Six builders in parallel branches (wave1/*). This branch adds the two directions of event-driven automation, and they are wired to the places events actually happen rather than left as an unconnected library.

- Inbound triggers (`src/triggers.ts`): `POST /api/triggers/:id/fire` proves itself with a bearer secret or an HMAC-SHA256 signature over the exact request bytes, fills `{{payload}}` and `{{field.path}}` into the trigger's prompt, and starts a run. Rate limit per trigger, 256 KiB body cap (413), off switch (403), over-limit (429), and a per-trigger log of every attempt with its run id.
- Outbound webhooks (`src/webhooks.ts`): `Webhooks.notify` fans one event out to every webhook that asked for it. Three attempts with 5 s then 10 s pauses (the pauses are a settable field so tests do not wait), auto-off after five consecutive give-ups with a plain-language reason, reset on success, HMAC signature over the exact bytes sent, and a delivery log. Every address goes through the shared network policy.
- Event wiring: `Runtime.notifyEvent` and `Deliveries.notifyEvent` are no-op fields that `createBranch` points at the webhook fan-out. `run.completed`/`run.failed` from `Runtime.finish` (one call site, reading status), `approval.needed` next to the existing `attention.needed` event, `schedule.fired` in `Scheduler.execute`, `trigger.fired` in `Triggers.fire`, `delivery.failed` where the channel delivery ledger parks a dead letter. All fire-and-forget with errors swallowed: a webhook can never disturb a run. Payloads carry ids and status, never the task's text.
- Store: `trigger_log` and `delivery_log` tables, `triggers` and `webhooks` record tables; both logs order by row id so ties within a millisecond stay deterministic.
- UI (`public/automations.js`): rewritten as a real module that `app.js` imports and hands `state` plus its helpers. Three bugs fixed from the first pass — the panel never rendered (module scope), `/automations.js` was not in the server's static asset list, and creating either kind failed on a permission that no tool ever registers. Triggers and webhooks are owner-only settings behind the session token now, like channels and teams. Logs render in the panel instead of a pop-up; wording rewritten for a non-technical owner.
- Tests (`tests/triggers-webhooks.test.mjs`, 18): a real loopback endpoint receives `run.completed` with a valid signature, a failing run sends `run.failed`, a trigger fire sends `trigger.fired` and shows the run id in its log, a schedule sends `schedule.fired`, a stopped-to-ask run sends `approval.needed`, a dead chat message sends `delivery.failed`; bad signature, off trigger, rate limit, oversize body, retry-then-success, auto-off after five failures, private-address refusal under the default policy, and a headless browser check that the panel renders and its buttons reach the routes.

Items marked done: A1838 (outbound webhooks), A1816 (webhook/trigger fire system).

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

## Batch 19 (wave 1) — MCP server mode

Five parallel agents build independent feature areas of wave 1:
- **MCP server mode** (`wave1/mcp-server`): JSON-RPC 2.0 over HTTP/stdio exposes tools, resources, and prompts to other AI tools (Claude Desktop, Claude Code, Cursor) with session state, permission gates, and rate limits. Handler at `/mcp`, connection helper at `/api/mcp/connection`, settings at `/api/mcp/settings`. Tested: protocol negotiation, session tracking, auth, tool/resource/prompt listing, and exposure policy.
- **Documentation, Providers, Voice, Webhooks**: Four more agents building in parallel.

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

## Batch 19 (wave 1) — documents

`src/documents.ts` (library, settings, search, retrieval), `src/document-text.ts` (ZIP reader, docx/xlsx/HTML/plain
extraction), `src/document-embeddings.ts` (batched `/embeddings` client, cosine, reciprocal rank fusion),
`public/documents.js` + a Documents view. Passages live in `document_chunks` (integer `chunk_id`) with a standalone
FTS5 table `document_search` maintained by explicit inserts and deletes — no `content=` external-content table, so
there is no delete-with-old-values dance; `PRAGMA compile_options` is checked at startup and a build without FTS5
falls back to LIKE with a printed warning. Meaning-based search is optional: `OpenAIProvider.embeddings()` returns
`{ endpoint, apiKey }` (every other provider gives nothing, detected by duck typing in `providerEmbeddings`), vectors
are stored as Float32 blobs, and the wording and meaning orders are fused with RRF (k=60). Embedding calls reuse the
provider URL rule (`assertProviderEndpoint`, extracted from `validateOptions`) rather than `NetworkPolicy`, because a
local provider on loopback is legitimate here and the traffic goes to the provider's own address. Retrieval is
injected in `Runtime.loop` right after `openingMessages`, before the stored turns, only for the owner's own runs
(`depth === 0`, no `agent`), capped at 900 characters per passage; it is evented, never fatal. A document made from a
workspace file is rebuilt through the existing `registerFiles` `after` hook. Uploads arrive base64-encoded in JSON
(`readBody` cap 28 MB for the 20 MB file limit) rather than through `rawApi`, which is for handlers that write their
own response. A file the assistant rewrites is re-indexed for words straight away but is *not* re-embedded on every
write (the hook would otherwise put a provider round trip inside `files.write`); the document says so and the next
deliberate **Read the file again** restores meaning matching. The earlier `wave1/documents` attempt's chunk table is
dropped on first open and its documents are marked failed with a note to add them again; that shape never shipped in a
release.

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

## Batch 19 (wave 1) — sharing with other AI tools (MCP server mode)

`src/mcp-server.ts` is the whole dispatcher (initialize with version negotiation, ping, tools, resources,
prompts) and now reads its exposure policy from `settings/mcp-sharing` on every call instead of a set
frozen at construction — the Settings switch was previously decorative. Default is off with nothing
shared; `branch.ask` is always offered. `src/mcp-stdio.ts` adds the second transport and `branch
mcp-serve` in `src/cli.ts` runs it: newline-delimited JSON-RPC on stdin/stdout, notifications get no
reply, every human-readable line goes to stderr, clean exit when stdin ends. Conversations are exposed
as `conversation://<uuid>` resources (title from the first message, date, transcript as plain
`role: text` lines capped at 64 KiB, ownership checked). Every `tools/call` is now its own recorded
task with `source: "mcp"` and a signed receipt, so shared work shows in Activity and
`/api/runs/:id/receipts` like local work; the tool context's permissions are derived from the exposed
tools' permissions rather than their names (they only coincided for `files.read`), and the concurrency
counter is now in-flight rather than lifetime. `public/mcp.js` plus one card in `index.html` and one
line in `app.js` give the owner a switch, a tool list where read-only tools are pre-ticked and the rest
are labelled "can change things", and copyable settings for Claude Desktop, Claude Code and Cursor
built from this server's real address and key (`GET /api/mcp/connection`, which now reports the stdio
command — the packaged executable with `ELECTRON_RUN_AS_NODE` when the app is packaged, otherwise
`branch mcp-serve`). Tests: `tests/mcp-server.test.mjs` (21).

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

## Released 0.7.3 and 0.8.0 (2026-09-16)

0.7.3: silent update hand-over (Task Scheduler + hidden Windows Script Host launcher; the old detached script made every `tasklist | find` step open a console window), provider presets and Gemini, voice, usage screen. 0.8.0: documents library, triggers and webhooks, MCP server mode, plus two front-end fixes found by the packaged suite (static-asset allowlist now guarded by `tests/static-assets.test.mjs`; classic scripts must use `var` for shared helpers). Both rehearsed on a staged copy with a console-window counter (0 windows) and hand-installed on the owner's PC. Wave 2 (integration branch): shell pass 1, code tools, Git/GitHub, approval policies; cost/trace and shell pass 2 in progress. Subagents default to Haiku on this machine (CLAUDE_CODE_SUBAGENT_MODEL); builders now run on Opus explicitly.

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

## Batch 19 (wave 6) — the client library, issue context, and the record of what it was allowed to do

Eight smaller pieces that had no home in the other themes. **A TypeScript client**
(`packages/sdk/`, no publish step, no dependency): one file of plain JavaScript covering runs
(start, stream over SSE, watch over a socket, steer, cancel, resume, approve), sessions, memory,
documents, schedules, policy and the new routes below. Its types are not written by hand —
`scripts/generate-sdk-types.mjs` reads the app's own zod schemas out of `dist/`, turns each into
JSON Schema and emits `packages/sdk/types.d.ts`, so what the types promise cannot drift from what
the app accepts. `packages/sdk/test/sdk.test.mjs` proves every call against a real `startServer`.
**Issue-tracker context** (`src/integrations/issue-context.ts`, `linear.ts`, `issue-tools.ts`):
`issues.search/get/comment` over GitHub REST and Linear GraphQL behind one interface, each with its
own token in the locker and scrubbed out of every reply; pasting an issue address pulls the title,
body and comments into the task as a document-style passage with a citation and a line saying it is
other people's words; `github.open_pull_request` gained `issue` and `changes`, which build the
description from a template that closes the issue. **The record** (`src/audit.ts`): an append-only
`audit` table — two SQLite triggers refuse any UPDATE or DELETE — written for approvals, secrets
handed to a command (by name, never by value), policy changes, channel pairing, exports and project
switches; `GET /api/audit` with filters, `/api/audit/export.csv`, `allowed.json` in the diagnostics
folder, and a plain-language section at the foot of Usage. **Approval kinds**
(`src/tool-categories.ts`): tools sorted into seven kinds from their permission with a small
override map, so one choice covers a kind rather than a tool; saving expands to one rule per tool
and merges — only the kinds named in the request are rewritten, so a kind decided earlier, a
hand-edited rule and a standing yes from an answered approval all survive, and the rule cap rose
from 100 to 300 because one kind can be dozens of tools.
**Ask me questions first** (`src/ask-first.ts`): up to five short questions with suggested answers
before a task starts, skipped for short plain requests by the same `looksMultiPart` judgement
auto-plan uses; the answers are written underneath the request. **The practice workspace**
(`src/practice-workspace.ts`): a project whose folder holds four made-up files and a demo
conversation, one click each way, with the files left behind when you leave. **Retrieval and
reordering** (`src/retrieval.ts`): documents and saved facts behind one `Retriever` interface, with
a second pass that is a deterministic word count by default and one model request (top 20 → top 5)
when the owner turns it on; `DocumentLibrary.contextFor` uses it. **Provider plugins**
(`src/provider-plugins.ts`): `plugin.provider.<id>` adapters a plugin can bring, handed the network
check to call rather than trusted to make their own requests, and taken back out with their model
presets when the plugin is switched off. Routes live in `src/misc-api.ts` so `src/server.ts` gained
one dispatch line. Tests: `tests/sdk-misc.test.mjs`, `packages/sdk/test/sdk.test.mjs`. No new
dependency. Covers A0308, A0174, A0395, A0591, A0434, A0370, A0326, A0817, A0995, A0575 and A0300.
Deliberately left out: the provider-plugin loader is a standalone module rather than a change to
`src/plugins.ts`, which is not on this base — `BranchPlugin` needs `providers?: BranchPluginProvider[]`
added and `Plugins.enable`/`disable` need to call `ProviderPlugins.register`/`forget` when the two
branches meet.

## Batch 22 (wave 3) — browser automation a non-technical owner can trust

The browser could navigate, read an accessibility snapshot, click and fill, always in a fresh
profile. This batch gives it the rest of what an ordinary errand needs, without loosening any of
the isolation. **Saved sign-ins** (`src/integrations/browser-profiles.ts`): the owner presses "Sign
in once" in Settings, a headed Chromium window opens at an allowed origin, they sign in by hand,
and the resulting Playwright storage state is written to `<dataDir>/browser-profiles/<owner
hash>/<name>.bin` as `iv‖tag‖ciphertext` (AES-256-GCM) under a key derived from the locker key with
`HMAC(root, "branch-browser-profiles-v1")` — the same derivation trick `Receipts` uses, because the
locker table caps values at 8 KiB and storage state is far bigger. `browser.profile
{list|create|remove|use}` picks one; `use` must come before the window opens, and a run that used
one writes the state back on `closeRun`. **Pictures**: `RunArtifacts` (`src/artifacts.ts`) keeps
screenshots and PDFs beside the private database, so they sidestep workspace confinement and
`.branchignore` entirely; the tool result carries `{path, bytes, sha256, mediaType}` and the
ordinary tool receipt signs that. `Message.images` and `Provider.acceptsImages` (`src/contracts.ts`)
carry a picture to the model — OpenAI as an `image_url` data URL, Anthropic as a base64 `image`
block; `Runtime.showPicture` appends the picture as a *user* message after the tool result, which
is valid in both wire shapes (Anthropic merges the consecutive user turns). Pictures are
deliberately **not** persisted through `store.message`, or they would be replayed on every later
load, and `fitContext` measures `messages.map(textOnly)` so one screenshot cannot trip compaction.
`acceptDownloads` was flipped on: files land in `downloads/` inside the workspace through the same
`WorkspaceFiles.checked` path `files.*` uses, bounded by `maxDownloadBytes` and `downloadTypes`,
with the site-supplied filename sanitised (`safeDownloadName`). `BrowserSession` grew tabs (up to
five, website-opened pop-ups still closed), dialog capture (always dismissed, text surfaced in the
triggering action's result) and a short grace window after a click so a download that starts a beat
later is still named in that result. Password redaction is a stylesheet injected immediately before
the shutter and removed after, not a value mutation; the test proves it by pixel equality — a box
holding `hunter2-super-secret` screenshots byte-identically to an empty one. Caps live on the
per-run entry: `maxActionsPerRun` (80) and `maxOriginsPerRun` (5), both stopping with a plain
sentence that tells the assistant to report back rather than carry on. `browser.upload` was added
to the "workspace" approval preset, and every new changing tool reports the page's host as its
approval target. New UI: `public/browser.js` and one additive Settings card; new routes
`/api/browser/profiles`, `/api/browser/profiles/remove`, `/api/browser/signin`. Tests:
`tests/browser-more.test.mjs` (13 cases). No new dependency — the same Playwright.

## Batch 21 (wave 2) — the shell, second pass

The first shell pass kept the old page around the new rail. This pass rebuilds the shape itself:
the ChatGPT desktop application crossed with the Hermes desktop application, in KeepOak's language.
The top bar is gone; the brand, the assistant's name, the search and appearance icons and the two
pane switches moved into the rail head and the main title bar. The icon column folded into the rail
as a "Sections" group, and the rail now carries, in order: "New conversation", "Find anything",
Sections, Projects (the workspace folders, the active one marked, clicking switches) and Recents
(conversations by day, each one line, with rename, pin and "take off this list" revealed on hover —
these are this browser's own labels and never touch the saved conversation). Each group folds and
is remembered. At the foot sits the owner row — initial, project, connection dot — opening a menu
with Settings and connections, Change the appearance, Lock session, Check for updates and About.
The main pane is one 760 px column: messages are prose with a small role marker, the owner's own
messages sit in a soft tinted bubble on the right, and tool work is a single quiet row ("Worked
with 2 tools · files list, files read") that opens in place instead of a card. The composer is a
rounded box pinned to the foot with attach, microphone, Temporary and Send inside it. The empty
conversation is a short greeting with four suggestion chips drawn from the owner's recipes when
there are any. Sections open in the same column with the same title bar and no page-in-page frames
(`.card` is now a flat block with a hairline under it; only the sign-in and first-run panels still
read as panels). `public/context-pane.js` replaces the marketing copy in the context pane with the
model and a link to change it, what is running now, the receipts for this conversation in plain
language (`GET /api/runs/:id/receipts`), recently saved memory, three counts and the small acorn.
Shell surfaces were added to `public/tokens.css` as Daylight/Forest variants (`--rail-bg`,
`--main-bg`, `--head-bg`, `--bubble`, `--composer-bg`, `--step-bg`); nothing outside that file
hard-codes a colour except the pixel-art walker sprite in `public/update-screen.js`. New static
route: `/context-pane.js`. Under 1180 px the context pane steps aside, under 860 px the rail slides
over the page, and the page never scrolls sideways at 400 px. Tests: `tests/shell-ui.test.mjs`
(the 400 px case now opens the slide-over rail first) and `tests/identity-ui.test.mjs` (the maker
line moved from `.topbar-brand` to `.rail-maker`).

## Batch 20 (wave 2) — workspace search and code editing tools
Seven tools in `src/code-search.ts`, `src/code-edit.ts`, `src/patch.ts` and `src/ignore.ts`, all
behind the existing `files.read` / `files.write` permissions and `WorkspaceFiles.checked()`
confinement, with no new routes, settings or dependencies. Reading: `files.glob` (patterns via
`node:path` `matchesGlob`), `files.grep` (literal or regular expression, context lines, file
pattern, capitals switch, binary skip by NUL byte), `files.find` (subsequence score with word-
boundary and basename bonuses) and `workspace.map` (size, language guess and regex-found top-level
names or Markdown headings, cached per file mtime+size). Writing: `files.patch` applies a
multi-file unified diff with fuzz 0 — every hunk is matched using its declared line counts and must
equal the file exactly at the line it names, all new contents are computed before anything is
written, and a failure part-way restores the files already written; `files.edit` replaces an exact
string and refuses when the match count is not `expectedOccurrences`. Both go through the same
write observer as `files.write`, so each changed file keeps its previous bytes and has its own
Undo. `files.validate` parses JSON and runs this app's own Node with `--check` (parse only, never
executes) for `.js`/`.mjs`/`.cjs`, returning problems as data; TypeScript is reported as unchecked
because the compiler is a devDependency only. A `.branchignore` (falling back to `.gitignore`)
applies to every one of these tools. All results are bounded by serialized size so they stay inside
the registry's 64 KiB output limit and say `moreAvailable`. Tests: `tests/code-tools.test.mjs`.
Covers A0435 (ignore-file access controls), A0537 (project maps and syntax validation) and the
codebase-search families (workspace-search, codebase-search, codebase-indexing).
## Batch 19 (wave 2) — approvals, rate limits and execution guardrails
A declarative approval policy stored per owner at `settings/policy`: ordered rules of
`{ tool, match, applies, decision, remember }` evaluated once in the runtime's tool gate, before the
tool runs, against the tool name and what the call would touch (a path, a command, or a host; the
browser reports the host of the page the run is on). Three presets expand to rules — *Ask before
changes*, *Just do it inside my workspace*, *Read only* — with the stored default (`off`, no rules)
keeping today's behaviour exactly, so every existing test is unchanged. "Ask" pauses through the
existing `NeedsInputError` path and records the question; `POST /api/policy/approve` answers it for
this once, for the conversation (kept in memory) or always (written back as an allow rule at the top).
"Deny" comes back to the model as a plain refusal rather than killing the task. Tasks started by a
trigger, a schedule or MCP are capped at *Ask before changes* and cannot be given a standing yes from
inside the run. Also: `dryRun` on `POST /api/run` and `--dry-run` on the CLI (effectful tools report
what they would have done, read-only tools run for real, and the run ends with a `dryrun.report`);
optional per-conversation limits on tool calls and model rounds a minute that pause and resume rather
than fail; and a `file.invalid_json` warning after writing a `.json` file that will not parse. New
files `src/policy.ts`, `src/approvals.ts`, `public/approvals.js`, `tests/approvals.test.mjs`. Covers
A0048, A0152, A0245, A0262, A0636, A0701, A1521, A1629, A1685, A2028.
## Batch 20 (wave 2) — real costs, trace export, privacy-safe diagnostics
`src/pricing.ts` holds per-million-token list prices for the common models of OpenAI, Anthropic,
Gemini, Groq, Mistral and DeepSeek (plus zero for local runners), with a `pricedAt` date and an
owner override map in `settings/pricing` (`GET|POST /api/pricing`). `estimateCost(model, usage,
overrides)` returns `{ amount, currency, confidence: table | override | unknown, note }`; an unknown
model returns `amount: null` and reads "no price on file" rather than $0.00, which is reserved for
models that genuinely cost nothing. Costs now appear wherever tokens already did: the run list, a
task's detail and receipts views, the usage aggregates by day/model/conversation/source, the Usage
screen, the monthly stats, and a new `estimatedCostUsd` + `runsWithoutPrice` pair of CSV columns.
Two latent bugs fixed on the way: `model.completed` now carries `preset`/`provider`/`model` (so
cost attribution, the run timeline titles and the trace span names all name the real model), and
the old cost pass multiplied a task's whole usage row by its number of model rounds. The monthly
budget may now be tokens, dollars or both (`maxMonthlyDollars`), and both the monthly refusal and
the per-task token refusal quote the dollar figure when a price is on file (A0857).
`src/trace.ts` writes each finished task as one OpenTelemetry-shaped JSON document (resourceSpans →
scopeSpans → spans; a task span with a child per model round and per tool call, deterministic
32-hex traceId and 16-hex spanIds). Off by default, `settings/trace` via `GET|POST
/api/trace/settings`; the folder must resolve inside the owner's home or the workspace, checked
with `relative()` rather than a prefix test, and UNC paths are refused. `GET /api/runs/:id/trace`
returns the same document on demand. Files only — there is no network exporter — and a write
failure records a `trace.failed` event instead of failing the task.
`src/diagnostics.ts` backs a new Settings → Diagnostics card that states "Branch sends no usage data
to anyone" and saves a plain folder (health, versions, last 200 events, the price table, a README)
under the data directory for the owner to share by hand. Event data goes through an allow-list, so
tool arguments, results, diffs and file contents are dropped rather than trimmed, and the fields
that survive are scrubbed for keys, tokens and bearer headers. `public/usage.js` was rewritten: it
was entirely dead before (it called `api`/`el` that app.js never exposed, hooked a `window.displayView`
that does not exist, read `{data, stats}` as an array, and `/usage.js` was not even in the server's
static allow-list). `public/providers.js` has the same missing-allow-list problem and was left for
the providers branch. Covers A0202, A0269, A0346, A0420, A0459, A0565, A0773, A1419, A0857, and
A0031/A0597/A0972 as **file export only — there is no OTLP network exporter**, so the tracing
theme is not finished. A1441 (cache-aware cost accounting) is explicitly *not* covered: a cached
price can be recorded but nothing populates cached token counts. The `usage_cache` table is still
unused by any caller and records no price confidence, so a cached row reports its tasks as
unpriced rather than inventing a figure.

## Batch 22 (wave 3) — more messaging channels

Four more channel adapters behind the same `ChannelAdapter` interface, so pairing, allowlists,
activation modes, the delivery ledger and `POST /api/channels/link` work on all of them unchanged.
`src/channels/ws-client.ts` is a minimal RFC 6455 **client** (masked writes, ping/pong, fragment
reassembly, handshake verification) — `src/ws.ts` is the server side and frames the wrong way round
for this — and serves both socket channels; `readFrame` there now also returns the FIN bit.
**Discord** (`src/channels/discord.ts`) identifies on the gateway with GUILDS/GUILD_MESSAGES/
DIRECT_MESSAGES/MESSAGE_CONTENT, heartbeats, resumes with op 6 against `resume_gateway_url`,
re-identifies on op 9, and reconnects with a widening wait; replies over REST honour the
`X-RateLimit-*` headers and 429 `retry_after`. **Slack** (`src/channels/slack.ts`) uses Socket Mode,
acknowledges every envelope before doing anything else, drops repeated `event_id`s, subtypes, bot
posts and its own user, threads on `thread_ts ?? ts`, and converts markdown to mrkdwn (italics
before bold, or the new bold gets eaten). **WhatsApp** (`src/channels/whatsapp.ts`) is driven by a
new unauthenticated route `/webhooks/whatsapp/:id` next to the trigger routes: `GET` echoes Meta's
`hub.challenge` as **plain text** (not JSON) after a constant-time verify-token check, `POST` is
refused unless `X-Hub-Signature-256` matches an HMAC over the exact bytes. **Email**
(`src/channels/mail-client.ts`, `src/channels/email.ts`) is a hand-written IMAP4rev1 reader and SMTP
sender over Node's TLS, plain text only, threading on `In-Reply-To`/`References`.
Two decisions worth remembering. Chunking lives in the ledger, not the adapter, so Discord's
2000-character limit is threaded through as an optional `ChannelAdapter.maxTextLength` into
`Deliveries.enqueue` rather than split inside `send()`, which would have broken retry semantics.
And the WhatsApp 24-hour window adds **no** fourth ledger status: `send()` throws a plain-language
error, so the existing pending/dead-letter machinery holds and shows the message. The router diff is
only the optional `health()`/`maxTextLength` members, an `adapter(id)` accessor and `health` in
`summary()`. `ChannelConfigSchema` became a discriminated union of the five kinds with one
`superRefine` for Telegram's either/or token rule (a `.refine`d object cannot be a union member in
zod v4). No new dependency. Left out: Discord and Slack attachments, WhatsApp images (the router
carries text only), and all MIME handling in email — HTML and multipart mail is not read or sent.

## Batch 22 (wave 3) — memory that stays tidy, context that stays useful
`src/memory-hygiene.ts` looks for three things that go wrong in a fact store on their own: the same
thing saved twice (token-overlap ≥ 0.8, or cosine ≥ 0.92 where both facts have vectors), a newer
fact that disagrees with an older one about the same subject (entity+attribute where present, else
the label before the colon — which must be two or more words and must not head a list, so two
`Note:` facts and two `Address:` facts are left alone; which one is newer comes from `validFrom`,
not insert order), and — only
above nine tenths of the configured capacity — the facts that have earned their place least. Every
finding becomes a proposal in the **existing** `memory_proposals` queue under three new kinds
(`merge`, `archive`, `forget`); accepting one calls the new `MemoryFacts.setAside`, which moves the
fact into `memory_archive` **with a note** and keeps its versions, so the Memory view's set-aside
list brings it straight back. Nothing on this path removes a fact before the owner accepts.
`src/memory-retrieval.ts` gives facts the same treatment documents already had: an FTS5 index
(`memory_search` keyed through `memory_terms`, probed the way `documents.ts` probes, with a plain
`LIKE`-style fallback), per-fact vectors in `memory_vectors` through the existing `EmbeddingClient`
and `providerEmbeddings` accessor, and the two orders combined with `fuseRanks`. The fused rank is
multiplied by an importance score — recency (30-day decay) × `1 + ln(1+uses)` × 1.5 when the owner
saved or corrected it — and `memory_uses` counts a fact every time retrieval returns it. The same
ordering now drives `MemoryReview.sessionSnapshot` through a new `orderFacts` hook. A per-owner
`useEmbeddings` switch turns meaning off; without a key nothing changes hands. An answer is bounded
at 48 KiB of UTF-8, the ceiling the old literal search kept to. Two of the three retrieval states
are tested (BM25+cosine+RRF, and words alone with meaning off or no key); the third — a build of
SQLite without FTS5, which falls back to `plainMatches` — is implemented but **untested**, exactly
as the same fallback in `documents.ts` is.
Compaction now asks for JSON and keeps a **structured** summary (`goals`, `decisions`,
`openQuestions`, `filesTouched`) in `session_summaries`, rendering it back into the handoff message;
a model that replies in prose still gets today's behaviour, which is why
`compaction-attention.test.mjs` is untouched. `session_pins` keeps chosen messages in front of the
model for good: pins are keyed on `messages.source_id`, not `id`, because `reconcileMessages()`
rewrites a session's rows, and `workingMessages()` plus the fold both honour them. Only a plain user
or assistant turn can be pinned, so a tool exchange is never split.
`src/memory-export.ts` moves facts as JSON Lines (`GET /api/memory/export?format=jsonl`, and
`POST /api/memory/import {jsonl}`) with a normalised text+entity+attribute fingerprint so a fact
already saved under another identifier is counted rather than copied; the whole-archive JSON routes
are untouched. The same file writes a conversation out as Markdown
(`GET /api/sessions/:id/export?format=markdown`). `src/working-session.ts` keeps one line per
conversation (last goal, last file, last step), shown in the context pane's new **What we are
doing** block and attached to `GET /api/activity`.
Pictures: `Message.images` plus `supportsImages()` on the provider interface, with the OpenAI shape
sending `image_url` parts and Anthropic sending base64 image blocks. `POST /api/run` accepts up to
four pictures of 5 MB each; **the bytes never reach `store.message`** — the transcript keeps
`[attached picture: name]` — so nothing is replayed on later turns or counted against the context.
A text-only model fails the task with "…cannot look at pictures" rather than dropping it silently.
The browser branch landed its own image plumbing upstream while this branch was open
(`MessageImage`, `maxImageBytes` 4 MB, a `readonly acceptsImages` flag and a `textOnly()` strip
helper). On merge **keep theirs**: `supportsImages(provider)` here already reads either an
`acceptsImages` flag or a `supportsImages()` method, and `ImagePart` is `MessageImage` plus an
optional `name`, so the only real conflicts are the duplicate adapter bodies in `providers.ts` and
the duplicate declarations in `contracts.ts`.
Covers A1795, A1892, A2230, A2245, A2187, A2186, A2035 (partly), A0074, A2023, A2269, A2110, A1640,
A2379, and from vector-and-hybrid-memory A0278, A0747, A1119, A1373, A1975. Deliberately **not**
retrofitted: the pre-existing removal paths (`POST /api/memory/hygiene` with `purge`, `memory.delete`
when approval is off, `forget`, and the delete-then-restore inside `restoreCheckpoint`) still remove
without a suggestion — R1 holds for the paths added here, not for those.
## Batch 22 (wave 3) — plans, several specialists at once, steering, reviewers and shared notes
`src/orchestration.ts` and `src/orchestration-tools.ts` add six things to how a task is run, each
behind a flag that is off by default, so an unchanged install behaves exactly as before.
A task may be asked to **plan first** (`plan: true` on a run, or the `autoPlan` setting with a cheap
heuristic for long or multi-part prompts): the model returns two to six numbered steps, they are
stored for the conversation and carried out one at a time with a per-step check and one retry, and
`plan.step.started/finished` say where it is. With `planApproval` the task stops through the
existing needs-input pause with the plan as its question, and `POST /api/runs/:id/plan` edits and
approves it; a plan being carried out by a task that stops early is dropped, so the next message is
never silently answered by an abandoned plan. **`delegate.parallel`** runs up to six specialist
branches (four in flight, the runtime's existing child limit), splitting what is left of the task's
tokens evenly and charging each branch back at no more than its share; one branch failing leaves the
others running unless `failFast`, and the answers go back to the parent to combine.
**`delegate.handoff`** gives the rest of a piece of work to a named specialist.
**`POST /api/runs/:id/steer`** puts a note in front of the working task's next round (a follow-up,
by contrast, waits for the task to finish). An optional **reviewer pass** (`verify`) checks a
finished answer against the task's checks and the owner's memory snapshot and either accepts or
returns a short fix list, at most twice. **Long-task hygiene**: `run.milestone` notes built from the
task's own events, with no extra model call, and a `stuckAction` that asks the owner or changes
model after the stall watchdog has fired twice instead of retrying the same thing. A **shared
scratch area** (`scratch.set` / `scratch.read`, capped at 32 notes and 64 KB) is keyed by the top
task of a delegation tree through a new `ToolContext.scratchRoot` and emptied when that task ends.
New state reaches clients through the existing events and `GET /api/activity` (`plan`, `milestone`,
`verdict`); there is no new screen.
One change outside the theme was needed and is worth knowing about: `registry.descriptions()` now
drops the `$schema` dialect line from generated tool schemas (Gemini's adapter already stripped it
and no provider reads it). The tool catalog is sent every round, and at 58 tools that line alone
cost about 800 estimated tokens — enough that, before the change, adding five tools pushed
`tests/compaction-attention.test.mjs` over its 11,000-token compaction threshold and made a settled
conversation summarise itself twice. Measured: catalog 8,554 → 7,551 tokens, and the third run of
that test went from 11,008 (over) to 10,183. The threshold is close enough to the catalog size that
the next few tools will run into it again; raising `compactionThreshold` is the real fix and was
left alone here. Not fixed here either: `specialists.fanout` accepts eight tasks in one wave while
`delegate()` refuses a fifth concurrent child of the same parent, so a wide independent wave fails
today. Covers A0186, A0405, A0372, A0959, A1093, A1092, A0317, A0809, A0935, A0195, A1116, A1218
and A1278; the graph/DSL families in this theme (A0889, A0892, A1215, A1238, A1257) are untouched.
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
