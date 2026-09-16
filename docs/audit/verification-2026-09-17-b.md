# Ledger verification, 2026-09-17 (b): the rest of the ticked ledger

The 2026-09-17 pass checked 107 of the single ids ticked `[x]` in issues #55-#92 and re-opened 24 of
them. This pass takes **every remaining ticked single id that report did not cover (164)**, plus the
**56 ids ticked `(0.15.0)` while it ran** - 220 in all. Together the two passes have now checked all
327 ids that have ever carried a tick.

## Scope

- Ticked single ids when this pass began: **247** (271 minus the 24 the first pass un-ticked). Minus
  the 107 that report names, **164** remained. That is the main list below.
- While the pass ran, 56 more were ticked `(0.15.0)` in issues #57, #58, #59, #61, #62, #74, #81,
  #84, #85 and #92. They are the addendum, judged to the same bar, and counted in the totals.
- The 24 ids the first pass re-opened are out of scope by definition - they are no longer ticked.
  Nobody has re-checked them against the newer code, and that is worth knowing.

**Tree.** The main list was read on `wave2/integration` at `35f4645`; the addendum on `8818ffa`,
after the `(0.15.0)` branches landed. Only five files under `src/` and `tests/` differ between those
two commits, so no verdict in the main list changed, and the cited `tests/web-ui.test.mjs` lines were
re-checked and are unmoved.

The first pass read `f89d6b4`. 146 files and roughly 15,000 lines of `src/` and `tests/` landed
between that commit and `35f4645`, so the two passes are not reading the same code: several of the
first pass's NOT FOUND verdicts may be stale. A0823 (LangSmith) is a worked example - it is verified
below on code that did not exist when the first pass ran. Re-checking the first pass's own verdicts
on this tree was not in scope here.

## Method

Unchanged from the first pass, and deliberately so: a combined ledger read against two different bars
would be worthless.

For each id: read `capability` and `detail` in `audit-assessment.json`, then find code on this tree
and a test that asserts the behaviour. `status`, `note` and `evidence` in that file are the
**pre-build** verdict, not the promise; `evidence` was not used as a search seed.

- **VERIFIED**: code named, and a test that exercises the behaviour named. A docs mention, a builder
  report, or a test that only asserts a symbol exists does not count.
- **PARTIAL**: part of the row's mechanism is on the tree and a materially distinct part named by the
  row is not.
- **NOT FOUND**: no code for the promised capability, or no test.

The first pass's two rules are carried over: **shared implementations still verify** (the duplication
is reported at the end as a counting problem, not as a re-open), and **a different transport is not a
missing capability**.

### The discriminator that decides about thirty rows here

Many rows name a third-party product. The rule applied throughout:

- If the row's **mechanism** exists on this tree through Branch's own equivalent, the named vendor is
  a transport. VERIFIED, with the deviation written on the line. So A0747 (Chroma) is verified on the
  local vectors table, A2266 (Kokoro) on Windows SAPI, A1894 (Azure, Mistral) on the OpenAI, Gemini
  and Windows routes, A0742 (Firecrawl) on Branch's own search connection, A1139 (Transformers) and
  A1788 (vLLM, SGLang, llama.cpp) on Ollama, LM Studio and the OpenAI-compatible loopback route every
  one of those servers speaks, A2110 (a JSONL session backend) on the app's own SQLite store.
- If the row's whole content is the vendor and Branch has **no equivalent mechanism at all**, it is
  NOT FOUND. So A1418 (PostHog) - there is no product telemetry of any kind; A2131, A2152 and A2160
  (E2B, Docker, nsjail) - there is no sandbox of any kind; A2103 (Codex CLI, Claude CLI, Copilot) -
  there is no CLI-delegating provider.
- Where the row's value **is** the breadth of named backends and only one ships, that is PARTIAL:
  A0947 (Milvus, Qdrant, Elasticsearch, MongoDB), A0784, A1921, A2363.

The same test that separates these two: does a generic protocol already carry the named product?
vLLM and llama.cpp speak OpenAI-compatible HTTP, so the generic route genuinely reaches them. Qdrant
and Pinecone do not share a protocol, so an adapter each is real, unwritten work.

### Three rows are phrased as gaps

A1639 ("No browser file-upload control"), A1640 ("No image task inputs") and A1904 (whose `detail` is
itself a debunking note about an empty manifest) name what the upstream project *cannot* do. A tick
means the gap was closed, so these were verified by looking for the capability, not its absence. All
three are closed on this tree.

### Coverage limitations

- `tests/secrets-sandbox.test.mjs` is still deny-blocked in this environment and could not be read or
  grepped. It is the test home for PII handling (A0875). Following the first pass's A0877 precedent,
  A0875 is verified on its source with that stated, and was not re-opened for a test nobody here can
  read. No other id in this batch depends on that file.
- `tests/screen-control.test.mjs` and `tests/desktop*.test.mjs` may not be run. Their assertions were
  read; A0230, A1450 and A2311 are judged from them. `screen-control` is also opt-in
  (`BRANCH_SCREEN_TESTS=1`) and does not run in a default pass.
- Nothing was run: no build, no test execution. Every verdict is from reading source and tests.

**Un-tick convention.** As before: the line keeps everything the issue already said and only the
marker and the version note change -
`- [ ] \`A1234\` (was ticked in 0.13.0; re-opened: <reason>) **Capability** …`.

## Verdicts

### #56 models.cloud-providers

- **A0051** VERIFIED - src/gemini-signin.ts Google sign-in whose token is sent as a bearer, with a route reporting whether one is set up; tests/polish-observability.test.mjs:66,78,96, tests/voice-providers.test.mjs:403
- **A0167** VERIFIED - src/local-models.ts OllamaClient and LmStudioClient list, download and load models on this computer; tests/local-models.test.mjs:80,104,138
- **A0498** VERIFIED - src/providers.ts OpenAI-compatible adapter pointed at a loopback endpoint, guarded by src/local-models.ts assertOnThisComputer; tests/local-models.test.mjs:132,264
- **A0576** VERIFIED - src/model-profiles.ts RoutingProfile/routeByProfile choosing a connection per task kind in rule order and saying which rule fired; tests/voice-providers.test.mjs:359
- **A0735** VERIFIED - src/model-switch.ts switchModel/parseModelCommand changing the model for one conversation mid-session; tests/voice-providers.test.mjs:327, tests/polish-observability.test.mjs:796
- **A1012** NOT FOUND - no AI SDK anywhere in src and no gateway resolution layer; the model layer takes Branch's own provider presets only
- **A1139** VERIFIED - the same local-model serving credited to A0167, src/local-models.ts; tests/local-models.test.mjs:80,104 (deviation: Ollama and LM Studio, not a Transformers pipeline)

### #57 documents-and-rag

