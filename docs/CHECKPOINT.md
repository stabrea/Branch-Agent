# Branch Agent checkpoint — 2026-09-15 (late evening)

## Batch 23 (wave 5) — pictures, sound and what a video says about itself

`src/media-images.ts` holds the picture clients and the one refusal that matters: `providerImages(provider)` asks a connection whether it has a picture-making route, and a connection that does not gets a plain sentence (`noImageEndpoint`) instead of a stack trace. `OpenAIProvider.images()` and `GeminiProvider.images()` return `{kind, endpoint, apiKey, defaultModel}`; `AnthropicProvider.images()` returns null. The OpenAI shape is asked at `/images/generations` (JSON, `response_format: "b64_json"`) and `/images/edits` (multipart, the source picture and an optional mask as files); Gemini is asked at `/v1beta/models/<model>:generateContent` with `responseModalities: ["IMAGE"]` and the source picture riding along as `inlineData`. Addresses are joined the way `src/providers.ts` joins them (`endpoint.replace(/\/$/,"") + path`), so a provider address that carries a path still works, and every one goes through the shared `NetworkPolicy` first. A provider that answers with a link rather than the picture is refused rather than followed.

`src/media.ts` (`MediaTools`) registers seven tools. `media.image` makes or changes a picture, writes it through `RunArtifacts` beside the private database, and — only when the call names a file — also saves it into the workspace media folder; the result is the artifact descriptor at the top level (`path`, `bytes`, `sha256`, `mediaType`), which is exactly the shape `RunArtifacts.imageIn` recognises, so a made picture can be shown back to the model, plus the model, size, prompt and a cost estimate. `media.describe` (describe, read the words, write out a table) and `media.compare` build real `ImagePart`s through `parseImages`, so the 5 MB and four-picture caps and the allowed kinds are the same ones an attached picture obeys, and both refuse before reading anything when the connected model cannot see. `media.transcribe` posts a workspace sound file to the provider's `/audio/transcriptions` with `verbose_json` and `timestamp_granularities[]` when times are asked for, and says plainly when a provider sends none. `media.speak` reuses `generateSpeech` from `src/voice.ts`, which gained an optional `{voice, model}` argument (default behaviour unchanged). `media.trim` cuts WAV in plain JavaScript — `src/media-audio.ts` walks the RIFF chunks, snaps both ends to `blockAlign` and writes a fresh 44-byte header — and turns down MP3, M4A and OGG in words rather than half-handling them. `media.info` (`src/media-video.ts`) walks MP4 boxes, reads `mvhd` in both of its versions for the length, counts `trak` boxes and reports the `ftyp` brand; it answers for WAV too.

**Deliberately absent: `media.frames`.** Pulling a still out of an MP4 needs a video decoder this app does not ship, so no tool pretends to. `videoLimits` is one sentence stated in the tool description, in the result of every `media.info` call, in the Settings card and in the docs: no video generation, no frame extraction, but the length and shape of a file can be read. A test asserts `media.frames` is not registered.

Permissions: `media.read` (describe, compare, transcribe, info) is added to `readOnlyPermissions` in `src/policy.ts` so looking at a picture is not treated as a change; `media.write` (image, speak, trim) is held to the owner's approval rules like any other change, and honours `dryRun`. `policyTarget()` only reads a top-level `url` or `path`, which `media.image`, `media.speak` and `media.compare` do not have, so each of them carries its own `target()` returning the workspace path it would write (`MediaTools.savePath()` folds in the owner's media folder) or the picture it would read — without those a rule like `{tool: "media.*", match: "media/*"}` would silently never fire. Every workspace read goes through `WorkspaceFiles.checked()` and then `O_NOFOLLOW`, with a 32 MB cap; workspace writes re-check the path after creating the folder. Results carry only descriptors, never bytes, so nothing approaches the registry's 64 KiB tool-result cap.

Settings and routes: `src/media-settings.ts` stores the picture model, the workspace folder and per-picture price corrections in `settings/media` (`GET|POST /api/media/settings`); the built-in per-picture table is separate from `src/pricing.ts`, whose strict token-denominated schema is untouched. It was read for one 1024×1024 picture, so `estimateImageCost` takes the size and reports no amount at all for any other one, and an unlisted model reports `unknown` rather than a made-up zero; an owner's own price is used at every size. `RunArtifacts.list()` was added (a folder listing, no file opened, no checksum) behind `GET /api/artifacts?type=image`, and `GET /api/artifacts/file?path=…` serves one picture's bytes — only paths the listing itself produced, only `image/*` and `audio/*`, under `default-src 'none'; sandbox`.

UI: a new `public/media.js` adds a picture button and drag-and-drop to the message box. Pictures become removable chips and ride on the next `POST /api/run` as `images` (the existing field; `RunInputSchema` is unchanged); a dropped sound file is written out through `POST /api/voice/transcribe` and the words are put in the message box so the person can read them before sending. `public/app.js` gained five lines: four to pass the chips along and clear them, and one to switch the picture button off while a task is working, because a message sent then becomes a follow-up and a follow-up carries words only — a chip that could never travel would be worse than no chip. The Documents panel gained a "Made by the assistant" card and Settings a "Pictures and sound" card. `public/shell.css` and `public/shell.js` were not touched; the small amount of new CSS is appended to `public/style.css`. There is no open-in-folder, because no such bridge exists and desktop code is out of scope for this branch — the full path is shown with a copy button instead.

Tests: `tests/media.test.mjs` (11) run `node:http` fakes and assert the generate request's route, body, size and `b64_json`; the edit request's multipart content-type and field names; Gemini's route and `responseModalities`; the refusal when the connection has no picture service; that describing sends a real image part and that a text-only model refuses before any file is read; that a WAV trim produces a valid RIFF file of exactly the right byte length and that an MP3 is turned down; that a synthetic MP4 built box by box reports six seconds, two tracks and the `isom` brand; that a picture posted to `/api/run` reaches the provider as an image part and that the gallery routes list and serve it while refusing anything outside the artifacts folder; that each media tool hands the approval rules a real target; that a headless page turns an attached picture into a removable chip the next message would carry; and that the settings route saves and validates. Items done: A1996, A2025, A2083, A2106, A2184, A2294, A2321, A2368, A0888, A1995, A1893, A1894, A2173.

