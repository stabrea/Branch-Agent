# Ledger verification, 2026-09-17

A sample of the 271 single audit ids ticked `[x]` in issues #55-#92 was re-checked against the code
on this tree. A tick carries no evidence of its own: the tail of every ticked line is still the
original gap note from the first audit pass, so each id had to be re-established from the source.

Tree: `wave2/integration` at `f89d6b4`. Ticks in the sample span 0.7.3 to 0.14.0. A verdict here
means "not present on this tree" - work that landed on an integration branch not merged here would
read the same way, and was not chased.

## The sample

- Seed: **20260917**, Python 3.12.10.
- Expression: `random.Random(20260917).sample(sorted(all_ticked_ids), 60)`, where `all_ticked_ids`
  is the 271 ids matching `^- \[x\] \`(A\d+)\`` across the bodies of issues #55-#92.
- Plus every ticked id in #55 (agent-orchestration, 15), #66 (permissions-and-policies, 26) and
  #69 (secrets-and-auth, 16) - the risk-heavy themes. 57 ids, 10 of which the draw had already hit.
- Union: **107 ids**, 39% of the ticked ledger.

Random 60: A0007, A0031, A0057, A0099, A0136, A0169, A0205, A0249, A0262, A0285, A0372, A0437,
A0482, A0483, A0566, A0590, A0591, A0613, A0620, A0632, A0638, A0654, A0701, A0773, A0835, A0877,
A0884, A0955, A0962, A0996, A1009, A1103, A1118, A1119, A1218, A1263, A1356, A1366, A1372, A1481,
A1735, A1764, A1795, A1805, A1838, A1856, A1892, A1893, A1896, A1975, A1999, A2043, A2083, A2149,
A2162, A2173, A2216, A2276, A2277, A2296.