- **A0163** VERIFIED - src/knowledge-bases.ts indexes configured folder sources and the base is prepended to the run with numbered sources; tests/rag-vector.test.mjs:294
- **A0785** VERIFIED - src/knowledge-tools.ts knowledgeApi routes plus public/knowledge.js over the same store; tests/rag-vector.test.mjs:380
- **A0830** VERIFIED - src/knowledge-bases.ts create, reindex and search over folder sources; tests/rag-vector.test.mjs:222
- **A0839** VERIFIED - src/document-readers.ts + src/chunking.ts + src/documents.ts read, segment and load files; tests/documents.test.mjs:100,201, tests/docs-memory-2.test.mjs:246
- **A0867** VERIFIED - src/knowledge-bases.ts owner-scoped kb_collections/kb_chunks with create, search and remove routes; tests/rag-vector.test.mjs:380, tests/documents.test.mjs:241
- **A0946** PARTIAL - has: pdf, docx, xlsx, pptx, odt, ods, epub, rtf and text readers with overlapping chunking, src/document-readers.ts:41, tests/docs-memory-2.test.mjs:95,114,163; missing: image documents - no OCR or vision reader, tests/rag-vector.test.mjs:222 counts picture.png as unread and tests/docs-memory-2.test.mjs:187 has a picture-PDF say so rather than read it
- **A0993** VERIFIED - src/chunking.ts markdownSections windows with overlap and the same document always gives the same passages; tests/rag-vector.test.mjs:178, tests/documents.test.mjs:91
- **A1260** VERIFIED - the same knowledge-base retrieval credited to A0830, src/knowledge-bases.ts search; tests/rag-vector.test.mjs:222,294
- **A1279** VERIFIED - chunk, embed, retrieve and answer end to end, src/chunking.ts + src/embeddings.ts + src/knowledge-tools.ts askKnowledge; tests/rag-vector.test.mjs:274
- **A1280** VERIFIED - src/knowledge-tools.ts registers knowledge.create/reindex/search/ask so the agent picks what to retrieve; tests/rag-vector.test.mjs:274-292 executes them through the tool registry
- **A1392** VERIFIED - the same retrieval-augmented answer path credited to A1279, src/knowledge-tools.ts askKnowledge; tests/rag-vector.test.mjs:274
- **A1545** VERIFIED - src/document-analysis.ts documents.analyse feeds extracted document text to the model with the heading it came from; tests/docs-memory-2.test.mjs:327,332,346
- **A1668** NOT FOUND - no summarisation over a knowledge base in src/knowledge-bases.ts or src/knowledge-tools.ts; knowledge.ask answers one question from passages, it does not summarise the accumulated base
- **A1868** VERIFIED - the same retrieve-then-generate path credited to A1279; tests/rag-vector.test.mjs:274
- **A1869** VERIFIED - src/documents.ts adds, re-reads, segments, indexes and removes a workspace file; tests/documents.test.mjs:201,241
- **A1886** VERIFIED - src/knowledge-bases.ts embeds chunks into the vectors table and queries them by similarity; tests/rag-vector.test.mjs:222,368
- **A1888** VERIFIED - src/knowledge-tools.ts create/add/remove/collections behind documents.read and documents.write; tests/rag-vector.test.mjs:380, tests/documents.test.mjs:201
- **A1919** VERIFIED - src/knowledge-tools.ts askKnowledge chats against indexed workspace documents through the configured model; tests/rag-vector.test.mjs:274,294
- **A1941** VERIFIED - src/knowledge-bases.ts dense search plus src/bm25.ts sparse ranking and fuseRanks, with src/retrieval.ts lexicalRerank/modelRerank; tests/rag-vector.test.mjs:203, tests/sdk-misc.test.mjs:325,334
- **A1990** VERIFIED - src/documents.ts upload path indexes the file through the same embedding pipeline; tests/documents.test.mjs:201,241
- **A2124** VERIFIED - src/knowledge-bases.ts search with a word-only fallback that says so when no embedding model is configured; tests/rag-vector.test.mjs:262, tests/documents.test.mjs:123

### #58 dashboards-and-observability

- **A0202** VERIFIED - src/usage.ts UsageStore aggregates tokens and cost per session, preset and channel; tests/cost-trace.test.mjs:116,154
- **A0269** VERIFIED - the same usage and pricing store credited to A0202, with byChannel and byConversation rows; tests/cost-trace.test.mjs:116,154
- **A0295** PARTIAL - has: src/trajectory.ts buildTrajectory persisted and read back for inspection and scoring, tests/polish-observability.test.mjs:550, tests/evaluation-2.test.mjs:178; missing: replay of a recorded trajectory - the same gap the first pass already re-opened as A1481
- **A0296** VERIFIED - public/compare.js compare panel over src/usage.ts statistics(); tests/polish-observability.test.mjs:322,352
- **A0346** VERIFIED - src/pricing.ts estimateCost shown on the usage screen and the month card; tests/cost-trace.test.mjs:154, tests/polish-observability.test.mjs:422
- **A0420** VERIFIED - src/pricing.ts TokenCounts/estimateCost counted once per task, not once per round; tests/cost-trace.test.mjs:103,116
- **A0458** VERIFIED - src/trajectory.ts trajectoryLines writes the whole record as JSON Lines against a declared format; tests/polish-observability.test.mjs:550,569
- **A0459** VERIFIED - src/usage.ts cumulative monthly tokens and dollars; tests/cost-trace.test.mjs:116,181
- **A0503** VERIFIED - model rounds record prompt and completion tokens on the run, src/usage.ts RunCost; tests/cost-trace.test.mjs:103,116
- **A0565** VERIFIED - the same token and cost accounting credited to A0202 and A0420; tests/cost-trace.test.mjs:50,116
- **A0592** VERIFIED - src/metering.ts meteringTick/writeMeteringFile write the month's usage on a schedule, inside the workspace; tests/polish-observability.test.mjs:478,512
- **A0637** VERIFIED - src/usage.ts TimelineEntry types (model.started/completed, tool.started/completed, permission, retry, stall, delegation) streamed by src/streams.ts; tests/polish-observability.test.mjs:373
- **A0706** VERIFIED - src/usage.ts statistics() plus byChannel aggregates for task and channel figures; tests/polish-observability.test.mjs:352, tests/cost-trace.test.mjs:116
- **A0707** VERIFIED - src/store.ts events() persists typed task events read back per run; tests/delegation.test.mjs:46,108
- **A0883** VERIFIED - src/metrics.ts behind the authenticated /api/metrics route plus /api/usage run, session and model analytics; tests/tracing-policy.test.mjs:436,450, tests/polish-observability.test.mjs:352
- **A0929** VERIFIED - src/usage.ts sums provider-reported token figures by model across calls; tests/cost-trace.test.mjs:103,116
- **A1148** VERIFIED - src/usage.ts TimelineEntry carries duration and result per step over the spans table; tests/polish-observability.test.mjs:373, tests/tracing-policy.test.mjs:105
- **A1390** VERIFIED - the same trajectory capture credited to A0458, src/trajectory.ts; tests/polish-observability.test.mjs:550,581
- **A1419** VERIFIED - src/pricing.ts CostConfidence table/override/unknown, so an unpriced model leaves cost unavailable rather than zero; tests/cost-trace.test.mjs:50,81,284
- **A1547** VERIFIED - delegated runs leave typed events (delegation.fanout, delegation.unresolved) under the parent; tests/delegation.test.mjs:46,108

### #60 other