## Batch 23 (wave 5) — using this computer's screen and keyboard

`src/integrations/desktop-config.ts` holds the settings (`desktop-control`: `enabled` false out of the box, `maxActionsPerRun` 40), every zod input shape, the refusal lists and the two small translators: `refusalFor()` matches a window's *resolved* title and program name against password managers and the Windows sign-in surfaces, `keyChord()` turns "ctrl+shift+f5" into SendKeys form from a closed list of keys and refuses anything else, and `secretReferenceIn()` refuses text that still holds a `{{placeholder}}` or an environment-variable reference. `src/integrations/desktop-script.ts` carries one Windows PowerShell script as a string; `DesktopScriptRunner` writes it once into a private `mkdtemp` folder, calls it with `-File` and a base64 payload argument (so nothing the model writes ever reaches a command line) through the existing `ShellProcess` runner, and reads back one line of JSON. The script loads `UIAutomationClient`, `System.Drawing` and `System.Windows.Forms` and adds a small `user32` P/Invoke class; window pictures use `PrintWindow` with a `CopyFromScreen` fallback, reading a window walks the UI Automation control view breadth-first, clicking prefers Invoke then Toggle then SelectionItem then ExpandCollapse and only then a real mouse click, and typing prefers `ValuePattern.SetValue` — verified working against Windows 11's Notepad — falling back to `SendKeys` only after checking the target really is the foreground window. `src/integrations/desktop-banner.ts` runs a second, long-lived PowerShell process showing an always-on-top 460×52 WinForms notice titled "Branch is using your screen" with a red **Stop** button; pressing Stop ends that process, and its exit is what Branch hears. `src/integrations/desktop.ts` (`DesktopControl`) is the gate: it re-reads the switch before every action, keeps a per-run action count cleared through `registry.onRunFinished`, raises the notice, combines `context.signal` with its own controller so both `POST /api/runs/:id/cancel` and Stop cut the child process off, resolves a window by title (refusing an ambiguous match and any restricted one), retries once when a program rebuilds its window mid-action, refuses a whole-screen picture while a password window is showing, writes a `desktop.action` event naming the window for every action, and keeps screenshots as ordinary run artifacts so the runtime shows them to models that accept pictures. `src/integrations/desktop-tools.ts` registers eight tools under `desktop.view`, `desktop.control` and `desktop.clipboard` — none added to `readOnlyPermissions`, so "Ask before changes" asks about every one of them with no change to `policy.ts`. Tools are registered whether or not the switch is on, so the assistant is told why rather than silently losing them. Routes `GET`/`POST /api/desktop/settings`; `public/desktop.js` and a Settings card drive them. No new dependency. Tests: `tests/screen-control.test.mjs` (9) — the switch is off by default and all eight tools refuse with the same sentence; switching it off part way through a task stops the next action too, proving the setting is re-read rather than cached; "Ask before changes" stops a real run for a `desktop.view` tool and again for a `desktop.control` one, each with a `policy.ask` event naming the tool and no screen contact; a Notepad window the test opened itself is listed, read (its `Document` control found by name), typed into through UI Automation and read back, photographed as a real PNG artifact and closed; the notice is listed and photographed, and Stop makes every later action refuse; the per-run cap bites on the third action; a window the test created wearing the name "Bitwarden" is refused for pictures, typing and clicking, and refuses the whole-screen picture with it; a headless-browser check that the Settings card opens unticked and that ticking it is what writes the setting; the refusal lists, key names and placeholder checks are unit-tested. Every window the tests touch is one they opened, and each is closed in `t.after`. Items done: A0230, A1450, A2043, A2311, and A1465/A2278 for the permission switch. Named deviation: the file is `tests/screen-control.test.mjs`, not `desktop-automation`, because `tests/desktop*.test.mjs` is the Electron suite that must not run.

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

## Batch 23 (wave 4) — talking to assistants other people built

Branch could be used by other AI tools over MCP; now it can also be one agent among several.
**A2A server** (`src/a2a.ts`, `src/a2a-routes.ts`): `/.well-known/agent.json` publishes a card —
name, address, `bearer` auth, streaming, and skills taken from the list the owner already ticked
for sharing, plus `branch.ask`. `/a2a` takes JSON-RPC `tasks/send`, `tasks/sendSubscribe` (SSE
frames carrying one state update per recorded step, then the artifact, then a `final` update),
`tasks/get` and `tasks/cancel`. Every task is an ordinary run with `source: "a2a"`, an `a2a.task`
event naming the caller, and the usual signed receipts. The switch is `a2a` inside the existing
`settings/mcp-sharing`; while it is off both routes are 404, not 403. Only text parts are accepted,
one caller gets 20 tasks a minute (`-32003` / HTTP 429), and `RunSource` gained `"a2a"` and
`"acp"` so `cappedPolicy` holds both to "Ask before changes". **A2A client**
(`src/a2a-client.ts`): `agents.remote { add | list | remove }` reads another install's card through
the network policy and saves it; `agents.ask { agent, task }` sends the words of the task and
nothing else, with a 60 s (max 120 s) wait, ten asks a minute per agent, and the answer charged to
the run's budget. `GET /api/agents/discover?targets=…` probes only the addresses the owner types
in — no mDNS, no dependency — and `GET /api/agents/pairing` returns a `branch://add-agent?…` link
the other install redeems with `POST /api/agents/pair`. **ACP** (`src/acp.ts`, `branch acp-serve`):
bidirectional newline-delimited JSON-RPC on stdio — `initialize`, `session/new`, `session/prompt`
with `session/update` chunks, `session/cancel` — and a step that needs a yes becomes an outbound
`session/request_permission` whose answer goes straight to `runtime.approve`. Documented with a Zed
`agent_servers` example. A streamed task that cannot even be created (a busy conversation, a spent
monthly budget) answers with a `failed` final frame instead of leaving a rejection nobody is
watching, a line the editor sends that Branch cannot use is reported and skipped rather than ending
the connection, and saving the sharing screen — which posts only `enabled` and `exposedTools` —
leaves `a2a` as it was. Tests: `tests/interop-agents.test.mjs` (19, including a spawned
`acp-serve`). No new dependency.