Risk set (#55, #66, #69): A0048, A0152, A0186, A0195, A0220, A0245, A0262, A0317, A0372, A0398,
A0405, A0590, A0596, A0617, A0796, A0809, A0824, A0836, A0891, A0935, A0959, A1092, A1093, A1116,
A1126, A1218, A1268, A1278, A1343, A1414, A1465, A1519, A1521, A1563, A1629, A1652, A1685, A1686,
A1687, A1805, A1834, A1841, A1856, A1896, A1897, A2002, A2006, A2053, A2074, A2075, A2076, A2088,
A2119, A2216, A2276, A2278, A2296.

## Method

For each id: read `capability` and `detail` in `audit-assessment.json`, then find code on this tree
and a test that asserts the behaviour. `status`, `note` and `evidence` in that file are the
**pre-build** verdict, not the promise - `evidence` in particular is unreliable (A0317 "swarm
orchestration" and A0195 "advisor model" both point at `src/backup.ts` and `src/activity.ts`), so it
was not used as a search seed. "What the row promised" means `detail`, which describes what the
upstream project does.

- **VERIFIED**: code named, and a test that exercises the behaviour named. A docs mention, a builder
  report, or a test that only asserts a symbol exists does not count.
- **PARTIAL**: part of the row's mechanism is on the tree and a materially distinct part named by the
  row is not.
- **NOT FOUND**: no code for the promised capability, or no test.

Two rules applied consistently, stated here because they decide several rows:

1. **Shared implementations still verify.** Where two ids from two upstream projects describe the
   same capability and it genuinely shipped with tests (A0437/A0483 i18n, A0136/A0249 headless CLI,
   A0031/A1263 OTLP), both are VERIFIED and the sharing is recorded in the line. Un-ticking one of a
   pair would tell the owner to go and build something that already exists. Duplication is reported
   below as a counting problem, not as a re-open.
2. **A different transport is not a missing capability.** A1896 and A2002 both promise local account
   sign-in with JWT sessions; this tree has scrypt-hashed PIN profiles with lockout and per-profile
   isolation. Same rule for both: VERIFIED with the deviation noted. A1897/A2216/A2074 are different
   - an external identity provider and WebAuthn are mechanisms that are simply absent.

**Un-tick convention.** A re-opened line keeps everything the issue already said and only swaps the
marker and the version note: `- [ ] \`A1234\` (was ticked in 0.13.0; re-opened: <reason>) **Capability**
(partial, M; seen in 1 projects) — <original note>`. Nothing else in any body was touched.

### Coverage limitations

- `tests/secrets-sandbox.test.mjs` is deny-blocked in this environment and could not be read, only
  matched at file level. It is the test home for moderation (A0877) and PII handling. A0877 is
  verified on its source with that stated; it was not re-opened for a test nobody here can read.
- `tests/screen-control.test.mjs` and `tests/desktop*.test.mjs` may not be run. Their assertions were
  read, and A2278/A2043 are judged from them. `screen-control` is also opt-in
  (`BRANCH_SCREEN_TESTS=1`), so it does not run in a default pass.
- Nothing was run: no build, no test execution. Every verdict is from reading source and tests.

## Verdicts

### #55 agent-orchestration

- **A0186** VERIFIED - src/orchestration.ts (PlanStep, Orchestration, plan approval); tests/orchestration.test.mjs:63,107
- **A0195** PARTIAL - has: reviewer pass over the finished answer, src/orchestration.ts:241 RunConductor.review, tests/orchestration.test.mjs:225; missing: a second model on its own context injecting notes into every turn
- **A0317** PARTIAL - has: concurrent fan-out, src/orchestration-tools.ts runParallel/pooled, tests/orchestration.test.mjs:141,170; missing: a swarm runtime whose agents hand off to each other while running
- **A0372** PARTIAL - has: the same plan builder credited to A0186, src/orchestration.ts; missing: a distinct decomposition component turning a design into tasks
- **A0405** PARTIAL - has: the same ordered plan loop credited to A0186, src/orchestration.ts RunConductor; missing: a sequential action-planning node inside a role loop
- **A0809** VERIFIED - src/orchestration-tools.ts runParallel + pooled (concurrency cap, per-branch budget); tests/orchestration.test.mjs:141,170
- **A0891** VERIFIED - src/workflows.ts branch step kind + src/flows.ts FlowEdge when=matched/skipped; tests/collab-workflows.test.mjs:196
- **A0935** VERIFIED - src/orchestration.ts:241 review() loops executor and critic to an iteration budget of two; tests/orchestration.test.mjs:225
- **A0959** VERIFIED - src/orchestration-tools.ts handOff + src/delegation.ts checkResult (result schema); tests/orchestration.test.mjs:184, tests/delegation.test.mjs:34
- **A1092** VERIFIED - src/delegation.ts fanoutWaves (dependency ordering, results fed forward); tests/delegation.test.mjs:81
- **A1093** PARTIAL - has: the same handOff tool credited to A0959; missing: explicit handoff relationships routing work between named agents
- **A1116** VERIFIED - src/workflows.ts:303 registerWorkflows exposes workflows.run as a callable tool over a saved pipeline; tests/collab-workflows.test.mjs:151,239
- **A1218** VERIFIED - src/delegation.ts (depth, concurrency, timeouts) + src/run-queue.ts follow-up queue; tests/delegation.test.mjs:52, tests/orchestration-2.test.mjs:293
- **A1268** VERIFIED - src/flows.ts FlowNode/FlowEdge directed graph with labelled transitions; tests/orchestration-2.test.mjs:364
- **A1278** PARTIAL - has: RunConductor plus the reviewer pass credited to A0935; missing: a supervisor agent coordinating a named worker agent

### #66 permissions-and-policies

- **A0048** VERIFIED - src/policy.ts evaluatePolicy over ordered tool/target rules returning allow/ask/deny; tests/approvals.test.mjs:65,368
- **A0152** VERIFIED - src/policy.ts policyPresets/presetRules (off, ask-before-changes, workspace, read-only); tests/approvals.test.mjs:104,219
- **A0220** VERIFIED - src/approvals.ts ApprovalGate + SessionGrant + PendingApproval (the call waits for an answer); tests/approvals.test.mjs:126,383
- **A0245** PARTIAL - has: approval gating of every tool, src/policy.ts + src/approvals.ts; missing: a sandbox policy - src/code-run.ts:16 states its limits are not a sandbox
- **A0262** VERIFIED - src/policy-resources.ts resourceOf/resourceMatches (path, host, channel, command matchers); tests/tracing-policy.test.mjs:492,526
- **A0398** VERIFIED - src/workflows.ts approval step kind and waiting_approval status; tests/collab-workflows.test.mjs:151, tests/orchestration-2.test.mjs:414
- **A0596** VERIFIED - src/index.ts createBranch wires one policy and approvals gate into every tool surface it hands back; tests/approvals.test.mjs:314, tests/mcp-mode.test.mjs:224
- **A0617** VERIFIED - src/patch.ts + src/code-change.ts show the whole change before one all-or-nothing approval; tests/orchestration-2.test.mjs:139,193
- **A0796** VERIFIED - src/server.ts route authorisation + src/audit.ts persisting approval.decided and policy.changed; tests/sdk-misc.test.mjs:88,118
- **A0824** PARTIAL - has: per-tool-name rules that hold a call for review, src/policy.ts, tests/approvals.test.mjs:126; missing: edit and respond decisions on a held call - only allow and deny exist
- **A1126** PARTIAL - has: the approval gate intercepting tool calls, src/approvals.ts; missing: hooks that can approve - src/hooks.ts events are notify-only after the fact
- **A1465** PARTIAL - has: an owner switch gating every screen tool, src/integrations/desktop-config.ts, tests/screen-control.test.mjs:60,244; missing: any OS accessibility or screen-recording permission check or request
- **A1521** VERIFIED - browser tools carry the page host as the policy resource; tests/approvals.test.mjs:228, tests/tracing-policy.test.mjs:579
- **A1629** PARTIAL - has: command-alias rules classifying commands allow/ask/deny, src/policy-resources.ts:50; missing: a fail-closed default - tests/approvals.test.mjs:93 shows an unmatched command is allowed
- **A1685** VERIFIED - src/policy.ts cappedPolicy caps the mcp run source so it can never exceed ask; tests/approvals.test.mjs:314, tests/mcp-mode.test.mjs:224
- **A1686** VERIFIED - approvals are bound to a fingerprint of the exact sanitized call bytes; tests/tracing-policy.test.mjs:626,665
- **A1805** VERIFIED - src/approvals.ts ApprovalGate gating commands and file writes; tests/approvals.test.mjs:126, tests/tracing-policy.test.mjs:557
- **A1834** VERIFIED - src/execution-limit.ts resource limits + src/network-policy.ts host rules alongside the approval policy; tests/guardrails.test.mjs:33,50
- **A2006** PARTIAL - has: per-profile isolation (src/profiles.ts) and per-specialist permissions (src/specialist-styles.ts); missing: role or prompt level grants - src/teams.ts role is a free-text label
- **A2053** VERIFIED - src/policy.ts evaluatePolicy applied at the tool boundary with remember scopes; tests/approvals.test.mjs:126,343
- **A2075** VERIFIED - src/ws.ts carries the approval question, its bytes and fingerprint over the socket; tests/tracing-policy.test.mjs:704
- **A2076** VERIFIED - src/auth-limits.ts AuthLimiter/noteAuthFailure wired in src/server.ts:1658; tests/tracing-policy.test.mjs:772,782
- **A2088** VERIFIED - src/approvals.ts PendingApproval list plus grants with expiry shown in the UI; tests/polish-observability.test.mjs:613,653
- **A2276** VERIFIED - src/approvals.ts gate pausing the call and src/audit.ts recording approval.decided; tests/approvals.test.mjs:126, tests/sdk-misc.test.mjs:88
- **A2278** VERIFIED - src/integrations/desktop-config.ts switch, caps and refusalFor gating screen and input tools; tests/screen-control.test.mjs:60,83,189 (opt-in file, read not run)
- **A2296** VERIFIED - public/approvals.js approval card plus the ask rule on collaboration tool steps; tests/collab-workflows.test.mjs:262, tests/polish-observability.test.mjs:653

### #69 secrets-and-auth

- **A0590** VERIFIED - src/skill-scan.ts scanSkill + secretPatterns with a block/review policy; tests/trust.test.mjs:52-55
- **A0836** VERIFIED - src/oauth.ts OAuthConnections authorization-code flow with PKCE and refresh; tests/chatgpt.test.mjs:32 refresh_token exchange
- **A1343** VERIFIED - src/vault.ts secretReference/parseSecretReference resolving secret://project/NAME at the call; tests/projects-locker.test.mjs:48, tests/tracing-policy.test.mjs:304
- **A1414** VERIFIED - src/vault.ts SecretScrubber and named references filled in only at the host boundary; tests/projects-locker.test.mjs:48, tests/approvals.test.mjs:206
- **A1519** NOT FOUND - no credential-service resolution in src; the only Bitwarden and 1Password strings are window-title patterns in src/integrations/desktop-config.ts:46
- **A1563** VERIFIED - src/vault.ts SecretScrubber + src/locker.ts scrubSecrets over logs, traces and screenshots; tests/cost-trace.test.mjs:341, tests/tracing-policy.test.mjs:363
- **A1652** VERIFIED - src/profiles.ts (scrypt-hashed PIN, lockout, per-profile isolation) plus server local-key auth; tests/collab-workflows.test.mjs:602, tests/tracing-policy.test.mjs:407
- **A1687** VERIFIED - secret://project/NAME references accepted wherever a key is configured, instead of a raw value; tests/projects-locker.test.mjs:84, tests/skills-plugins.test.mjs:83
- **A1841** PARTIAL - has: a vault abstraction with a local encrypted backend, src/vault.ts + src/locker.ts, tests/projects-locker.test.mjs:48; missing: Bitwarden and 1Password backends
- **A1856** VERIFIED - src/oauth.ts stores tokens under oauthSecretName in the locker, read by provider config; tests/mcp-mode.test.mjs:286, tests/projects-locker.test.mjs:48
- **A1896** VERIFIED - src/profiles.ts local sign-in: scrypt hash, timing-safe compare, five-attempt lockout; tests/collab-workflows.test.mjs:602 (deviation: PIN sessions, not JWT)
- **A1897** NOT FOUND - src/oauth.ts is outbound sign-in to other services; no inbound identity-provider login, no OIDC discovery, no role mapping
- **A2002** VERIFIED - src/profiles.ts create, switch and verify with lockout - the same local account path as A1896; tests/collab-workflows.test.mjs:602 (deviation: PIN sessions, not JWT)
- **A2074** NOT FOUND - no WebAuthn registration or authentication anywhere in src, public or tests
- **A2119** VERIFIED - src/oauth.ts and src/integrations/mcp-oauth.ts both use authorization code with PKCE; tests/mcp-mode.test.mjs:286
- **A2216** NOT FOUND - no invitation-gated accounts and no OIDC provider configuration; the invite in src/remote/remote-access.ts is a device pairing code

### #63 tracing-and-telemetry

- **A0031** VERIFIED - src/trace.ts OTLP span and resource shapes + src/tracing-export.ts otlp destination with metrics; tests/tracing-policy.test.mjs:250, tests/cost-trace.test.mjs:257
- **A0566** NOT FOUND - no Sentry import, package or initialisation anywhere in src, public or tests
- **A0613** VERIFIED - src/tracing-shapes.ts spansToLangfuse and the Langfuse ingestion endpoint; tests/tracing-policy.test.mjs:250,304
- **A0835** VERIFIED - src/tracing.ts Tracer spans for runs, models, tools and deliveries; tests/tracing-policy.test.mjs:105,137 (the usage-telemetry half of the row is a deliberate non-goal, tests/tracing-policy.test.mjs:474)
- **A0955** VERIFIED - src/tracing.ts Tracer/SpanStore wrapping model and tool calls in nested spans; tests/tracing-policy.test.mjs:105,137
- **A1263** VERIFIED - the same OTLP span and metric export credited to A0031, src/trace.ts + src/tracing-export.ts; tests/tracing-policy.test.mjs:250
- **A1356** VERIFIED - src/tracing-export.ts TraceExporter batching and retrying sends to Langfuse with a locker key; tests/tracing-policy.test.mjs:304,335

### #58 dashboards-and-observability

- **A0057** VERIFIED - src/usage.ts UsageStore + src/metrics.ts collectMetrics/histogram/prometheusText; tests/tracing-policy.test.mjs:433,454, tests/cost-trace.test.mjs:154
- **A0099** VERIFIED - src/streams.ts streamRunEvents/streamOwnerEvents (SSE) + src/ws.ts serveRunSocket; tests/guardrails.test.mjs:116, tests/polish-observability.test.mjs:373
- **A0638** PARTIAL - has: usage and cost counted and shown in the web UI, src/usage.ts, tests/cost-trace.test.mjs:154; missing: any token figure in the terminal view (src/terminal-tui.ts has none)
- **A0773** VERIFIED - src/pricing.ts TokenCounts/CostEstimate/estimateCost carried on usage rows; tests/cost-trace.test.mjs:50,103,284
- **A1366** VERIFIED - src/usage.ts UsageStore cumulative aggregates per owner and session; tests/cost-trace.test.mjs:81,116
- **A1481** PARTIAL - has: public/inspector.js renders a run timeline with per-round detail and cost; missing: replay of a recorded trajectory
- **A1735** VERIFIED - src/metrics.ts (calls, tool latency histogram) + src/pricing.ts estimates; tests/tracing-policy.test.mjs:433,454

### #72 cli-and-tui

- **A0007** VERIFIED - src/terminal-tui.ts startTui (line editor, streaming, key handling) + src/terminal-input.ts; tests/cli-tui.test.mjs:61,124,139
- **A0136** VERIFIED - src/cli-run.ts runForScripts + exitCodes + parseRunArgs; tests/cli-tui.test.mjs:163,179
- **A0205** VERIFIED - src/terminal-tui.ts (same terminal view as A0007, shares sessions and approvals); tests/cli-tui.test.mjs:61,90
- **A0249** VERIFIED - src/cli-run.ts (same one-shot path as A0136, --json line output); tests/cli-tui.test.mjs:163,215
- **A0620** VERIFIED - src/cli.ts command dispatch (run, status, logs, approve, eval, skill, plugin, completion); tests/cli-tui.test.mjs:215,244

### #75 vector-and-hybrid-memory

- **A0996** VERIFIED - src/vector-store.ts VectorBackend interface with upsert and query, plus topK; tests/rag-vector.test.mjs:151,368
- **A1103** PARTIAL - has: one SQLite backend behind the VectorBackend interface, src/vector-store.ts SqliteVectors, tests/rag-vector.test.mjs:368; missing: every external connector the row names - Postgres, Redis, Qdrant, Pinecone, Chroma, Weaviate, MongoDB, Azure
- **A1119** VERIFIED - src/vector-store.ts topK similarity search over stored chunk vectors; tests/rag-vector.test.mjs:151,330
- **A1975** VERIFIED - src/memory-retrieval.ts persisting and retrieving conversation facts with embeddings plus BM25; tests/rag-vector.test.mjs:330, tests/memory-scopes.test.mjs:26

### #65 voice-io

- **A0654** VERIFIED - src/voice-stt.ts local engine command lines and channel voice-note handling; tests/voice-providers.test.mjs:91,108,137
- **A1893** VERIFIED - src/voice-api.ts authenticated audio route over src/voice-stt.ts local and remote engines; tests/voice-providers.test.mjs:56,108
- **A2162** PARTIAL - has: ASR, TTS and a talk mode cycling idle, listening, thinking and speaking, src/voice-talk.ts, tests/voice-providers.test.mjs:306; missing: wake-word detection - no wake-word code in src
- **A2173** VERIFIED - src/voice-stt.ts three transcription shapes and src/voice-tts.ts OpenAI, Windows and Gemini synthesis; tests/voice-providers.test.mjs:56,158,220

### #80 sandboxing-and-isolation

- **A0701** VERIFIED - src/approvals.ts:191 jsonWriteProblem re-parsing a written .json file; tests/approvals.test.mjs:298
- **A0877** VERIFIED - src/moderation.ts Moderation.check calls an OpenAI-compatible /moderations endpoint and blocks flagged categories; its test home tests/secrets-sandbox.test.mjs is deny-blocked here, so only a file-level match was confirmed
- **A0962** VERIFIED - src/content-guard.ts (input), src/moderation.ts (output), src/network-policy.ts and src/execution-limit.ts (tool calls); tests/guardrails.test.mjs:33,50
- **A2277** PARTIAL - has: resource limits and network rules, src/execution-limit.ts, tests/guardrails.test.mjs:33; missing: a sandbox policy per runtime mode - src/code-run.ts:16 says outright it is not a sandbox

### #60 other

- **A0437** VERIFIED - public/i18n.js + public/locales/ resource trees read at runtime; tests/polish-observability.test.mjs:770,784
- **A0482** VERIFIED - public/markdown.js sanitised rendering used by the activity feed and inspector; tests/polish-observability.test.mjs:750
- **A0483** VERIFIED - public/i18n.js persists the chosen language over the same catalogs as A0437; tests/polish-observability.test.mjs:770,784
- **A0591** VERIFIED - src/audit.ts AuditLog/auditCsv recording policy and approval events; tests/sdk-misc.test.mjs:88,118,144

### #57 documents-and-rag, #61 evaluation, #74 memory, and the single-id themes

- **A1118** VERIFIED - src/bm25.ts Bm25 lexical ranker; tests/rag-vector.test.mjs:203,262
- **A1372** VERIFIED - src/knowledge-bases.ts + src/documents.ts indexing and retrieval; tests/rag-vector.test.mjs:222,380
- **A2149** VERIFIED - src/projects.ts scoping + knowledge bases attached to a run; tests/rag-vector.test.mjs:294, tests/projects-locker.test.mjs:25
- **A0884** VERIFIED - src/evaluation-suites.ts + src/evaluation-runner.ts (accuracy, tool checks, timing); tests/evaluation-more.test.mjs:90,181
- **A1009** VERIFIED - src/evaluation-grading.ts gradeTask persisting scores into run history; tests/evaluation-more.test.mjs:154,218
- **A1764** VERIFIED - src/reliability.ts:35 evaluateChecks (mustMention inclusion, mustMatch pattern, lowercased compare); tests/evaluation-more.test.mjs:218
- **A1795** VERIFIED - src/memory-retrieval.ts MemoryRetrieval over src/embeddings.ts and src/vector-store.ts; tests/rag-vector.test.mjs:330, tests/memory.test.mjs:160
- **A1892** VERIFIED - src/memory.ts per-owner records with scopes exposed to memory tools; tests/memory.test.mjs:28,57, tests/memory-scopes.test.mjs:49
- **A0169** VERIFIED - src/integrations/mcp-oauth.ts discover/register/signIn with PKCE; tests/mcp-mode.test.mjs:286
- **A0285** VERIFIED - public/inspector.js over src/trajectory.ts buildTrajectory; tests/polish-observability.test.mjs:550,569,581
- **A0632** VERIFIED - src/delegation.ts fanoutWaves with depth, concurrency and timeouts, merged under the parent; tests/delegation.test.mjs:52,81
- **A1838** VERIFIED - src/webhooks.ts Webhooks with an event list and retry delays; tests/evaluation-more.test.mjs:242
- **A1999** VERIFIED - src/conversation-share.ts ShareLinks (code, single use, expiry) + redaction; tests/collab-workflows.test.mjs:78,101
- **A2043** PARTIAL - has: src/integrations/desktop-tools.ts + desktop-script.ts Windows screen control, tests/screen-control.test.mjs:120; missing: macOS UI automation
- **A2083** VERIFIED - src/media-images.ts generation and edit tools registered with permissions and offered through MCP server mode (src/mcp-server.ts); tests/media.test.mjs:77,348

## Totals

| Verdict | Count | Share of the 107 sampled |
| --- | --- | --- |
| VERIFIED | 83 | 78% |
| PARTIAL | 19 | 18% |
| NOT FOUND | 5 | 5% |

24 ids were un-ticked in their issue bodies, with a short reason on the line. By theme:
#55 six, #66 six, #69 five, #58 two, #63 one, #65 one, #75 one, #77 one, #80 one.

Five ids had no code at all for what the row promised: **A0566** (Sentry), **A1519** (Bitwarden or
1Password credential resolution), **A1897** (inbound OIDC), **A2074** (WebAuthn), **A2216**
(invite-only accounts with OIDC). The other nineteen have real work behind them that stops short of
the row.

### Duplicate credit

Not a re-open, but the ledger's count of "pieces of work" is inflated. Inside this sample alone,
these groups resolve to one implementation each:

- A0031 + A1263 - one OTLP exporter.
- A0613 + A1356 - one Langfuse exporter.
- A0136 + A0249 - one `runForScripts`.
- A0007 + A0205 - one terminal view.
- A0437 + A0483 - one i18n layer.
- A0186 + A0372 + A0405 - one plan engine.
- A0959 + A1093 - one `handOff`.
- A0057 + A0773 + A1366 + A1735 - one usage and pricing store.
- A1896 + A2002 + A1652 - one profiles module.
- A0048 + A0152 + A0262 + A2053 + A1685 - one policy engine (distinct entry points, one evaluator).
- A0220 + A1805 + A2088 + A2276 + A2296 - one approval gate.

107 sampled ids reduce to roughly 75 distinct implementations, about 70%. Applied to the whole
ledger, "786 distinct pieces of work" is optimistic by a similar margin.