- **A0174** PARTIAL - has: GitHub and Linear issue context pulled into a task as cited passages, src/integrations/issue-context.ts, tests/sdk-misc.test.mjs:370,391,431, plus GitLab read tools in src/integrations/gitlab.ts:90; missing: Jira entirely, and GitLab is not one of the trackers issue context understands (src/integrations/issue-context.ts:13)
- **A0300** PARTIAL - has: the pull-request description template and the tool that opens one, src/integrations/issue-context.ts:95 + src/integrations/git-tools.ts:208, tests/sdk-misc.test.mjs:461, tests/git.test.mjs:269; missing: a hook that turns a finished run's patch into a pull request - src/hooks.ts:10 events only run an external program afterwards
- **A0308** VERIFIED - packages/sdk/client.mjs BranchClient with types.d.ts, reading the address and key an install already wrote; packages/sdk/test/sdk.test.mjs:37,44,53, run by the package test script
- **A0326** VERIFIED - src/practice-workspace.ts makes a sample workspace and demo conversation and switches back out of it; tests/sdk-misc.test.mjs:278,304
- **A0370** VERIFIED - src/ask-first.ts puts questions with suggested answers before a long request starts and folds the answers in underneath; tests/sdk-misc.test.mjs:244,255,265
- **A0434** VERIFIED - tools sorted into kinds with one decision per kind expanding to a rule per tool, auto-approval off by default; tests/sdk-misc.test.mjs:161,181,196
- **A0447** VERIFIED - public/inspector.js reads saved trajectories in the browser, the same viewer credited to A0285; tests/web-ui.test.mjs:132, tests/polish-observability.test.mjs:550
- **A0575** VERIFIED - src/provider-plugins.ts driver abstraction where a plugin registers plugin.provider.<id> as a factory and brings its own connection; tests/sdk-misc.test.mjs:505,539,558
- **A0395** VERIFIED - src/triggers.ts signed trigger endpoint fills a prompt from the posted body and starts a task, with src/integrations/linear.ts LinearAccess reading the issue; tests/triggers-webhooks.test.mjs:123, tests/sdk-misc.test.mjs:431,441 (deviation: one generic trigger any service including Linear can post to, not a Linear-specific webhook binding)
- **A0817** VERIFIED - src/retrieval.ts Retriever interface with DocumentRetriever and MemoryRetriever behind one query call; tests/sdk-misc.test.mjs:346
- **A0995** VERIFIED - src/retrieval.ts lexicalRerank and modelRerank reorder retrieved passages, falling back when the model answer is unusable; tests/sdk-misc.test.mjs:319,331

### #61 evaluation-and-benchmarks

- **A0078** VERIFIED - src/tool-evaluations.ts builtInToolSuites/runToolEvaluations run shipped cases against the tools that are installed; tests/evaluation-2.test.mjs:434,470
- **A0570** VERIFIED - src/benchmark-adapters.ts five adapters (GAIA, code, SWE-bench, web, terminal-bench) driven by src/benchmarks.ts; tests/evaluation-2.test.mjs:191,199,242,277
- **A0926** VERIFIED - src/evaluation-runner.ts SuiteRunner over a suite's tasks with per-task outcomes, aggregate accuracy and a concurrency setting; tests/evaluation-2.test.mjs:128,327, tests/evaluation-more.test.mjs:90,181
- **A0927** PARTIAL - has: normalised exact match, src/evaluation-scorers.ts:54 with normalise(), tests/evaluation-2.test.mjs:37,106; missing: token-level F1 and the passage-match metric - no overlap or F1 scorer exists in src
- **A1010** VERIFIED - src/evaluation-run.ts EvaluationGateSchema fails a run against minAccuracy and maxDollars and says exactly why; tests/evaluation-2.test.mjs:112,453
- **A1128** VERIFIED - src/evaluation-runner.ts TaskOutcome/SuiteRun result shapes with src/evaluation-scorers.ts ScorerSchema evaluators; tests/evaluation-2.test.mjs:37,128
- **A1691** VERIFIED - src/benchmark-adapters.ts exported adapters driven by the branch eval command; tests/evaluation-2.test.mjs:191,470
- **A1765** VERIFIED - src/evaluation-scorers.ts kind "url" matches the address the run ended at against a pattern; tests/evaluation-2.test.mjs:44
- **A1766** NOT FOUND - no HTML or DOM scorer; src/evaluation-scorers.ts:76 scorerKinds lists twelve kinds and none queries page markup

### #62 browser-automation

- **A1639** VERIFIED (the row names a gap, and the gap is closed) - src/integrations/browser.ts:258,515 browser.upload sets input files and refuses a path outside the workspace; tests/browser-2.test.mjs:106,110, tests/browser-more.test.mjs:184
- **A2129** VERIFIED - src/citations.ts records each page read as a numbered, deduplicated source with a quote; tests/data-research.test.mjs:180,187
- **A2241** VERIFIED - src/integrations/browser-attach.ts attaches to a real browser over CDP and src/integrations/browser-profiles.ts keeps signed-in state under its own key; tests/browser-2.test.mjs:344,349,357

### #63 tracing-and-telemetry

- **A0056** PARTIAL - has: OTLP traces and metrics, src/trace.ts + src/tracing-shapes.ts metricsToOtlp, tests/tracing-policy.test.mjs:250, tests/cost-trace.test.mjs:257; missing: the logs signal the row names - src/tracing-export.ts:75 endpointFor knows only traces and metrics
- **A0155** NOT FOUND - no telemetry client of any kind; tests/tracing-policy.test.mjs:473 asserts the opposite is promised in writing, that Branch "sends no usage data to anyone" and never will
- **A0225** NOT FOUND - no anonymous usage metrics and therefore no opt-out control; the local counters are never sent anywhere, tests/tracing-policy.test.mjs:473
- **A0270** NOT FOUND - no telemetry package or product-event client in src; tests/tracing-policy.test.mjs:473
- **A0385** NOT FOUND - no best-effort telemetry to opt out of; the stated position is that nothing is collected in the first place, tests/tracing-policy.test.mjs:473
- **A0597** VERIFIED - the same OTLP span export credited to A0031, src/trace.ts + src/tracing-export.ts otlp destination; tests/tracing-policy.test.mjs:250
- **A0823** VERIFIED - src/tracing-shapes.ts:90 spansToLangsmith (runs list, parent_run_id, run_type, error) and the langsmith destination in src/tracing-export.ts:17; tests/tracing-policy.test.mjs:270,389
- **A0882** VERIFIED - src/tracing-api.ts GET /api/tracing/spans over the stored spans, refused to anyone but the owner; tests/tracing-policy.test.mjs:414
- **A0972** VERIFIED - src/tracing.ts Tracer/SpanStore capture model, tool and delivery spans and src/tracing-export.ts exports them; tests/tracing-policy.test.mjs:105,250
- **A1127** VERIFIED - src/tracing.ts nested spans carry parent ids through a run and are reshaped for three destinations; tests/tracing-policy.test.mjs:105,270
- **A1189** VERIFIED - src/metrics.ts collectMetrics/histogram/prometheusText record runtime metrics; tests/tracing-policy.test.mjs:433,454,467
- **A1303** VERIFIED - the same OTLP traces and metrics credited to A0031 and A0597; tests/tracing-policy.test.mjs:250, tests/cost-trace.test.mjs:257
- **A1418** NOT FOUND - no PostHog client, no anonymous identifier and no ANONYMIZED_TELEMETRY switch anywhere in src; tests/tracing-policy.test.mjs:473