Known gap, shared with MCP: `cappedPolicy` returns the policy untouched while the preset is
**No approvals**, which is the default, so a caller is only held to "Ask before changes" once the
owner has chosen an approval setting. `exposedTools` shapes the card's skills, not what a task may
do — `branch.ask` reaches the whole registry. Both are written down in `docs/configuration.md`.

## Batch 23 (wave 4) — skills and plugins people can actually share
Skills were single documents that could only be typed in or fetched from a registry. This batch
makes them shareable objects and opens a documented seam for developers. **Skill packages**
(`src/skill-package.ts`): a `skill/` folder with `SKILL.md`, optional `tools.json` and optional
`hooks.json`, packed into one `.branchskill` file — a zip written with `node:zlib` and read back by
a minimal reader in the same file, so no dependency was added. The manifest carries the name,
version, author, the permissions the package asks for and a SHA-256 of every file; opening it
refuses a package whose files no longer match, and refuses a file the manifest does not list.
`src/skill-packages.ts` installs one only after the owner approves the list, runs the existing skill
scan, and leaves the skill switched off. **Declarative web calls** (`src/skill-http-tools.ts`):
`tools.json` entries become `skill.<name>.<tool>` tools under the new `skills.http` permission.
Addresses go through the existing network policy, `{{secret:NAME}}` header and body values are
resolved from the project locker at the moment of the call, and the result is run through
`scrubSecrets` before it is returned or recorded — the test asserts the secret is in no result, no
event and no message. **Registry v2** (`src/registry-install.ts`): indexes may publish an ed25519
public key and sign entries over a fixed line-by-line payload, so key order in the file cannot
change the signature; entries are labelled `checked`, `unsigned` or `invalid`, an invalid one is
refused, and version 1 indexes still parse unchanged. `GET /api/registry/updates` reports newer
versions with their changelogs, `POST /api/registry/update` adds the new version and switches to
it, and `POST /api/registry/rollback` restores the one that was in use. **Authoring help**
(`src/skill-authoring.ts`): `POST /api/skills/draft-from-runs` proposes one improved version from
several tasks, and `POST /api/skills/:id/test` runs the examples listed under an `## Examples`
heading and reports each one. **Plugins** (`src/plugins.ts`): `<name>.mjs` files in
`<dataDir>/plugins` whose default export declares tools (named `plugin.<id>.<name>`, each needing a
permission the plugin itself declared) and event handlers. Listing the folder loads nothing;
inspecting loads one file, enabling registers its tools and handlers, disabling takes them back
out. There is no sandbox and the docs say so plainly: permission gating and opt-in are the whole
boundary. **Suggestions** (`src/skill-suggest.ts`): `GET /api/skills/suggest` word-matches recent
task prompts against skills the owner has switched off and registry listings they have browsed, on
this computer, with no model call. CLI: `branch skill pack|install` and
`branch plugin list|enable|disable`. UI: `public/skills-extra.js` adds the sharing, updates,
suggestions and plugins cards to the Skills screen. Tests: `tests/skills-plugins.test.mjs`.
## Batch 23 (wave 5) — figures, looking things up properly, watches and the morning brief

