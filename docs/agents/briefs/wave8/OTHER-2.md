# Wave 8 task: the long tail in "other" — build what fits, document what does not

Rules: docs/agents/briefs/wave1/BUILD.md. Branch: wave8/other-2 from the local branch wave2/integration (current tip). Theme: other (#60), the rows still open; read the `## other` section of docs/audit/todo.md and the checklist in GitHub issue #60 (`gh issue view 60`) yourself and treat every UNTICKED single id there as your list. Backend first, tiny additive UI only. No new dependency.

For each open id decide: BUILD (small, fits a local Windows desktop assistant, provable by a test), DOCUMENT (explain in docs/configuration.md why it is not built or how the existing feature covers it), or NOT APPLICABLE (say why in the report). Known candidates and how to treat them:
- A0758 HTTP API: already exists (`/api/*`, the OpenAI-compatible route, the SDK); document the map and add an OpenAPI 3 description of Branch's own API generated from the zod schemas (`GET /api/openapi.json`, plus a small script that writes docs/api.md) so other tools can call it. BUILD.
- A0928 request caching: exact-match cache for model requests (hash of the full request, opt-in, TTL, per owner, never for tool calls with side effects), with cache hits shown in the run inspector and cost counted as zero with the reason. BUILD.
- A1351/A1352 batch inference: a `batch` mode for evaluation runs and knowledge indexing that uses OpenAI and Anthropic batch APIs when the connection supports them (submit, poll, collect; results into the same tables), off by default, cost recorded from the batch response; fall back to normal calls. BUILD with fakes.
- A0390 durable threads: conversations already persist; add thread branching from any message (`sessions.branch` exists) with a visible tree in the rail and merge-back of a branch's final answer as a note. BUILD small.
- A0834 flow checkpointing and A1274 nested flows: flows exist (wave 7); add per-node checkpoints already there? verify; add nesting: a flow node that runs another flow with a depth cap and cycle refusal. BUILD.
- A0615 lockdown mode: a single "Lockdown" switch that sets every permission to ask, disables host execution, screen control, borrowing the browser, outbound webhooks and channels sending, until turned off; audited; shown in the rail. BUILD.
- A0794 project management: projects exist; add per-project instructions, default model profile, default knowledge bases and a project switcher summary; ensure the ledger can group cost per project (the polish reviewer noted tasks have no project column: add it). BUILD.
- A1011 local studio/playground: the wave-6 playground covers it; document and tick.
- A0098 embedded code editor: a read-only code viewer with syntax colouring for the Documents/inspector views is enough for a desktop assistant; a full editor is NOT APPLICABLE (VS Code exists); document.
- A0344 IDE watch mode: a `branch watch` CLI that re-runs a named procedure when files in a folder change (existing file watcher + procedures). BUILD small.
- A1193 bidirectional live streaming: covered by talk mode + run WebSocket; Realtime API deferred (documented in wave 7). DOCUMENT.
- A0663 C FFI, A1468 ADB operator, A0602 Ultracode plugin lifecycle, A1141 LiteLLM: NOT APPLICABLE or covered by the provider catalog; say so.
- Anything else open in #60: decide with the same rule and report.

Tests (tests/other-2.test.mjs): openapi.json validates and lists the run/sessions/memory routes; cache hit skips the network and shows in the inspector; batch mode submits/polls/collects against fakes and falls back; branch tree and merge-back; nested flow with depth cap and cycle refusal; lockdown flips every switch and is audited, and turning it off restores exactly the previous settings; project instructions/profile/knowledge defaults apply to a task and cost groups by project; `branch watch` re-runs on change (temp folder) and stops cleanly. Existing suites green; new tools filed in src/catalog.ts; catalog-diet width check must stay under its literal (shorten descriptions, do not raise it).

Acceptance: for each open id in #60 one line: built (test name) / documented (doc anchor) / not applicable (reason). Report under 60 lines with branch + head SHA and test counts.

Housekeeping: your worktree has no node_modules; create a junction with PowerShell `New-Item -ItemType Junction -Path <worktree>/node_modules -Target C:/Users/bishi/Documents/Codex/Branch-build/node_modules`. Never run tests/desktop*.test.mjs, tests/screen-control.test.mjs, or start Electron; never open a window on the desktop; no real network calls. Before your final commit, merge the current `wave2/integration` into your branch and re-run your tests. Do not remove the worktree when done.