The five NOT FOUND rows here are one finding, not five: Branch has a documented, tested position that
it collects and sends nothing. That is a legitimate product decision, but it is not what these five
ticks claim, so they are re-opened with the non-goal named on the line. If the owner wants them
closed as "will not build" rather than "to build", that is a change to the ledger's vocabulary, not
to this verdict.

### #64 web-ui

- **A0731** VERIFIED - src/playground.ts behind public/playground.js runs a read-only tool and shows what came back, asking first when the rules say so; tests/web-ui.test.mjs:280,300
- **A1302** VERIFIED - an approval question blocks the call and appears both in the conversation and in a channel with buttons; tests/web-ui.test.mjs:228, tests/polish-observability.test.mjs:187
- **A1904** VERIFIED (the row is a debunking note, and what it debunked is now real) - public/manifest.webmanifest and public/service-worker.js are served and registered, skipped inside the desktop app, with an offline banner; tests/web-ui.test.mjs:322,360

### #65 voice-io

- **A0328** VERIFIED - src/voice-stt.ts LocalSpeechSchema/localSttArgs build the configured local speech program's command line and the transcription is submitted as a message; tests/voice-providers.test.mjs:91,108 (deviation: submitted from the voice route and the channel pipeline, not a terminal subcommand)
- **A0888** PARTIAL - has: typed image inputs on the run API (src/server.ts:837) reaching the model as image parts, tests/media.test.mjs:257; missing: typed Audio and Video run inputs - audio and video are tool arguments only (media.transcribe, media.info), never run inputs
- **A0970** VERIFIED - src/voice-talk.ts TalkMode transcribes, runs the task and reads the answer back, cycling idle, listening, thinking and speaking; tests/voice-providers.test.mjs:306
- **A1001** VERIFIED - src/voice-stt.ts Transcription and src/voice-tts.ts Speech as the listening and speaking interfaces, three routes each; tests/voice-providers.test.mjs:56,158
- **A1894** VERIFIED - src/voice-api.ts authenticated speech route dispatching to the configured engine and refusing every route that would send audio away when told to keep it here; tests/voice-providers.test.mjs:158,220,235 (deviation: OpenAI, Gemini and Windows SAPI rather than Azure or Mistral)
- **A1995** PARTIAL - has: registered TTS routes synthesising text to audio, src/voice-tts.ts Speech, tests/voice-providers.test.mjs:158,220; missing: streamed audio chunks from a live agent - src/voice-talk.ts:60 states realtime sessions are deliberately not built
- **A2067** VERIFIED - src/voice-stt.ts transcribes a voice note arriving on a channel and refuses in words when it cannot; tests/voice-providers.test.mjs:108,137
- **A2068** PARTIAL - has: TTS delivery back to the channel, src/voice-tts.ts + src/voice-talk.ts, tests/voice-providers.test.mjs:108,306; missing: wake voice and duplex calls - no wake-word code in src, and src/voice-talk.ts:60 refuses realtime two-way voice outright
- **A2107** VERIFIED - src/media.ts media.speak generates spoken audio that is then delivered; tests/media.test.mjs:174,352, tests/voice-providers.test.mjs:108
- **A2266** VERIFIED - src/voice-tts.ts sapiScript/powershellArgs synthesise speech on this computer with nothing sent away; tests/voice-providers.test.mjs:158,183,235 (deviation: Windows SAPI, not a Kokoro bridge)

### #68 mcp-server-mode

- **A0636** VERIFIED - src/mcp-policy.ts dryRunPlan answers a call with what it would do and writes nothing; tests/mcp-mode.test.mjs:263,268,279
- **A1342** VERIFIED - src/mcp-policy.ts:43 preflight checks the exposed tool surface against the frozen policy before anything is offered; tests/mcp-mode.test.mjs:217,221,244
- **A2082** VERIFIED - src/mcp-server.ts offers browser tools to an MCP client under the policy cap, over the CDP bridge in src/integrations/browser-attach.ts; tests/mcp-mode.test.mjs:227,244,253

### #71 models.local-runtimes

- **A1788** VERIFIED - src/local-models.ts Ollama and LM Studio clients plus the OpenAI-compatible loopback route every other local server speaks; tests/local-models.test.mjs:104,138,264
- **A2365** VERIFIED - the same local adapter credited to A1788, with assertOnThisComputer keeping it on loopback; tests/local-models.test.mjs:132,224

### #72 cli-and-tui

- **A0012** PARTIAL - has: src/cli-run.ts runForScripts emitting one JSON object per line under --json with the human line on stderr and contract exit codes, tests/cli-tui.test.mjs:163,179; missing: resuming or forking a thread from the non-interactive path - src/cli-run.ts:45 parseRunArgs has no session, resume or fork flag
- **A0183** VERIFIED - src/cli.ts subcommand dispatch, src/terminal-tui.ts terminal view, and a setup flow that ends in a real test call; tests/cli-tui.test.mjs:215,244, tests/onboarding.test.mjs:33
- **A1211** VERIFIED - branch chat over src/terminal-tui.ts, falling back to a plain view where there is no terminal; tests/cli-tui.test.mjs:61,150
- **A2103** NOT FOUND - no Codex CLI, Claude CLI or Copilot provider in src/providers/; the folder holds azure-openai, bedrock, cohere, gemini, ollama and openai-responses only

### #74 memory-features

- **A2186** VERIFIED - src/memory-consolidate.ts nightly pass plus src/knowledge-cards.ts turning a conversation into card suggestions; tests/rag-vector.test.mjs:349, tests/docs-memory-2.test.mjs:376
- **A2187** VERIFIED - the shipped tidying recipe sits in the owner's list as a proposal, staging suggestions and deleting nothing, src/memory-tidy.ts + src/recipes.ts; tests/docs-memory-2.test.mjs:475,501
- **A2230** VERIFIED - SQLite memory with embeddings, layers and projects plus a JSONL export that round-trips; tests/docs-memory-2.test.mjs:562,578, tests/memory-context.test.mjs:267
- **A2245** VERIFIED - src/memory-evaluation.ts reports a hit rate before and after the nightly pass, beside the tidying pass; tests/docs-memory-2.test.mjs:475,528

### #75 vector-and-hybrid-memory