Four things a person actually asks an assistant for, all built on what was already here. **Tables**
(`src/data-table.ts`, `src/data-chart.ts`, `src/data-tools.ts`): `data.load` opens a comma, tab,
JSON or spreadsheet file — from the workspace, an address under the network policy, or pasted text —
into a bounded in-memory table (5000 rows, 64 columns, 500 characters a cell) that lives only for
that task and is dropped through `registry.onRunFinished`. `data.describe` gives per-column counts
and spreads, `data.query` runs one read-only `SELECT`/`WITH` against a private `node:sqlite`
in-memory copy, and both hand back a `markdown` field the message column already renders. `data.chart`
writes a bar, line or pie as SVG through `RunArtifacts`, and `data.export` writes `.csv` or `.xlsx`
using Node's own `zlib` — the spreadsheet it writes is read back by the existing `xlsxText`, which is
what the round-trip test asserts. **Research** (`src/research.ts`, `src/research-claims.ts`):
`research.run` plans sub-questions, searches, reads up to twelve pages, keeps the sentences that speak
to the question with their address and title, and from `standard` upwards groups sentences from
different pages by their shared words — two sources stating the same figures become an agreement, a
third stating different figures becomes a reported disagreement rather than a silent choice. The
report goes to `research/<slug>.md` with a numbered Sources list; state is saved after every page, so
a run that hits its budget stops cleanly, writes the partial report and says why, and asking the same
question again carries on. **Watches** (`src/monitors.ts`): `monitor.create` snapshots a page or a
search, later checks diff the lines and describe the change in plain words, and the news goes to a
channel chat or into the conversation list; they run on a new additive `Scheduler.onTick` hook, and one
that fails is retried in an hour without stopping the rest. **Morning brief** (`src/brief.ts`):
schedules due, unfinished tasks, new documents, watches that changed and reminders, assembled through
the existing recipe `substitute()` into an editable template and sent at a chosen local time.
**Citations** (`src/citations.ts`) are shared: research reports and the passages the runtime puts in
front of a task from the document library now carry the same `[1]` numbering and Sources list.
Three silent-failure paths were closed on the way: a watch sends its news *before* it keeps the new
copy, so a delivery that fails leaves the change to be noticed again instead of losing it; a brief
template is checked against the names it can actually fill in when it is saved, because otherwise one
typo would throw on every scheduler beat where nobody could see it; and reports and exports go through
the same write observer the ordinary file tools use, so both keep their previous bytes and have an
Undo. The spreadsheet writer is verified against this app's own reader only — opening one in Excel is
untested. New routes: `GET /api/research`, `GET|POST /api/monitors`, `POST /api/monitors/{id}/check`,
`DELETE /api/monitors/{id}`, `GET|POST /api/brief`, `POST /api/brief/send`. Tests:
`tests/data-research.test.mjs`. One shared change was unavoidable: with fourteen more tools the tool
catalog is about 9.5k estimated tokens, so the old `compactionThreshold` of 11000 left barely 1.5k for
the conversation and a compacted context could never get back under it — it was raised to 14000 and
exported, and `tests/compaction-attention.test.mjs` asserts against the exported value rather than a
literal. (Batch 24 removed the need for that: the catalog no longer counts towards the figure at all,
so `compactionThreshold` went back to meaning the 11000 floor and the live figure is derived each
round. The test was left alone because it still asserts against the exported name.)
Not done: no Firecrawl or Scrapling integration (A0742, A0743) — both need dependencies. Covers A0931
and the research-pipeline and data families listed for those themes.

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
Joined up while merging: `BranchPlugin` now carries `providers?: BranchPluginProvider[]`, and
`Plugins.enable`/`disable` hand them to `ProviderPlugins.register`/`forget`, so switching a plugin
on in the app brings its model connections and switching it off takes them away. Also while
merging: an issue's words go through the same check a web page does (`detectInjection` and the
owner's warn/redact/block setting) before the assistant sees them; the fetch a plugin's provider is
handed checks the address against the network settings itself, so a plugin that forgets to ask is
still held to them; and a spreadsheet cell that would start with `=`, `+`, `-` or `@` is kept as
plain text. `npm test` now also runs `packages/sdk/test`.

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
## Batch 23 (wave 5) — installing, background running, reaching Branch from a phone
`src/install/*` and `src/remote/*` make Branch something a non-technical owner can install, keep
running and reach from a phone, all without a code-signing certificate. **Installer:** the release
ships `Install Branch Agent.cmd` (generated by `bootstrapperScript()` and written by
`scripts/package-desktop.mjs`) beside the zip. It unpacks with the Windows `tar.exe` and then runs
`dist/install/install-cli.js` from inside the unpacked app through `ELECTRON_RUN_AS_NODE`, so the
real work is ordinary tested TypeScript, not script text: copy to `%LOCALAPPDATA%\Programs\Branch
Agent`, keep `.previous`, `WScript.Shell` shortcuts, an HKCU Uninstall key with a quiet uninstall
script, and a one-time copy of saved work from older folder layouts. `portable.txt` beside the exe
moves state and workspace next to the program. **Background:** `branch daemon install|uninstall|
status` registers a `/SC ONLOGON /RL LIMITED` task that runs the engine through `wscript.exe` with
window style 0 (reusing `hiddenRunner`, extracted from `hand-over.ts` without changing its
behaviour); `running.json` plus the session-token file let a later window join the running engine
instead of starting a second one. A HKCU Run value handles "start with Windows" and
`--start-minimized` opens straight to the tray. **Phone:** off by default; `RemoteAccess` opens a
*second* listener bound only to the Tailscale address (`100.64.0.0/10` enforced, never `0.0.0.0`),
and one shared `hostAllowed()` now backs all three Host/Origin checks in `server.ts`. A pure-JS QR
encoder (`src/remote/qr.ts`, byte mode, level L, versions 1-10) draws the link; the six-digit code is
shown separately and typed on the phone, and `POST /api/pair` — the only token-exempt route, and
only on the remote listener — is one-use, five minutes, five attempts. **Updates:** `Updater` gained
an optional `backup` hook (signature unchanged) that writes a full archive to `update-backups/` and
keeps three; a failed copy stops the update. `first-start.json` records whether a new version came
up healthy, and the settings card offers putting the previous version's work back through
`store.restore(archive, { replaceExisting: true })` — the plain `POST /api/restore` still refuses to
overwrite. **Setup:** `branch doctor --fix` (and a button) checks Git, the Playwright browser, a free
port and a writable workspace, installing the browser itself. Tests: `tests/deployment.test.mjs`,
17 cases, no Electron — a real dry-run install into a temp folder with real `.lnk` files and a
throw-away `HKCU\Software\BranchAgentTest\<uuid>` hive, fake-exec argv assertions for the Run key
and the scheduled task (nothing real is ever registered), a Reed-Solomon check that every codeword
vanishes at the first 20 generator powers, and a fake-updater proof that the safety copy happens
before the hand-over script is written.

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

## Batch 23 (wave 4) — evaluation suites the owner can run, and their history
The old `src/evaluation.ts` (one hard-coded three-task suite) is untouched and still answers
`POST /api/evaluation` and a bare `branch eval`. Around it, suites are now **data**:
`data/evaluation/*.json`, validated on load by `src/evaluation-suites.ts`, copied into `dist/` by
`scripts/copy-suites.mjs` so the packaged app (which ships only `dist`, `public` and
`node_modules`) has them. Five ship — everyday, tool-use, safety, reliability, cost — and all five
pass end to end on a scripted provider. A task carries `checks` (the existing reliability checks),
`deny` (phrases the answer must not contain, files it must not create), an optional
`judge: { rubric, pass }`, `expected`, `requires` (a task naming a tool this launch does not have is
**skipped**, not failed — that is how the browser task behaves without the browser integration),
`tags`, `timeoutMs` and `mode`. Grading order is deliberate and is the honest part: `deny` is fatal
first, then checks that anyone can repeat, and only a task with no checks is sent to the judge, so a
model can never grade its way past a deterministic result. `POST /api/evaluation/suites/from-run`
turns a finished task into a test.
`src/evaluation-runner.ts` (`app.evaluationSuites`) records every run under `governance` as
`evaluation-run:<id>` with per-task right/wrong, time, tokens, money through `src/pricing.ts`, the
model choice and the app version; `GET /api/evaluation/history?suite=` returns the runs and a trend
series. **Regression** means exactly one thing: the task passed in each of the three runs before
this one and has just failed — with fewer than three earlier runs nothing is ever flagged.
`POST /api/evaluation/compare { suite, presets }` runs the same suite against each model choice and
returns one table; it offers only tools that change nothing unless `allowChanges` is passed, which
is why the cost suite is written to need no writes. Money follows the existing rule — a model with
no price on file reports no amount rather than zero — and energy stays `"unavailable"`.
Scheduling reuses the existing scheduler: `kind: "evaluation"` with `suite`, a `SuiteRunner` hung
off `scheduler.evaluations` the way `runtime.documents` is hung off the runtime, a synthetic
finished run so the result shows up in Activity, and a new `evaluation.regression` webhook event.
CLI: `branch eval --suite <id> [--preset ..] [--compare a,b] [--json]`. UI: one card on Usage
(`public/evaluation.js`).
Two things worth knowing. The interrupt-and-resume task **stages** its interruption — one model
round and the one tool call it asks for are allowed (the budget charges a step for each, so the
allowance is two, not one), the saved task is then marked `interrupted` exactly as startup recovery
would leave it, and the ordinary `runtime.resume` path takes over; it is a real exercise of the
resume code, not a real crash, and the docs say so. And `tests/evaluation-more.test.mjs` uses a
provider that dispatches on the **last user message** rather than on call order, because the shared
ordered-step provider in the other test files silently repeats its last step and would let one stray
model call shift every later task.
Covers A0570, A0926, A0078, A0884, A0927, A1009, A1010, A1128, A1691 and A1764. The rows naming
outside benchmark datasets or leaderboards (SWE-bench, terminal-bench, OSWorld, GAIA,
WindowsAgentArena, AndroidWorld, WebVoyager, BrowserGym, BEIR, AGBench, APPS/MBPP) are untouched,
however well the suite mechanism would carry them; so are the URL and HTML-state evaluators
(A1765, A1766), which need a browser page the harness does not yet drive.


## Batch 23 (wave 4) — models that run on this computer
Branch could already be pointed at Ollama or LM Studio as a provider; it could not *manage* one.
`src/local-models.ts` speaks both runtimes' own APIs with no new dependency: `OllamaClient` does
version, list (`/api/tags`), details (`/api/show`, including the largest `*.context_length` the
server reports and whether the model can be shown a picture), delete, embeddings
(`/api/embeddings`, one passage per request) and `pull`, which reads Ollama's newline-delimited
progress stream and turns each line into a `model.download.progress` report with bytes so far,
total and a percentage. `LmStudioClient` lists models (`/api/v0/models`, falling back to
`/v1/models`) and loads one by asking it for a single token, which is the only public way to make
LM Studio bring a model into memory. Every base address goes through `assertOnThisComputer`, which
refuses anything that is not `localhost`/`127.0.0.1`/`[::1]` or that carries credentials, a query
or a fragment; model names are checked against the shape Ollama accepts so a name can never become
a path. These requests deliberately do not go through `NetworkPolicy` — it refuses loopback by
design, and a local runtime is nothing but loopback — which is the same carve-out
`GET /api/providers/local` already documents.
`src/local-hardware.ts` reads memory and cores from Node and, on Windows only, the graphics card
from one cached `powershell Get-CimInstance Win32_VideoController` that returns null on any
surprise. `recommendModels()` is pure: three sizes (llama3.2:3b, llama3.1:8b, qwen2.5:14b) each
marked as fitting this computer or not, with plain-language expectations ("fast, good for notes";
"slower, better at reasoning") and a note saying whether the graphics card will take the work or
replies will come a word at a time.
`src/local-runtimes.ts` holds it together for the app: one shared `LocalRuntimes` with an in-memory
download registry, because a multi-gigabyte pull lasts far longer than the server's 150 s request
timeout — `POST /api/local-models/pull` starts it and returns at once, `GET
/api/local-models/downloads` says how it is going — plus the last error and the health section.
`src/local-models-api.ts` is the whole `/api/local-models/*` family, so `src/server.ts` gains only a
four-line dispatch block, the family name in `isExecution`, and `/local-models.js` in the static
list. `src/local-routing.ts` adds per-task routing (`settings/routing`, off by default): a pure
`classifyTask` (length, tool-need phrases, and a personal-details heuristic written here because
Branch still has no PII guard — A0875) and a pure `chooseRoute` that keeps a private task on this
computer, sends a long or tool-heavy one to the cloud model, prefers the free local model when a
simple task would cost more than the owner's ceiling by the existing pricing table, and would fall
back to the cloud when the local server is not answering. `Runtime.loop` consults it in ten lines
and records a `model.routed` event; an explicit run or conversation choice always wins. One honest
gap: `Runtime.routed` passes no `localUp`, so that last branch is unreachable from a real run — a
dead local model falls back the ordinary way, through the connection's fallbacks and the provider
cooldown. Only `POST /api/local-models/routing/preview` sets `localUp` today.
`document-embeddings.ts` gains an `Embedder` interface so `documents.ts` and `memory-retrieval.ts`
can take Ollama's reader in two lines each when the connected model is on Ollama's port, swapping
`text-embedding-3-small` for `nomic-embed-text`. `models.ts` gains `presetRunsLocally`, a `local`
flag on every `ModelChoice` and `ModelRouter.runsLocally`, so the context pane says "· on this
computer" plainly. UI: a "Models on this computer" card in Settings (`public/local-models.js`) with
the hardware summary, the three suggestions, a native progress bar per download, what is installed
with its size and whether it can see pictures, and the routing switches. Tests:
`tests/local-models.test.mjs` (20) drive a real loopback fake Ollama, including a pull whose NDJSON
is split across chunks. Covers A1788 and A2365, and the provider-adapter family under
`models.routing-and-cost`; A2103 (under `cli-and-tui`) is adjacent but not claimed.