- **A0278** VERIFIED - src/memory-retrieval.ts MemoryRetrieval indexes and recalls memory records by embedding; tests/rag-vector.test.mjs:330
- **A0417** VERIFIED - src/embeddings.ts with src/vector-store.ts SqliteVectors.search behind semantic retrieval; tests/rag-vector.test.mjs:151,330
- **A0747** VERIFIED - src/memory-retrieval.ts semantic recall over stored facts, finding a paraphrase plain word search misses; tests/rag-vector.test.mjs:330 (deviation: the local vectors table, not Chroma)
- **A0784** PARTIAL - has: one indexing and retrieval path over the VectorBackend interface, src/vector-store.ts, tests/rag-vector.test.mjs:151,368; missing: the multiple vector databases the row names - SqliteVectors is the only backend, and tests/rag-vector.test.mjs:374 asserts the store is "this computer"
- **A0818** VERIFIED - src/vector-store.ts:24 VectorBackend interface (upsert, search, count, remove) with topK similarity over a query and a result limit; tests/rag-vector.test.mjs:151
- **A0838** VERIFIED - src/knowledge-bases.ts builds and exports a queryable vector index over a collection; tests/rag-vector.test.mjs:222,368
- **A0947** PARTIAL - has: the SqliteVectors backend credited to A0818; missing: every store the row names - no Milvus, Qdrant, Elasticsearch or MongoDB code in src
- **A1225** VERIFIED - src/retrieval.ts Retriever abstraction over src/vector-store.ts, used by both document and memory retrieval; tests/sdk-misc.test.mjs:346, tests/rag-vector.test.mjs:330
- **A1363** VERIFIED - src/knowledge-tools.ts KnowledgeRetriever registered as agent tools that delegated specialists can call; tests/rag-vector.test.mjs:274,294
- **A1373** VERIFIED - src/knowledge-bases.ts combines vector search with src/bm25.ts keyword ranking over chunks; tests/rag-vector.test.mjs:203,222
- **A1670** VERIFIED - src/documents.ts indexes the person's own files and retrieves them before the task; tests/documents.test.mjs:181,201
- **A1921** PARTIAL - has: the pluggable VectorBackend interface, src/vector-store.ts:24; missing: any second adapter behind it - one implementation ships, so nothing is switchable in practice
- **A2363** PARTIAL - has: the single SQLite vector backend credited to A0818; missing: configuring and querying multiple backends - no backend selection setting exists

### #76 media-generation

- **A1996** VERIFIED - src/media.ts media.image posting to /images/generations, the artifact gallery route and public/media.js; tests/media.test.mjs:77,257
- **A2025** PARTIAL - has: image parts converted for two provider shapes, src/providers.ts:216,246 and src/providers/openai-responses.ts:45, plus uploaded files on the composer, tests/media.test.mjs:257,330; missing: audio message parts - no adapter turns an audio part into API content
- **A2106** VERIFIED - src/media.ts media.describe sends the image file to the model as an image part, and a text-only model says so; tests/media.test.mjs:149
- **A2184** VERIFIED - the same media.describe vision path credited to A2106, over the configured provider; tests/media.test.mjs:149
- **A2294** VERIFIED - src/media.ts registers the media tools with permissions and src/media-settings.ts routes the folder, the model and session-scoped artifacts; tests/media.test.mjs:301,352
- **A2321** VERIFIED - the same image-part tool result credited to A2106, src/media.ts media.describe; tests/media.test.mjs:149
- **A2368** VERIFIED - src/media-images.ts asks OpenAI's /images/generations and /images/edits for pictures; tests/media.test.mjs:77,108

### #77 desktop-automation

- **A0230** VERIFIED - src/integrations/desktop-script.ts and desktop-tools.ts drive pointer, keys and screenshots on this computer; tests/screen-control.test.mjs:120,152 (read, not run - the file is opt-in)
- **A1450** VERIFIED - the same screenshot, pointer, keyboard and window-control actions credited to A0230; tests/screen-control.test.mjs:120,283
- **A2311** VERIFIED - src/integrations/computer.ts registerComputer over a ComputerLayers abstraction with page and window backends; tests/browser-2.test.mjs:344,349,357 executes computer.look and computer.type against both

### #78 skills-and-recipes

- **A0608** VERIFIED - src/skill-revisions.ts versions skills the assistant drafts from tasks that went well and tests them against their own examples; tests/skills-plugins.test.mjs:199, tests/skills.test.mjs:35
- **A1827** VERIFIED - the same draft-from-experience path credited to A0608; tests/skills-plugins.test.mjs:199
- **A2112** VERIFIED - src/skill-governance.ts holds drafts under policy and src/skills.ts reads the active document back only with skills.read; tests/skills.test.mjs:127,146, tests/skills-ui.test.mjs:83,118
- **A2341** VERIFIED - create, edit, import, export and remove over the skills routes, with src/skill-revisions.ts:189 registerSkillSync for the owner's own folder; tests/skills-ui.test.mjs:38,68, tests/skills.test.mjs:159

### #80 sandboxing-and-isolation

- **A0875** VERIFIED - src/pii.ts detectPii/applyPiiGuard over five kinds with off, mask, warn and block actions; its test home tests/secrets-sandbox.test.mjs is deny-blocked here, so only the source was read - the same limitation the first pass recorded for A0877, and not re-opened for a test nobody here can read
- **A2028** PARTIAL - has: src/run-queue.ts atOnce holding work back beyond the limit, tests/collab-workflows.test.mjs:360,375; missing: a fixed-window per-session limiter and any discard behaviour - the queue only stalls, and per-minute limits live on a trigger, not on a session
- **A2131** NOT FOUND - no E2B and no sandbox backend anywhere in src; src/code-run.ts:16 says outright that this is a limit on resources, not a sandbox
- **A2152** NOT FOUND - no Docker anywhere in src; a script runs as an ordinary child process on this computer with the app's own reach
- **A2160** NOT FOUND - no box service and no Docker, nsjail or E2B backend, so nothing can refuse execution for want of one

### #81 file-and-code-tools

- **A0537** PARTIAL - has: src/code-map.ts and src/code-scanners.ts build a project map of declared names and imports, kept up to date file by file, tests/code-ide.test.mjs:33,62; missing: a real parser and the breadth - src/code-map.ts:15 states the names come from regular expressions rather than tree-sitter, and the test covers four languages, not thirty

### #82 context-management