## Batch 23 (wave 4) — secrets that cannot leak, ordinary sign-ins, commands kept in their lane
`src/vault.ts` puts one `Secrets` service in front of the locker. Tools and settings pass a
reference (`secret://project/NAME`); `Secrets.fill` walks a value, refuses a reference belonging to
another project, and substitutes the real thing only at the call boundary. Every value ever unlocked
is remembered by one `SecretScrubber` built on the existing `scrubSecrets`, and that scrubber is
attached in exactly three places: `store.guardEvent` (every stored event), `runtime.hideSecrets`
(tool results, tool errors, run summaries) and the server's error reply. **Order matters**: the
result is scrubbed *before* `receipts.sign`, so a scrubbed result still verifies — signing first
would have made every secret-touching run read as "modified" in the receipts view. Two new tables,
`secret_meta` (replacement day, reminder day) and `secret_use` (which run used which secret, what
for), back `POST /api/secrets/:project/:NAME/rotate` and `GET /api/secrets/audit`.
`src/oauth.ts` is a generic authorization-code + PKCE flow: a loopback listener on 127.0.0.1 port 0,
`state` compared in constant time, the exchange and the refresh through the existing network policy,
and the tokens kept in the locker as one JSON secret (`OAUTH_<ID>`). No provider-specific UI; a fake
authorization server proves the round trip and the renewal. Note the trap found here: what the
service answers with is snake_case and what the locker keeps is camelCase, so there are two schemas.
`src/integrations/job-object.ts` gets real OS enforcement on Windows without a dependency: a small
PowerShell supervisor declares the kernel32 calls with `Add-Type`, creates a job object with
`PROCESS_TIME | PROCESS_MEMORY | KILL_ON_JOB_CLOSE`, and holds the handle for exactly as long as the
command runs. The job is created *before* the command is spawned, so assignment happens within
microseconds of the start; `null` at any point falls back to the sampler that was already there, and
every result reports `isolation: "job-object" | "sampling"`. This genuinely changes behaviour: the
Windows orphan case in `tests/shell.test.mjs` now cleans itself up, and that test was updated to
assert the better outcome when a job is in force and the old limitation otherwise. `netless` sets
the proxy variables to `http://127.0.0.1:9`; it is documented as best effort, not a firewall,
because a per-command firewall rule needs administrator rights.
`src/pii.ts` detects emails, phones, cards (Luhn), IBANs (mod-97) and national ids, and never
repeats the detail it found in its own finding. `src/privacy-guard.ts` applies it outbound (default
mask, through the new `ChannelRouter.outboundGuard` hook) and inbound (default off, so reading your
own files is never rewritten), and chains the optional `src/moderation.ts` check. `src/session-lock.ts`
locks after N quiet minutes and is what `Secrets.gate` calls, so a locked app will not open the
locker for a new task. No new dependency. Covers A1343, A1687, A1414, A1563, A0590 (partly, through
the scrubber rather than skill scanning), A2119, A0836, A1856, A1897, A0875, A0877, A0962 (further),
A2131/A2160 partly (a resource sandbox, not a container) and A2277. Left alone deliberately:
external vault backends (A1519, A1841), multi-user accounts (A1652, A1896, A2002, A2216), WebAuthn
(A2074) and Docker isolation (A2152) — none of them fit a single-owner local desktop app.

## Batch 23 (wave 4) — a terminal worth using, and a command line scripts can rely on

`branch chat` now opens a real terminal view built from Node's own readline and escape sequences
(`src/terminal-tui.ts`, `src/terminal-input.ts`, `src/terminal-style.ts`, `src/terminal-commands.ts`):
a status line that stays above the line being typed (model, tokens and money this conversation has
used, which approval preset is in force), answers wrapped to the window as they stream, one short
row per step with Ctrl+E to expand them, Enter to send and Alt+Enter to add a line, the up arrow to
bring a message back, Ctrl+C to stop the task without closing the terminal and Ctrl+D to leave. The
slash commands are `/help`, `/model`, `/think`, `/preset`, `/memory`, `/skills`, `/plan`, `/verify`,
`/dry-run`, `/attach`, `/history`, `/export`, `/new` and `/exit`. When a task pauses for a yes the
question is shown with the tool and the exact target and takes y / n / a / s, answered through
`Runtime.approve` — the same route the settings screen uses — after which the task carries on in the
same conversation. `src/terminal.ts` is untouched apart from exporting `progressLine`, and stays the
fallback: the full view is entered only when stdout is a terminal (or `FORCE_TTY=1`) and `--plain`
was not passed. One capability switch (`resolveStyle`) governs colour, cursor movement, the window
title and the Windows Terminal progress indicator, so `NO_COLOR` or `TERM=dumb` produces output with
no escape sequence in it at all.

The command line grew the parts a script needs (`src/cli-run.ts`, `src/cli-completion.ts`):
`branch run` takes `--json` (JSON Lines on stdout, human wording on stderr), `--attach`, `--plan`,
`--verify`, `--dry-run`, `--preset`, `--save-preset`, `--budget` and `--timeout`, and exits 0
finished / 2 stopped to ask / 3 failed / 4 out of budget; `branch status` shows the running tasks,
the questions waiting and the health summary; `branch logs <id>` prints the timeline; `branch
approve <id> yes|no` answers a paused task by writing the answer into the approval policy as a
standing rule, because the program run that stopped has already ended — the `ApprovalGate` lives in
memory, so there is no one-time answer to give from another process, and the command says in as many
words that it saved a rule that applies to future tasks too; `branch completion bash|powershell`
prints a completion script and needs no database, so it short-circuits before the workspace is
opened. `--preset` holds only for that one task and puts the owner's saved setting back afterwards
(`--save-preset` is the one that keeps the change, and says so): a flag in a script should not
quietly rewrite a setting the owner chose. One list, `cliCommands`, now drives the command check,
`branch help` and both completion scripts, so a command added anywhere shows up in all three. `tests/cli-tui.test.mjs` drives the whole view
through a child process with `FORCE_TTY=1` and asserts on ANSI-stripped output.

Deliberately left alone: multi-client attach to a running server, a setup wizard, and per-project
custom slash commands — all named in this theme but each is its own piece of work. Covers A0007,
A0136, A0205, A0249, A0620 and A1211 outright, plus two with a named gap: A0012 is the `--json`
event stream, not its "only the final answer on stdout by default" half (`branch run` without
`--json` still prints the existing `{run, usage, events}` report, which other branches merge
alongside), and A0183 is the subcommands and the terminal view without the setup wizard. The rest
of the theme's 23 entries are other projects' CLIs and are not ours to tick.

## Batch 23 (wave 6) — the web app grows up

The browser interface got the parts it was missing. `public/markdown.js` is a dependency-free
renderer that builds DOM nodes and never HTML strings, so a reply, a saved note or a document can
carry `<script>` and it arrives as characters on the page; headings, lists, tables, quotes, links
(opened outside the app through the desktop allowlist), inline code and fenced blocks with a copy
button and the language written out all render, and `tests/fixtures/markdown-sample.md` is the
fixture the test reads structure out of. `public/inspector.js` is "Look inside": one panel per task
showing every model round with its duration, prompt size, tokens and cost, every tool call with
what it was given and what came back (both clipped) and its receipt outcome beside it, the plan,
the reviewer's verdicts, anything the owner steered mid-task and the questions it stopped on, with
the whole thing saved as JSON. The round figures come from the payload the runtime really writes
(`estimatedInput`/`estimatedOutput` and `reported` on `model.completed`), and each row says whether
the provider counted them or we did; per-round cost goes through the same price table as the Usage
screen. The raw arguments of a call are not on the events at all — only the plain-language label is
— so they are read back from the assistant message that asked for the call, by call id, falling
back to the label when that message has been compacted away. It is
fed by one new route, `GET /api/runs/:id/inspect` (src/inspect.ts), which folds the timeline,
receipts, usage and cost into a single answer. `public/live-run.js` puts a row in the message column
while a task works — the step it has reached, how long it has been going, tokens so far, live over
the run's existing WebSocket — with "Ask it to wait", "Tell it something" and Stop. Waiting
and carrying on are both notes to a task that is still working (`POST /api/runs/:id/steer`); the
resume route refuses anything but an interrupted run, so neither control touches it;
a question the task stops on appears there as a card with Yes once / Yes for this conversation /
Always / No, wired to `POST /api/policy/approve`. Because a task ends the moment it asks, the card
is fetched once more as the row shuts down, or it would never be seen. `public/token-meter.js` is
the quiet bar under the composer: context used against the model's window and the cost so far, with
the numbers in a popover; a model with no price on file is said so in words. `public/playground.js`
is Settings → Developer → Try things out: a form generated from each tool's own JSON schema
(`GET /api/tools/forms`) and `POST /api/tools/try`, which evaluates the same approval policy the
runtime uses and refuses or asks before it runs anything — it does not bypass the gate. The app is
installable: `manifest.webmanifest`, generated 192/512 icons, and `service-worker.js` that keeps the
shell files and never caches `/api/`, so a dropped connection shows a plain banner rather than a
browser error; registration is skipped under `?desktop=1` and inside Electron, and the CSP grew
`worker-src 'self'; manifest-src 'self'`. Finally `public/i18n.js` moves the labels behind `t(key)`
with `public/locales/en.json` as the source of truth and a machine-drafted `fr.json` beside it,
marked as a draft; markup carries `data-t` / `data-t-label` / `data-t-placeholder`, the language is
chosen in Appearance, dates and numbers go through `Intl`, and a key with no translation falls back
to English rather than leaving a blank. `tests/web-ui.test.mjs` covers all of it; the static-assets
test now also follows absolute imports, the locale files and the list inside the service worker.
Covers A0482, A0447, A0285, A0295, A1302, A0057, A0731, A1904, A0437 and A0483. Not done: the whole markdown renderer runs on replies, while a
saved memory fact and a document search passage — one line each, and the passage carries the
search's own highlights — get the inline formatting only (bold, italic, inline code, links); the
"two models side by side" pane reuses the evaluation route and degrades to a plain message where
that route is not configured, and localisation covers the shell chrome and the wave 6 screens
rather than every string in every older section screen.