- **A0074** VERIFIED - an oversized conversation is compacted into a hand-over summary while the recent turns and the stored history stay; tests/compaction-attention.test.mjs:27,59
- **A0857** VERIFIED - src/contracts.ts:203 Budget/BudgetError stops a run on tokens, with a dollar limit refusing new tasks in money; tests/cost-trace.test.mjs:194,210
- **A1640** VERIFIED (the row names a gap, and the gap is closed) - image files are accepted as task input and reach the model as image parts, src/server.ts:837; tests/media.test.mjs:257,330
- **A2023** VERIFIED - the compaction split keeps at least six recent messages and cuts at a user turn once the budget is exceeded; tests/compaction-attention.test.mjs:27,59
- **A2110** VERIFIED - src/sessions.ts and src/store.ts keep scoped sessions a later run resumes by id; tests/approvals.test.mjs:141, tests/memory-context.test.mjs:218 (deviation: the app's own SQLite store, not a JSONL backend)
- **A2269** VERIFIED - src/session-summary.ts SessionSummaries saves a summary and pinned messages for continuing context; tests/memory-context.test.mjs:218,232
- **A2379** VERIFIED - src/working-session.ts WorkingSessions carries the goal, file and tool of the request through the run; tests/memory-context.test.mjs:333

### #83 webhooks-and-triggers

- **A1816** VERIFIED - src/triggers.ts authenticated triggers (bearer or signature, replay protection, per-minute limit) fill a prompt and start a task; tests/triggers-webhooks.test.mjs:109,123,160

### #84 git-integration

- **A0388** VERIFIED - src/integrations/git-tools.ts git.commit and github.open_pull_request behind git.write and github.manage; tests/git.test.mjs:260,269
- **A0393** VERIFIED - github.issues, github.checks, github.create_issue and github.open_pull_request, with src/triggers.ts taking the inbound webhook that starts work; tests/git.test.mjs:260,269, tests/triggers-webhooks.test.mjs:123
- **A2333** VERIFIED - src/integrations/git-tools.ts:65 registerWorktrees adds, lists and removes parallel copies under .branch-worktrees and refuses an escaping name; tests/git.test.mjs:178,184,196

### #87 mobile-and-remote-access

- **A1699** VERIFIED (the row records a plan, and the plan has landed) - src/remote/remote-access.ts pairing with a QR code, plus the hand-off list a phone picks a conversation up from; tests/docs-memory-2.test.mjs:540, tests/web-ui.test.mjs:373
- **A2213** VERIFIED - public/shell.css breakpoints down to 560px, with the shell asserted to fit a 400 pixel window and keep its rows on screen; tests/web-ui.test.mjs:373

### #89 scheduling-and-automation

- **A0697** VERIFIED - src/calendar.ts bundled holidays feed src/scheduler.ts dayOffDecision, which skips or shifts a due run to the next working day; tests/collab-workflows.test.mjs:437,446
- **A0862** VERIFIED - src/workflows.ts persists step state and status (paused, waiting_approval, waiting_time, interrupted) in SQLite and carries on from it; tests/collab-workflows.test.mjs:151,239, tests/orchestration-2.test.mjs:414
- **A2073** VERIFIED - src/run-queue.ts serialises queued work by source priority under an atOnce limit, with cancel; tests/collab-workflows.test.mjs:360,370,387

### #90 multi-user-and-teams

- **A1901** PARTIAL - has: share links with a code, expiry, single use, listing, revoking and redaction, src/conversation-share.ts:152,178,187, tests/collab-workflows.test.mjs:78,101; missing: cloning a shared conversation - ShareLinks has no clone or fork path
- **A2226** VERIFIED - src/labels.ts comment/comments/removeComment over project_notes plus the label catalog, served at /api/projects/notes; tests/collab-workflows.test.mjs:132,136,146

### #91 research-pipeline

- **A0742** VERIFIED - src/research.ts breaks a question into sub-questions, searches each through src/integrations/web-search.ts, cross-checks and cites; tests/data-research.test.mjs:114,168 (deviation: Branch's own configured search connection, not Firecrawl)
- **A0743** PARTIAL - has: bounded page fetching, src/integrations/bounded-fetch.ts and web.ts, plus a real browser through src/integrations/browser.ts, tests/data-research.test.mjs:114,138; missing: a stealth route - no stealth, fingerprinting or anti-bot fetching path exists in src
- **A0931** VERIFIED - src/citations.ts Source/Citation normalise records into numbered source-linked markdown, and src/document-readers.ts ReadDocument carries content plus metadata; tests/data-research.test.mjs:180,187

## Addendum: the 56 ids ticked `(0.15.0)`

While this pass was running, 56 further ids were ticked with the marker `(0.15.0)` in issues #57,
#58, #59, #61, #62, #74, #81, #84, #85 and #92, from the coder-toolbox, browser pass 2, chat
services, benchmarks and documents/memory branches. They are checked here to the same bar, on the
`wave2/integration` tip as it stood after those branches landed - the branch was moved from `35f4645`
to **`8818ffa`** for this addendum. Only five files under `src/` and `tests/` differ between those two
commits (design-qa screenshots and web-ui additions), so no verdict above changed; the cited
`tests/web-ui.test.mjs` line numbers were re-checked and are unmoved.

### #57 documents-and-rag (addendum)

- **A1667** VERIFIED - src/knowledge-cards.ts turns a conversation into card suggestions that, once accepted, land in the knowledge base as structured rows; tests/docs-memory-2.test.mjs:376,404

### #58 dashboards-and-observability (addendum)

- **A1522** VERIFIED - src/integrations/browser-trace.ts startRecording keeps a real Playwright trace archive per run, scrubbed of keys; tests/browser-2.test.mjs:297,301,307,311

### #59 messaging-channels

- **A0115** VERIFIED - src/channels/connectors.ts and router.ts configure, launch, persist and track connections for Telegram, Slack, Discord, WhatsApp and Google Chat; tests/channels-2.test.mjs:161,496 (deviation: Linear is an issue tracker here, not a chat connector)
- **A2014** VERIFIED - data/channels.json plus src/channels/catalog.ts are the registration framework, and src/channels/connectors.ts loads plugin-brought adapters; tests/channels-2.test.mjs:161,450 (deviation: no QQ and no WeChat Official Accounts; the row names its list as "including")
- **A2034** VERIFIED - DingTalk, Feishu/Lark and WeCom all ship as catalog entries driven end to end; tests/channels-2.test.mjs:237,248,260
- **A2066** NOT FOUND - none of the four channels the row names exists: no Reddit, Twitch, Twitter/X or Nostr adapter in src/channels/ or data/channels.json
- **A2091** VERIFIED - Feishu/Lark and the WeCom group robot are both catalog entries, the latter declared send-only; tests/channels-2.test.mjs:237,248
- **A2117** PARTIAL - has: Feishu, DingTalk, WeCom and LINE, data/channels.json, tests/channels-2.test.mjs:161,237,248,260; missing: Weixin (consumer WeChat) and QQ - neither is a catalog entry and neither speaks the webhook shape the catalog carries
- **A2156** PARTIAL - has: Discord, Telegram, Slack, LINE, DingTalk, Lark and the WeChat-family WeCom robot, src/channels/, tests/channels-2.test.mjs:161; missing: KOOK and QQ, which have their own protocols and no adapter here
- **A2238** VERIFIED - src/channels/telegram.ts, discord.ts, slack.ts and whatsapp.ts alongside the catalog services; tests/channels-2.test.mjs:161,496
- **A2255** VERIFIED - Feishu, DingTalk and the WeCom robot beside src/channels/slack.ts; tests/channels-2.test.mjs:237,248,260
- **A2295** VERIFIED - src/channels/connectors.ts ChannelConnectors registers a plugin-brought chat service, connects it and delivers through it, under the network rules; tests/channels-2.test.mjs:450,628
- **A2349** PARTIAL - has: GitHub issues, Discord, Slack, Telegram and email, src/integrations/git-tools.ts:160 and src/channels/, tests/channels-2.test.mjs:161, tests/git.test.mjs:260; missing: IRC - there is no IRC adapter, and Matrix is not one

### #61 evaluation-and-benchmarks (addendum)

- **A0248** VERIFIED - src/tracing-export.ts OTLP exporters beside the SWE-bench adapter in src/benchmark-adapters.ts:143; tests/tracing-policy.test.mjs:250, tests/evaluation-2.test.mjs:242
- **A0297** VERIFIED - src/benchmark-adapters.ts:143 applies the instance's test patch and runs the repository's own tests to decide; tests/evaluation-2.test.mjs:229,242
- **A0347** VERIFIED - src/benchmarks.ts orchestration with src/study.ts studyTable/compareStudies analysing the results; tests/evaluation-2.test.mjs:214,407
- **A0375** VERIFIED - src/reliability.ts completion review catches an answer that quietly gave up and blames the checks rather than the scorers; tests/evaluation-2.test.mjs:73,152
- **A0460** VERIFIED - the same SWE-bench adapter credited to A0297; tests/evaluation-2.test.mjs:229,242
- **A0499** VERIFIED - src/benchmark-adapters.ts:92 code-tasks adapter (APPS, MBPP, HumanEval) run from the branch eval command; tests/evaluation-2.test.mjs:214,470
- **A0571** VERIFIED - the same SWE-bench runner credited to A0297, refusing when the repository is not on this computer; tests/evaluation-2.test.mjs:229,242
- **A0724** VERIFIED - the same SWE-bench runner credited to A0297; tests/evaluation-2.test.mjs:242
- **A0725** VERIFIED - src/benchmark-adapters.ts:258 terminal-bench adapter reads task.md and keeps tests.sh out of the workspace until the run is over; tests/evaluation-2.test.mjs:277
- **A0973** PARTIAL - has: src/testing.ts ScriptedProvider and ScriptedTools as shipped model and tool doubles, tests/testing-utilities.test.mjs:13,33,51; missing: the realtime, voice and sandbox doubles the row names - src/testing.ts ships neither, and the voice fakes live in the test folder, not in the product
- **A1190** VERIFIED - src/evaluation-suites.ts eval sets scored by src/evaluation-scorers.ts over both the answer and the trajectory, rubric scorer included; tests/evaluation-2.test.mjs:55,83,128
- **A1231** PARTIAL - has: the BenchmarkAdapter interface with a GAIA implementation, src/benchmark-adapters.ts:45, tests/evaluation-2.test.mjs:191,199; missing: a Nexus implementation - the five adapters are GAIA, code-tasks, SWE-bench, web-tasks and terminal-bench
- **A1252** VERIFIED - src/benchmarks.ts runs a benchmark's tasks end to end from the branch eval command; tests/evaluation-2.test.mjs:214,470 (deviation: Branch's own runner over its five adapters, not AGBench)
- **A1253** VERIFIED - src/study.ts studyTable/studyLines tabulate a run's cells and src/cli.ts lists studies from the command line; tests/evaluation-2.test.mjs:327,470 (deviation: the study table, not the AGBench CLI)
- **A1550** VERIFIED - src/study.ts runs a study over a benchmark, preparing a folder per task and marking it with the benchmark's own judge; tests/evaluation-2.test.mjs:393
- **A1593** NOT FOUND - src/benchmarks.ts:116 lists OSWorld as explicitly not integrated and says why; tests/evaluation-2.test.mjs:196 asserts findBenchmarkAdapter("osworld") throws
- **A1594** VERIFIED - src/study.ts Best-of-N keeps the best try and records what the others scored; tests/evaluation-2.test.mjs:376
- **A1598** NOT FOUND - src/benchmarks.ts:117 lists WindowsAgentArena as not integrated; no adapter exists, and a documented reason is not evidence of a capability
- **A1599** NOT FOUND - no AndroidWorld adapter; src/benchmarks.ts:119 states there is no emulator to drive and none can be installed from here
- **A1692** NOT FOUND - src/benchmarks.ts:118 lists WindowsAgentArena checkpoint scoring as not integrated; no checkpoint scorer exists
- **A1714** VERIFIED - src/benchmark-adapters.ts:219 web-tasks adapter converts WebVoyager JSONL, prepares the saved page and judges the answer; tests/evaluation-2.test.mjs:261 (deviation: saved pages only - a live benchmark site is refused by name, by design)
- **A1722** VERIFIED - src/study.ts StudySchema defines a reproducible study over presets, tasks and parameters; tests/evaluation-2.test.mjs:327
- **A1723** VERIFIED - src/study.ts StudyRunner runs cells with a concurrency setting, checkpoints each one and carries on from them in a fresh program; tests/evaluation-2.test.mjs:327,352
- **A1726** PARTIAL - has: the web-tasks adapter reading BrowserGym-shaped JSONL, src/benchmark-adapters.ts:219, tests/evaluation-2.test.mjs:261; missing: the live environments the row names - MiniWoB, WebArena and WorkArena are interactive environments and the adapter refuses anything not saved to disk
- **A1727** NOT FOUND - no OSWorld adapter; src/benchmarks.ts:116 lists it as deliberately not integrated, and desktop observations and actions are not adapted anywhere
- **A1728** VERIFIED - src/benchmark-adapters.ts:45 GAIA adapter reads metadata.jsonl, brings the attached file and marks by normalised exact match; tests/evaluation-2.test.mjs:199
- **A1729** VERIFIED - src/study.ts aggregates cells into a table, compareStudies computes the difference with a range, and public/studies.js shows it; tests/evaluation-2.test.mjs:407
- **A1767** VERIFIED - src/benchmarks.ts runs tasks, records the trajectory, scores, logs and persists the result; tests/evaluation-2.test.mjs:214,242,393

### #62 browser-automation (addendum)

- **A1568** PARTIAL - has: three shipped browser skills, src/browser-skills.ts:100 (search-and-summarise, fill-a-form-from-a-document, watch-a-page-for-a-change), tests/browser-2.test.mjs:401,410; missing: commerce, social and authenticated-task workflows - the watch skill states outright that a signed-in page cannot be watched this way
- **A2144** NOT FOUND - src/integrations/browser-marks.ts numbers what can be pressed or typed into; there is no inspect, change, lift or comment directive anywhere in src or public
- **A2183** VERIFIED - src/integrations/browser-attach.ts:75 connects to the owner's own Chrome over CDP on port 9222, gated by a switch and a grace period; tests/browser-2.test.mjs:344
- **A2286** VERIFIED - src/integrations/browser-marks.ts MarkRegistry reconciles marks across successive annotate passes so a reordering changes nothing; tests/browser-2.test.mjs:141,149,168

### #74 memory-features (addendum)

- **A0148** VERIFIED - src/sessions.ts and src/store.ts keep sessions with their runs and messages, listed, created and removed over the session routes; tests/sessions.test.mjs:112, tests/session-library.test.mjs:35,85,155
- **A0422** VERIFIED - src/memory-layers.ts working, task and long-term layers with a documented injection order and per-layer budget, over src/history.ts recent turns; tests/docs-memory-2.test.mjs:418,452
- **A1247** VERIFIED - src/memory-layers.ts task layer: notes a job makes for itself go when it ends unless the owner keeps one; tests/docs-memory-2.test.mjs:433
- **A1425** PARTIAL - has: src/memory-backend.ts:29 MemoryBackend contract with the shipped SqliteMemoryBackend answering every part of it, tests/docs-memory-2.test.mjs:562; missing: a manager that selects between backends - src/index.ts:241 wires the one implementation in directly, so nothing is switchable
- **A1475** PARTIAL - has: the SQLite session store credited to A0148; missing: the memory, file and MongoDB providers the row names, and any provider selection
- **A2035** VERIFIED - src/memory-layers.ts working context and long-term layers over src/history.ts verbatim turns and src/knowledge-bases.ts as the personal knowledge base; tests/docs-memory-2.test.mjs:418,452, tests/rag-vector.test.mjs:294
- **A2059** VERIFIED - src/checkpoints.ts registerCheckpoints over src/workspace-history.ts, with an undo summary naming what was added and removed; tests/workspace-history.test.mjs:37,64

### #81 file-and-code-tools (addendum)

- **A1183** PARTIAL - has: src/artifacts.ts RunArtifacts keeping a run's files under a size cap with path guards and a cheap gallery listing, tests/media.test.mjs:257; missing: versioning, and the in-memory, GCS and database services the row names - there is one file-backed store

### #84 git-integration (addendum)

- **A0542** VERIFIED - src/integrations/git-tools.ts:96 plans.try, plans.diff and plans.merge keep each plan attempt on its own branch in its own parallel copy, with the history git already carries; tests/git.test.mjs:178,184

### #85 app-integrations

- **A0008** VERIFIED - src/language-server.ts and src/language-server-tools.ts report mistakes, definitions, uses and hover text while files are read and edited, off until switched on; tests/code-ide.test.mjs:128,137

### #92 ide-and-editor

- **A0192** VERIFIED - src/debug-adapter.ts debug.start, debug.variables, debug.step and debug.stop over DAP, refusing when nothing is being debugged; tests/code-ide.test.mjs:224,233,241,246,249

## Totals

Across the whole of this pass - the 164 ids the first report left uncovered plus the 56 ticked
`(0.15.0)` while it ran - **220 ids** were checked.

| Verdict | Count | Share of the 220 |
| --- | --- | --- |
| VERIFIED | 172 | 78% |
| PARTIAL | 29 | 13% |
| NOT FOUND | 19 | 9% |

Of those, the 164-id batch ran 133 / 19 / 12 and the 56-id `(0.15.0)` batch ran 39 / 10 / 7. The
newest work holds up slightly less well than the rest, which is what one would expect of ticks made
days rather than months ago.

**48 ids were un-ticked** in their issue bodies, with a short reason on the line. By theme: #61 ten,
#63 six, #59 four, #75 four, #80 four, #65 three, #57 two, #60 two, #62 two, #72 two, #74 two, #81
two, #56 one, #58 one, #76 one, #90 one, #91 one.

Nineteen ids had no code at all for what the row promised: **A1012** (AI SDK gateway), **A1668**
(knowledge-base summarisation), **A1766** (HTML-state evaluator), **A2103** (CLI-delegating
providers), **A2131**, **A2152**, **A2160** (any sandbox backend), the five telemetry rows
**A0155**, **A0225**, **A0270**, **A0385**, **A1418**, the five benchmark environments Branch
documents as deliberately not integrated (**A1593**, **A1598**, **A1599**, **A1692**, **A1727**),
**A2066** (Reddit, Twitch, X, Nostr) and **A2144** (DOM annotation directives). The other twenty-nine
have real work behind them that stops short of the row.

A pattern worth naming: **A1593, A1598, A1599, A1692, A1727 and the five telemetry rows are ten
ticks that record a written non-goal as if it were built.** `src/benchmarks.ts:115` lists five
benchmarks as not integrated and says in a sentence each why, and `tests/tracing-policy.test.mjs:473` asserts in writing
that Branch collects nothing. Both are defensible decisions; neither is what a tick claims. If the
owner wants these closed as "will not build" rather than "to build", that is a change to the ledger's
vocabulary, not to this verdict.

### Combined with the first pass

Across both passes, all 327 ids that have ever carried a tick in issues #55-#92 have now been
checked: **255 VERIFIED, 48 PARTIAL, 24 NOT FOUND**, and **72 ticks re-opened**. Roughly one tick in
4.5 did not survive reading the code.

### Duplicate credit

The first pass found that its 107 sampled ids reduced to about 75 implementations. This batch is
worse, because whole themes were built as single modules. Inside these 164:

- **A0163 + A0785 + A0830 + A0867 + A1260 + A1886 + A1888 + A1919 + A2124 + A1373 + A1363 + A0838** - one `src/knowledge-bases.ts` with `src/knowledge-tools.ts` on top. Twelve ids, one module.
- **A1279 + A1280 + A1392 + A1868** - one `askKnowledge`.
- **A0839 + A0946 + A0993 + A1869 + A1990 + A1545** - one document reader and chunker.
- **A0278 + A0417 + A0747 + A0818 + A0784 + A0947 + A1225 + A1670 + A1921 + A2363** - one `src/vector-store.ts` behind one `src/retrieval.ts`; joins A0996, A1119, A1103 and A1975 from the first pass.
- **A0202 + A0269 + A0346 + A0420 + A0459 + A0503 + A0565 + A0929 + A1419 + A0706 + A0883** - one usage and pricing store; joins A0057, A0773, A1366 and A1735. Fifteen ids, one module.
- **A0295 + A0458 + A1390 + A0447** - one `src/trajectory.ts` with one viewer; joins A0285 and A1481.
- **A0056 + A0597 + A0972 + A1127 + A1303 + A0882 + A0823** - one tracing layer with one exporter in three shapes; joins A0031, A1263, A0613, A0955 and A1356.
- **A0637 + A0707 + A1148 + A1547** - one events-and-spans store.
- **A0328 + A0970 + A1001 + A1894 + A1995 + A2067 + A2068 + A2107 + A2266** - one voice module; joins A0654, A1893, A2162 and A2173.
- **A2106 + A2184 + A2321** - one `media.describe`. **A1996 + A2294 + A2368** - one media module; joins A2083.
- **A0230 + A1450 + A2311** - one desktop and computer layer; joins A2043, A2278 and A1465.
- **A0608 + A1827 + A2112** - one skill-revision and governance path.
- **A0167 + A0498 + A1139 + A1788 + A2365** - one `src/local-models.ts`.
- **A0012 + A0183 + A1211** - one `src/cli-run.ts` and one `src/terminal-tui.ts`; joins A0136, A0249, A0007, A0205 and A0620.
- **A0817 + A0995** - one `src/retrieval.ts`. **A0388 + A0393** - one GitHub tool set. **A0074 + A2023** - one compaction split.

These 164 ids reduce to roughly **60 distinct implementations**, about 37% - a sharper reduction than
the first pass's 70%, because the sample there was spread across themes while this batch is what
remains after a sample was taken, concentrated in the themes that were built wholesale.

The 56 addendum ids collapse the same way, and the benchmark theme hardest of all:

- **A0297 + A0460 + A0571 + A0724** - one SWE-bench adapter. **A0347 + A1767** - one `src/benchmarks.ts` runner. **A0499 + A1728** - the code-tasks and GAIA adapters beside it.
- **A1252 + A1253 + A1594 + A1722 + A1723 + A1729 + A1550** - one `src/study.ts`. Seven ids, one module.
- **A1714 + A1726** - one web-tasks adapter. **A2144 + A2286** - one `src/integrations/browser-marks.ts`. **A2183** joins the browser-attach path credited to A2241.
- **A0422 + A1247 + A2035** - one `src/memory-layers.ts`. **A0148 + A1475** - one session store.
- **A0115 + A2014 + A2034 + A2091 + A2117 + A2156 + A2238 + A2255 + A2295 + A2349** - one channel catalog with one router. Ten ids, one subsystem.

So the whole of issue #59 is one implementation, and more than half of #61 is two.

Taken together the two passes suggest the ledger's "786 distinct pieces of work" overcounts by
something closer to half than to the first pass's estimate.