## Batch 24 (wave 6) — a tool catalog that stops growing, and explicit context accounting
The catalog was the one part of the prompt charged on **every** round that grew with the product:
on this tree 81 tools cost 47,480 characters (about 11,870 estimated tokens) of a 20,000-token
limit, which is why two builders had already raised the compaction threshold. `src/catalog.ts` fixes that three
ways and nothing else in the loop changed shape. **Schema diet**: `ToolRegistry.descriptions()` now
runs every generated schema through `slimSchema` — out go `$schema`, `title`, `additionalProperties`
that is `false` or `{}`, string and array length bounds, machine-generated `pattern`s (any longer
than 40 characters, or any sitting next to a `format` that already says the same thing), bare
`propertyNames`, and required entries for properties that carry a `default`; descriptions are capped
at 200 characters. Enum values, required lists, `format`, `default`, types and property names all
stay, and the walk is keyword-aware so a tool with a property actually named `pattern` or
`maxLength` is not mangled. 47,480 → 30,180 characters, **36.4 % smaller** at the same 81 tools.
`descriptions(perms, { diet: false })` returns the old shape, and the two places that are not the
model loop use it: the MCP server, because another program's client validates against what it is
advertised, and `/api/state`, because the app's tool list is for a person to read. **Groups and lazy
expansion**: every tool has a `group` (its own, or inferred from its name prefix), and a run is
shown the always-open boxes (`core`, `files`), whatever a cheap lexical scorer guesses from the
prompt, project and recent messages (`rankGroups`, two or three boxes, no model call), and one line
per closed box. `tools.expand {groups}` opens a box for the rest of the conversation; it is handled
in `Runtime.callTool` before the registry, touches nothing, and can only ever reveal tools the run's
permissions already allowed, because the catalog is built from `descriptions(context.permissions)`.
A tool used in the last three rounds stays in view after its box closes. Tools whose names the
product does not recognise land in `other` and stay open while there are twelve or fewer of them —
nothing in a request's words can point at a box with no meaning. Watches (`monitor.*`) and the
morning brief (`brief.*`) were the one family the prefixes did not know, so they were landing in
`other` and staying open — filling seven of the twelve slots that keep an owner's plugin and MCP
tools visible without an extra round, and six more of those would have closed the box on all of
them. They are filed under `schedules`, where they belong. Typical first round
on this tree: 17 to 24 tools, 5,200–7,800 characters (1,300–2,000 estimated tokens, 83–89 % smaller);
everything closed: 861 characters, 216 estimated tokens (**98.2 % smaller**). **Context accounting**:
one `ContextBudget` per round (`limit`, `system`, `catalog`, `messages`, `reserve`, `threshold`,
`headroom`) emitted as `context.budget`, with `catalog.size` and `catalog.preselected` /
`catalog.expanded` alongside. Compaction now compares the **conversation alone** against a threshold
derived as `limit − catalog − reserve`, floored at the old constant, so a bigger catalog can no
longer fold a conversation away early — only a catalog large enough to break the whole request
still forces a last-resort fold instead of failing the task; `compactionThresholdFloor` (11,000) and
`derivedCompactionThreshold()` are both exported, and `compactionThreshold` — the name wave 5 had
raised to a fixed 14,000 — is now re-exported as that floor, because it is no longer a constant
anything should read as the live figure. **Provider caching**: the Anthropic body is
written tools → system → messages, Claude's own cache-prefix order, with one `cache_control` marker
at the end of the catalog and one on the instructions, and `cache_read_input_tokens` is carried
through `Usage.cachedInput` into the `model.completed` event; the OpenAI body puts tools before
messages for automatic prefix caching and reads `prompt_tokens_details.cached_tokens`.
`tests/catalog-diet.test.mjs` covers all of it, including 150 dummy tools over a 20-round
conversation that neither exceeds the limit nor thrashes compaction. Two existing literals changed:
`tests/providers.test.mjs` now expects `system` as a marked text block instead of a bare string, and
nothing in `tests/compaction-attention.test.mjs` needed touching — it imports `compactionThreshold`,
which now means the 11,000 floor, and the conversation share alone is well past that when it
compacts. Covers the
context-management theme (#82) and the reliability inventory item (#16).

## Batch 20 (wave 7) — orchestration, second pass: styles, patches, processes, flows
Six things, all backend-first with additive UI in Specialists, Procedures and Skills only, and no
new dependency. **Specialist styles** (`src/specialist-styles.ts`): a specialist declares a `style`
that changes its loop rather than only its prompt. `react` is told to open each reply with one
`Thought:` line; the runtime takes that line off the answer, records it as a `react.scratch` event
and leaves it in the stored transcript, so the model keeps its own trail while the person never
reads it. `plan-execute` turns on the existing plan runner for a delegated sub-task, which an
ordinary child never gets. `critic` is narrowed to read-only permissions in `activeSpecialist()` —
narrowing, so the escalation check is untouched. `researcher` and `coder` seed `openCatalog` with
the toolboxes their work always needs. **Multi-file changes** (`src/code-change.ts`): `code.patch`
and `code.change_set` plan the whole change first (`CodeEditor.planPatch`/`preview`/`writeAll`, made
public; `files.patch` is unchanged and its tests untouched), refuse binary files, write through the
existing `writeObserver` so every file lands in the file history, and then run the owner's configured
check program — which is what makes "the assistant sees what it broke in its very next step" true
rather than aspirational. The change set's `target()` names the files, so one approval reads "2
files: a.txt, b.txt". **Background processes** (`src/processes.ts`): a dedicated `Running` class
rather than `ShellProcess`, because a dev server needs a ring buffer and must not sit behind
`BranchShell`'s single-slot guard; it reuses the exported job object and tree-kill helpers. Keyed by
**session**, not run — `onRunFinished` fires every round, so keying by run would kill a server before
the next one. Stopped on `store.onSessionClosed` (new, fired from `purgeSession`) and on
`createBranch().close()`. **Deferred calls and tool search** are intercepted in `callTool` beside
`tools.expand`, because the per-run `ToolCatalog` lives in the runtime and a registered tool cannot
see what is closed; a deferral settles through the existing follow-up queue, not a new mechanism.
**Flows** (`src/flows.ts`): the wave-6 `Workflows` seen as nodes and edges, with branch steps
yielding a labelled edge each way. `src/workflows.ts` is a byte-for-byte copy from
`wave6/collab-workflows`, which had not reached `wave2/integration` when this batch started — the
copy is deliberate so an add/add merge is clean. Node-completion callbacks are a before/after diff of
the step states around the run rather than a hook inside `Workflows`, again to keep that file
identical. **Skill self-improvement** (`src/skill-revisions.ts`): the governance draft is now shown
as a line diff, tried against the last three real tasks that used the skill with `dryRun` on the
parent context (so the child inherits it), and refused for acceptance until that trial says the draft
did no worse. `skills.sync` writes and reads skills as `.md` in a workspace folder. Plugins get a
local catalog (`src/plugin-catalog.ts`) with sha256 fingerprints, install from a folder or a zip
(reusing `zipRead`/`zipWrite` from `src/skill-package.ts`), the manifest shown first, and no remote
source of any kind. `tests/orchestration-2.test.mjs` covers all of it in 23 tests; two counts in
`tests/catalog-diet.test.mjs` moved by one because the catalog now offers `tools.search` beside
`tools.expand`. Covers agent-orchestration (#55), skills-and-recipes (#78) and the
plugin-and-extension-system (#70) leftovers.
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
