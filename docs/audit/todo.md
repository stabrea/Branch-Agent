# Audit to-do: 786 distinct pieces of work (1133 rows) in 38 themes


## Family rows — 2026-09-16

The 210 FAMILY rows were judged against the code on this tree (releases 0.7–0.14).

- done: 143
- partial: 27
- not done: 17
- not applicable: 23

Honest work remaining: 349 — 305 single ids still open, plus 27 partial and 17 not-done family rows.

## agent-orchestration — 77 pieces (122 rows) {'M': 64, 'S': 30, 'L': 28}

- [x] FAMILY agent-specialist (31 rows): Planner agent, ReAct agent, Subtask-aware agent execution, Subagent spawning, Agent thread creation, Subagent prompts, Reviewer agent, Role-based software-development pipeline, Message routing between roles, Data Interpreter agent, Multi-role agent loop, Agent spawning … — done (0.14.0): src/specialist-styles.ts, src/orchestration.ts; tests/orchestration-2.test.mjs
- [x] FAMILY file-editing (4 rows): Patch application, Project code editing, Multi-file change generation and review, Multiple edit formats — done (0.14.0): src/patch.ts, src/code-change.ts; tests/orchestration-2.test.mjs
- [x] FAMILY tooling (1 rows): Tool-call inspection — done (0.14.0): src/inspect.ts; tests/web-ui.test.mjs U2 Look inside
- [x] FAMILY agent-orchestration (1 rows): Agent-computer interface — done (0.14.0): coder style plus src/code-map.ts toolboxes; tests/code-ide.test.mjs
- [ ] FAMILY workflow-hooks (1 rows): Patch application hook — partial: hooks fire on file.changed and tool.completed, not on applying a patch itself
- [x] FAMILY sandbox-isolation (1 rows): Local subprocess code execution — done (0.14.0): src/code-run.ts subprocess with limits; tests/orchestration-2.test.mjs
- [x] FAMILY api-websocket (2 rows): HTTP and WebSocket API, HTTP and WebSocket gateway — done (0.14.0): src/server.ts and src/ws.ts; tests/guardrails.test.mjs
- [x] FAMILY process-management (2 rows): Background process management, Long-running process management — done (0.14.0): src/processes.ts start, list, read, stop; tests/orchestration-2.test.mjs
- [x] FAMILY flow-crud (1 rows): Flow CRUD API — done (0.14.0): src/flows.ts over HTTP; tests/orchestration-2.test.mjs
- [x] FAMILY flow-execution (1 rows): Flow run API — done (0.14.0): src/flows.ts runs and reports each step; tests/orchestration-2.test.mjs
- [x] FAMILY callback-system (1 rows): Callback and event hooks — done (0.14.0): src/hooks.ts and src/streams.ts events; tests/guardrails.test.mjs
- [ ] FAMILY framework-adapters (1 rows): Python API SDK — not done
- [ ] FAMILY adapter-system (3 rows): Chat adapter, JSON adapter, XML adapter — not done
- [x] FAMILY permissions (1 rows): Human approval for tool calls — done (0.14.0): src/approvals.ts asks per tool call; tests/approvals.test.mjs
- [x] FAMILY framework-tools (1 rows): Function and component tools — not applicable: Python function and component wrapping; Branch's tools are TypeScript
- [x] FAMILY tool-discovery (1 rows): Toolsets and searchable toolsets — done (0.14.0): src/tool-index.ts, src/catalog.ts searchable groups; tests/tool-loading.test.mjs
- [x] FAMILY code-execution (3 rows): Code execution, CodeAgent, Code execution tool — done (0.14.0): src/code-run.ts runs JavaScript and Python; tests/orchestration-2.test.mjs
- [x] FAMILY tool-calling (1 rows): ToolCallingAgent — done (0.14.0): src/runtime.ts tool loop; tests/runtime.test.mjs
- [ ] FAMILY sandbox-execution (3 rows): Remote sandbox execution, Sandboxed code execution, Sandbox shell execution — partial: scripts run under job limits on this computer; no real sandbox and no remote runner
- [x] FAMILY tool-definition (1 rows): User-defined tools — done (0.14.0): src/openapi-tools.ts and src/skill-http-tools.ts; tests/code-ide.test.mjs
- [x] FAMILY tool-deferral (1 rows): Deferred tool calls — done (0.14.0): src/deferred.ts follow-up queue; tests/orchestration-2.test.mjs
- [x] FAMILY approval-workflow (1 rows): Terminal execution approvals — done (0.14.0): src/approvals.ts gates each command; tests/approvals.test.mjs
- [x] FAMILY vision (1 rows): Optional vision-based page understanding — done (0.14.0): element pictures and numbered marks; tests/browser-2.test.mjs
- [x] FAMILY desktop-automation (1 rows): Remote computer configuration — not applicable: configuring a remote computer; Branch drives this one
- [ ] FAMILY research-pipeline (5 rows): STORM long-form article pipeline, Multi-perspective persona generation, Outline generation, Citation-grounded article generation, Article polishing — partial: deep research cites its sources; no persona, outline or polishing stages
- [ ] FAMILY gateway (1 rows): Gateway runtime — partial: one local router fronts every channel; no multi-node gateway
- [x] FAMILY development-tools (1 rows): Language Server Protocol client — done (0.14.0): src/language-server.ts; tests/code-ide.test.mjs
- [x] FAMILY graph-execution (1 rows): Graph execution runtime — done (0.14.0): src/flows.ts nodes and edges; tests/orchestration-2.test.mjs
- [ ] FAMILY multimodal-input (1 rows): Rich message and file handling — partial: channels transcribe and answer voice notes; pictures and files over a channel are still text only
- [ ] FAMILY provider-actions (1 rows): Provider effect actions — not done
- A0186 [partial/M] Plan mode (in 2 projects): Branch supports task planning via prompts but lacks a formal plan-mode toggle that gates tool availability.
- A0959 [partial/M] Handoffs (in 2 projects): Branch delegates between specialists; no explicit handoff objects or filters.
- A0110 [partial/M] Plan and Act modes (in 1 projects): Branch has investigation tools (shell, web read, browser) available in all runs; no dual-mode toggle gating tool access.
- A0146 [partial/M] Fleet coordination (in 1 projects): Branch teams coordinate multiple agents; fleet commands for multi-agent workflows are not implemented.
- A0195 [partial/M] Advisor model (in 1 projects): Branch supports advisors through explicit delegation; not a background reviewer auto-injecting notes into every main turn.
- A0317 [partial/L] Swarm orchestration (in 1 projects): Branch delegates to multiple specialists sequentially; true swarm orchestration with simultaneous handoffs is not built.
- A0318 [partial/M] DAG task scheduling (in 1 projects): Branch supports dependent task chains via fanout; no explicit DAG scheduling engine exposed.
- A0319 [partial/L] Remote handoff (in 1 projects): Branch does not support handing off an active session to remote clients or devices.
- A0372 [partial/M] Task decomposition (in 1 projects): Branch can delegate planning tasks but lacks a dedicated task-decomposition component.
- A0405 [partial/S] Sequential action planning (in 1 projects): Branch executes delegated actions; no explicit sequential action-planning node.
- A0408 [missing/M] Debate simulation (in 1 projects): Branch does not coordinate debate between multiple specialized agents.
- A0421 [missing/L] AFlow workflow optimization (in 1 projects): Branch does not implement automatic agentic workflow generation.
- A0428 [partial/M] Boomerang mode orchestration (in 1 projects): Branch delegates subtasks and returns results; no formal boomerang-mode bidirectional orchestration.
- A0538 [partial/M] Configurable autonomy and command debugging (in 1 projects): Branch has tool timeout and graceful command/browser stalls; no granular autonomy mode toggle.
- A0688 [partial/M] Project routing (in 1 projects): Branch has projects that scope files and secrets; no request-level project routing.
- A0778 [partial/M] Graph execution engine (in 1 projects): Branch executes delegated task chains; no general-purpose component graph engine exposed.
- A0808 [partial/M] Runnable composition pipelines (in 1 projects): Branch chains delegated tasks; no explicit runnable-composition pipeline exposed.
- A0809 [partial/S] Parallel runnable execution (in 1 projects): Branch fanout runs independent tasks concurrently; no parallel runnable abstraction exposed.
- A0827 [partial/M] Event-driven flows (in 1 projects): Branch schedules tasks and records events; no event-driven listener or state-routing layer.
- A0889 [partial/L] StateGraph workflow construction (in 1 projects): Branch does not expose StateGraph workflow DSL or typed-graph construction.
- A0890 [partial/M] Compiled graph execution (in 1 projects): Branch executes delegated task graphs; no first-class compiled graph abstraction.
- A0891 [partial/M] Conditional branching (in 1 projects): Branch can route based on delegation type; no explicit conditional branching operator.
- A0892 [partial/L] Pregel/BSP execution engine (in 1 projects): Branch executes tool sequences; not a formal Pregel BSP execution engine.
- A0904 [partial/M] Command-based state update and routing (in 1 projects): Branch tracks run state and events; no explicit command object for graph updates and routing.
- A0907 [partial/L] Nested graphs and subgraphs (in 1 projects): Branch does not support embedding one task as a nested subtask within another.
- A0935 [partial/M] Executor-verifier goal pipeline (in 1 projects): Branch does not implement executor-verifier goal loops.
- A0978 [partial/M] Typed workflow graphs (in 1 projects): Branch procedures are workflows; not typed-graph DSL.
- A0981 [partial/M] Dynamic workflow graphs (in 1 projects): Branch delegation chains tasks; no explicit dynamic graph-definition building.
- A1092 [partial/S] Sequential orchestration (in 1 projects): Branch delegates sequentially; no explicit sequential-orchestration component.
- A1093 [partial/M] Handoff orchestration (in 1 projects): Branch delegates between specialists; no explicit handoff-relationship routing.
- A1112 [partial/L] Directed component pipelines (in 1 projects): Branch delegates tasks; not a serializable directed-graph component system.
- A1116 [partial/S] Pipeline-as-tool composition (in 1 projects): Branch delegates can use other delegates; no explicit pipeline-as-tool pattern.
- A1168 [partial/M] Graph workflow engine (in 1 projects): Branch executes delegated chains; no formal graph-node/edge workflow abstraction.
- A1215 [partial/L] Pydantic Graph state machines (in 1 projects): Branch does not expose typed graph/state-machine DSL.
- A1218 [partial/M] Workforce orchestration (in 1 projects): Branch delegates tasks; no explicit workforce-style async task-pool.
- A1238 [partial/L] GraphFlow workflow graphs (in 1 projects): Branch does not expose GraphFlow workflow graphs.
- A1257 [partial/L] Workflow graphs (in 1 projects): Branch handles delegation; no explicit executor/edge/routing abstraction.
- A1268 [partial/M] Graph-based flows (in 1 projects): Branch delegates tasks; no explicit node/edge/transition-labeling graph abstraction.
- A1270 [partial/M] Node lifecycle (in 1 projects): Branch does not expose explicit prep/exec/post phase node lifecycle.
- A1278 [partial/S] Supervisor pattern (in 1 projects): Branch does not include documented supervisor/worker coordination pattern.
- A1292 [partial/M] Graph orchestration (in 1 projects): Branch teams coordinate specialists; no graph-based queue scheduling.
- A1293 [partial/S] Swarm patterns (in 1 projects): Branch does not document swarm patterns.
- A1313 [partial/M] Streaming generation (in 1 projects): Branch streams model responses; no explicit streaming of structured outputs.
- A1327 [partial/S] Tool-discovery progressive disclosure (in 1 projects): Branch selects tools from knowledge registry; not progressive disclosure pattern.
- A1337 [partial/M] Typed flow authoring DSL (in 1 projects): Branch procedures have parameters and branching; not a formal DSL.
- A1338 [partial/M] DAG compilation and execution (in 1 projects): Branch executes delegated task chains; no explicit DAG validation before execution.
- A1340 [partial/S] Flow-as-tool composition (in 1 projects): Branch procedures can delegate to other procedures; not explicitly registered as tools.

## models.cloud-providers — 11 pieces (92 rows) {'S': 13, 'M': 71, '?': 3, 'L': 5}

- [x] FAMILY model-provider (6 rows): Multi-provider model configuration, Provider diagnostics, Gemini provider, Codex OAuth provider, Embedding provider: voyageai, LiteLLM model adapters — done (0.14.0): src/provider-catalog.ts, src/provider-health.ts; tests/providers-2.test.mjs
- [x] FAMILY provider-adapter (77 rows): Google Gemini provider, Azure OpenAI models, Local Ollama models, OpenAI and Azure OpenAI, Hugging Face inference, Gemini models, Google Gemini, Google Gemini models, Hosted model providers, Provider catalog updates, Groq models, LiteLLM model backend … — done (0.14.0): data/providers.json 38 services incl. Bedrock, Azure, Gemini; tests/providers-2.test.mjs
- A0051 [missing/S] Sign in with Google (in 1 projects): Only ChatGPT and API-key auth; no Google OAuth.
- A0167 [partial/M] Local model serving (in 1 projects): OpenAI-compatible local models work; no bundled serving.
- A0498 [partial/M] Local/open models through compatible APIs (in 1 projects): OpenAI-compatible local models work; no bundled serving.
- A0576 [missing/M] Model routing profiles (in 1 projects): model routing profiles not implemented.
- A0735 [missing/M] Runtime model switching (in 1 projects): runtime model switching not implemented.
- A1012 [missing/M] AI SDK model gateway (in 1 projects): ai sdk model gateway not implemented.
- A1139 [partial/M] Transformers local models (in 1 projects): OpenAI-compatible local models work; no bundled serving.
- A2258 [missing/L] Multiple agent runtimes (in 1 projects): Multiple agent runtimes not supported.
- A2367 [missing/S] Google PaLM models (in 1 projects): Google PaLM model adapter not implemented.

## documents-and-rag — 41 pieces (71 rows) {'L': 56, 'M': 13, 'S': 2}

- [x] FAMILY file-operations (1 rows): File ingestion — done (0.14.0): documents.add, read, re-read, remove; tests/documents.test.mjs
- [x] FAMILY storage-adapter (23 rows): Storage adapter: chroma, Storage adapter: clickhouse, Storage adapter: cloudflare, Storage adapter: cloudflare-d1, Storage adapter: convex, Storage adapter: couchbase, Storage adapter: dsql, Storage adapter: duckdb, Storage adapter: elasticsearch, Storage adapter: lance, Storage adapter: libsql, Storage adapter: mongodb … — not applicable: external hosted databases; Branch keeps its vectors in its own store
- [ ] FAMILY doc-processing (8 rows): Document converters and preprocessors, PDF reader tool, Document and dataframe ingestion, Document parsers including PDF, Local-document research, Document processing, Office generation, Document ingestion and parsing — partial: Word, spreadsheet, CSV and HTML are read; PDFs still need a helper and nothing writes Office files
- [x] FAMILY file-tools (2 rows): File upload and trusted-folder mount, File upload and processing — done (0.14.0): src/documents.ts upload and workspace mount; tests/documents.test.mjs
- [x] FAMILY file-attachments (1 rows): File upload and attachment — done (0.14.0): composer picture chip and CLI --attach; tests/media.test.mjs
- A0867 [missing/L] RAG knowledge bases (in 2 projects): RAG not implemented.
- A1260 [missing/L] RAG (in 2 projects): Vector and hosted retrieval for documents; Branch does not support embeddings.
- A1941 [missing/L] Knowledge-base RAG (in 2 projects): Knowledge-base RAG with ranking requires vector retrieval and BM25 sparse search; missing.
- A0163 [missing/L] Documentation retrieval (in 1 projects): RAG not implemented.
- A0785 [missing/L] Knowledge bases (in 1 projects): RAG not implemented.
- A0830 [missing/L] Knowledge retrieval (in 1 projects): RAG not implemented.
- A0839 [partial/L] Document ingestion pipelines (in 1 projects): RAG not implemented.
- A0946 [partial/L] Document parsing and chunking (in 1 projects): RAG not implemented.
- A0993 [partial/L] Document ingestion and chunking (in 1 projects): RAG not implemented.
- A0994 [missing/L] Graph RAG (in 1 projects): RAG not implemented.
- A1013 [missing/L] Pluggable storage domains (in 1 projects): Backend not implemented.
- A1118 [missing/L] BM25 retrieval (in 1 projects): RAG not implemented.
- A1144 [missing/L] Retrieval-augmented generation examples (in 1 projects): RAG not implemented.
- A1279 [missing/L] RAG pattern (in 1 projects): Document chunking and embedding retrieval; no embedding pipeline in Branch.
- A1280 [missing/L] Agentic RAG (in 1 projects): Agent-directed document selection via embeddings; no embedding store.
- A1372 [missing/L] RAG document store (in 1 projects): Document indexing for retrieval requires vector embeddings.
- A1392 [missing/L] RAG agent (in 1 projects): RAG agent requires document indexing and embedding retrieval.
- A1426 [missing/L] RAGFlow knowledge search (in 1 projects): RAGFlow knowledge search requires external service integration.
- A1545 [missing/M] Document-assisted analysis (in 1 projects): Document toolkit for analysis requires document parsing and storage.
- A1667 [missing/L] Structured collaborative knowledge base (in 1 projects): Structured knowledge base insertion from conversations not implemented.
- A1668 [missing/L] Knowledge-base summarization (in 1 projects): Knowledge-base summarization requires vector store and retrieval.
- A1867 [missing/L] Dataset and knowledge-base management (in 1 projects): Dataset and knowledge-base management requires document indexing.
- A1868 [missing/L] Retrieval-augmented generation (in 1 projects): Retrieval-augmented generation requires vector embeddings.
- A1869 [partial/L] Document ingestion and parsing (in 1 projects): Document ingestion requires parsing PDF/Word/Markdown.
- A1886 [missing/L] RAG document retrieval (in 1 projects): RAG requires vector embeddings and similarity search; no vector store backend exists.
- A1888 [missing/L] Knowledge-base collections (in 1 projects): Knowledge collections require document parsing and search indexing; no indexing system.
- A1919 [missing/L] Workspace RAG chat (in 1 projects): Workspace RAG chat requires document indexing and vector retrieval; not implemented.
- A1990 [missing/L] File RAG (in 1 projects): File RAG requires document parsing and embedding indexing; not implemented.
- A2036 [missing/L] Self-evolving knowledge base (in 1 projects): Self-evolving knowledge base requires continuous learning loop and Markdown editing; missing.
- A2124 [missing/L] Personal knowledge search (in 1 projects): Personal knowledge search requires document indexing; no indexing system.
- A2145 [missing/L] Live document cowork (in 1 projects): No office document creation/editing capability.
- A2149 [missing/L] Project knowledge store (in 1 projects): Project knowledge store requires document indexing; no indexing system.
- A2263 [missing/L] Office document operations (in 1 projects): No office document bridge integration.
- A2264 [missing/M] PDF processing (in 1 projects): No PDF.js or extraction capability.
- A2343 [missing/L] Knowledge base and RAG (in 1 projects): Embedded RAG requires document indexing and retrieval; no indexing system.
- A2362 [missing/M] Document resource management (in 1 projects): Document resource management requires parsing and summarization tools; not implemented.

## dashboards-and-observability — 58 pieces (58 rows) {'S': 16, 'L': 10, 'M': 32}

- [x] FAMILY event-emission (1 rows): Session event emission — done (0.14.0): src/store.ts events over SSE and WebSocket; tests/polish-observability.test.mjs D3
- [x] FAMILY agent-specialist (1 rows): Live Agent Hub — done (0.14.0): Activity live feed and the inspector; tests/polish-observability.test.mjs D3
- [x] FAMILY prometheus-metrics (1 rows): Prometheus metrics — done (0.14.0): src/metrics.ts counters page; tests/tracing-policy.test.mjs T3
- [x] FAMILY application-logging (1 rows): Application logs and tracing — done (0.14.0): src/tracing.ts spans plus run events; tests/tracing-policy.test.mjs T1
- [x] FAMILY runtime-logging (1 rows): Runtime logging — done (0.14.0): src/activity.ts and the store's events; tests/polish-observability.test.mjs
- [x] FAMILY audit-logging (1 rows): Audit log — done (0.14.0): src/audit.ts unedited record; tests/sdk-misc.test.mjs
- [ ] FAMILY diagnostics-logging (1 rows): Event-loop diagnostics — not done
- [x] FAMILY feedback-diagnostics (1 rows): Feedback diagnostics and logs — done (0.14.0): src/diagnostics.ts redacted folder; tests/cost-trace.test.mjs
- [x] FAMILY trace-collection (1 rows): Agent traces and metrics — done (0.14.0): src/tracing.ts and src/tracing-export.ts; tests/tracing-policy.test.mjs
- [x] FAMILY cost-display (1 rows): Usage and cost ledger — done (0.14.0): src/usage.ts and src/pricing.ts month card; tests/cost-trace.test.mjs
- [x] FAMILY analytics-dashboard (1 rows): Performance and token telemetry — done (0.14.0): src/metrics.ts and the usage screen; tests/polish-observability.test.mjs D1 and D4
- A0202 [partial/M] Usage and cost accounting (in 4 projects): Token usage tracked in database; cost accounting not implemented.
- A0269 [partial/S] Usage and cost tracking (in 2 projects): Token usage recorded in database; display in UI missing.
- A0057 [partial/S] Session token and latency statistics (in 1 projects): Per-session token counts tracked in usage table; aggregate display in evaluation suite with latency but cost not calculated.
- A0099 [partial/S] Live event streaming (in 1 projects): WebSocket run channel exists for streaming runs; generic event streaming not exposed.
- A0295 [partial/M] Trajectory recording (in 1 projects): Tool trajectories persisted in tool-trace.ts; full trajectory JSON export missing.
- A0296 [missing/M] Run comparison and statistics (in 1 projects): No run comparison or statistics utilities.
- A0346 [partial/S] Usage and cost reporting (in 1 projects): Token usage calculated from provider response; cost estimation not implemented.
- A0367 [missing/L] Usage analytics and reports (in 1 projects): No usage analytics or enterprise event recording.
- A0400 [partial/M] Usage analytics (in 1 projects): Model usage tracked; analytics display and cost calculation missing.
- A0420 [partial/S] Cost and token accounting (in 1 projects): Token consumption tracked; cost calculation not implemented.
- A0458 [partial/M] Trajectory persistence (in 1 projects): Tool trajectories recorded; full message/action trajectory JSON export missing.
- A0459 [partial/S] Token/cost tracking (in 1 projects): Model usage tracked in database; cumulative cost display missing.
- A0500 [partial/M] Tracing and debugging (in 1 projects): Tool execution tracing exists; LLM call tracing and debug output missing.
- A0503 [partial/S] Token usage logging (in 1 projects): Token usage tracked from provider response; explicit logging interface missing.
- A0565 [partial/S] Token and cost accounting (in 1 projects): Token usage tracked; cost display not implemented.
- A0584 [partial/L] Workflow graph execution (in 1 projects): Branch schedules sequential/dependent task chains but lacks a visual graph builder.
- A0592 [missing/M] Metering (in 1 projects): No metering component or usage recording.
- A0593 [missing/M] Workflow run timeline (in 1 projects): No timeline UI for workflow run visibility.
- A0605 [partial/M] Approval-gated plans (in 1 projects): Branch can check completion; no dedicated proposal/approval UI for persisted plans.
- A0635 [partial/M] Persistent todo tracking (in 1 projects): Branch supports tasks and memory but not a dedicated structured task-tracking UI.
- A0637 [partial/M] Agent event stream (in 1 projects): Tool execution events recorded; lifecycle/model/execution events not formally emitted.
- A0638 [partial/S] Token usage display (in 1 projects): Token usage calculated from provider; display in UI not implemented.
- A0647 [missing/L] Background watches and alert actions (in 1 projects): No background monitoring for services/metrics/ports/certificates.
- A0656 [missing/L] Visual screenshot watches (in 1 projects): No periodic screenshot diffing or OCR-based change detection.
- A0706 [missing/M] Runtime statistics (in 1 projects): No runtime statistics or metrics module.
- A0707 [partial/S] Structured task logs (in 1 projects): Tool traces stored; structured task log export not implemented.
- A0752 [missing/M] Structured logs and PTC telemetry (in 1 projects): No structured logging or job telemetry artifact persistence.
- A0773 [partial/S] Token and cost usage accounting (in 1 projects): Token usage tracked; cost-related fields not included in response types.
- A0777 [missing/L] Visual graph builder (in 1 projects): Branch does not include a visual graph builder for workflow design.
- A0798 [missing/L] Run and vertex monitoring (in 1 projects): No monitor API for run/vertex messages or transactions.
- A0883 [missing/M] Runtime metrics and usage analytics (in 1 projects): No metrics/usage analytics routes for run/session/token data.
- A0929 [partial/S] Usage tracking (in 1 projects): Usage tracking at database level; user-facing aggregation missing.
- A1148 [missing/M] Step monitoring (in 1 projects): No monitoring component for step token usage and timing.
- A1209 [partial/S] Token and request usage accounting (in 1 projects): Token usage tracked; request limits not implemented.
- A1366 [partial/S] Token usage accounting (in 1 projects): Token usage tracked at database level; cumulative display not implemented.
- A1390 [partial/M] Trajectory middleware (in 1 projects): Tool trajectories recorded; trajectory middleware abstraction missing.
- A1419 [missing/M] Model usage/cost calculation (in 1 projects): No cost calculation or pricing-aware token aggregation.
- A1441 [missing/M] Cache-aware cost accounting (in 1 projects): No cache-aware cost accounting or separate token path tracking.
- A1454 [missing/M] Chart visualization (in 1 projects): No data-to-chart transformation or interactive chart emission.
- A1481 [missing/L] Trace visualizer (in 1 projects): No trace visualizer with timeline/replay panels.
- A1490 [missing/L] Multiple report formats (in 1 projects): No report generator for multiple formats.
- A1522 [missing/L] Browser recording artifacts (in 1 projects): No browser recording or artifact capture.
- A1547 [partial/M] Agent logging (in 1 projects): Logging available via standard Python/Node; no structured agent logging.
- A1637 [partial/M] Live WebSocket run channel (in 1 projects): WebSocket server exists for run channels; authenticated run lifecycle messages missing.
- A1677 [missing/M] Pipeline logging and usage accounting (in 1 projects): No pipeline logging or usage accounting wrapper.
- A1730 [missing/M] Episode HTML export (in 1 projects): No trajectory-to-HTML rendering or episode export.
- A1735 [partial/M] LLM token/cost tracking (in 1 projects): Token tracking exists; latency and cost calculation not exposed.

## messaging-channels — 14 pieces (55 rows) {'M': 46, 'S': 2, 'L': 7}

- [ ] FAMILY webhooks (1 rows): Slack-triggered automations — partial: signed webhook triggers start tasks, but nothing subscribes to Slack's own events
- [ ] FAMILY channel-adapter (36 rows): Discord adapter, Telegram integration, WhatsApp channel, Discord context, Slack, Slack reader/tools, GitHub signal triggers, Slack bot, Discord bot, Feishu/Lark and WeCom, Discord bot example, WhatsApp MCP example … — partial: Telegram, Discord, Slack, WhatsApp and email ship; Signal, Matrix, Teams, iMessage and the Chinese apps do not
- [ ] FAMILY messaging-channel (7 rows): Slack channel, Discord channel, Messaging channels, Feishu channel, WeChat iLink channel, WeChat gateway channel, DingTalk channel — partial: Slack and Discord ship; Feishu, WeChat and DingTalk do not
- A0115 [partial/M] Messaging connectors (in 1 projects): Telegram channel exists; messaging connectors not supported.
- A2014 [missing/L] Multi-platform messaging adapters (in 1 projects): Multi-platform messaging adapters not implemented.
- A2034 [missing/L] Messaging channel adapters (in 1 projects): Messaging channel adapters not implemented.
- A2066 [missing/M] Social channels (in 1 projects): Social channel adapters not implemented.
- A2091 [missing/M] Messaging channel extensions (in 1 projects): Messaging channel extensions not implemented.
- A2117 [missing/L] Enterprise/Asian messaging channels (in 1 projects): Enterprise messaging channels not implemented.
- A2156 [missing/L] Multi-platform messaging bots (in 1 projects): Multi-platform messaging bots not implemented.
- A2238 [missing/L] Multi-channel messaging (in 1 projects): Multi-channel messaging not fully implemented.
- A2255 [missing/M] Team chat channel support (in 1 projects): Team chat channels not implemented.
- A2295 [partial/L] Instant-messaging channels (in 1 projects): Telegram channel supports instant messaging only.
- A2349 [missing/L] Service connectors (in 1 projects): Service connectors not implemented.

## other — 55 pieces (55 rows) {'M': 40, 'L': 11, 'S': 3, '?': 1}

- [x] FAMILY language-specific (1 rows): Native-code plugins — not applicable: native-code plugins; Branch's plugins are JavaScript
- A0758 [missing/M] HTTP API (in 3 projects): http api not implemented.
- A0817 [missing/M] Retriever abstraction (in 2 projects): No implementation found.
- A0995 [missing/L] Reranking (in 2 projects): RAG not implemented.
- A0098 [missing/M] Embedded code editor (in 1 projects): embedded code editor not implemented.
- A0174 [missing/M] Issue-tracker context (in 1 projects): issue-tracker context not implemented.
- A0279 [partial/M] Human-in-the-loop executor (in 1 projects): user.ask pauses; no dedicated human-in-loop executor.
- A0300 [partial/M] Open pull-request hook (in 1 projects): open pull-request hook has some implementation; specific features may be missing.
- A0308 [missing/M] TypeScript SDK (in 1 projects): typescript sdk not implemented.
- A0323 [missing/M] OAuth login flows (in 1 projects): oauth login flows not implemented.
- A0326 [missing/M] Onboarding sandbox (in 1 projects): First-run setup exists; no constrained onboarding environment.
- A0344 [missing/M] IDE watch mode (in 1 projects): ide watch mode not implemented.
- A0354 [partial/L] Answer Engine (in 1 projects): RAG not implemented.
- A0355 [partial/L] Persistent shareable Pages (in 1 projects): RAG not implemented.
- A0370 [missing/M] Interactive specification elicitation (in 1 projects): interactive specification elicitation not implemented.
- A0390 [partial/M] Durable threads (in 1 projects): No implementation found.
- A0395 [missing/M] Linear (in 1 projects): linear not implemented.
- A0434 [partial/M] Per-tool approval controls (in 1 projects): Permission gating; no per-tool approval categories.
- A0437 [missing/L] Localized interface (in 1 projects): Interface is English only; no i18n or locale resource loading.
- A0447 [missing/M] Trajectory inspector (in 1 projects): trajectory inspector not implemented.
- A0482 [missing/M] Markdown and code-block rendering (in 1 projects): markdown and code-block rendering not implemented.
- A0483 [missing/M] Internationalization (in 1 projects): internationalization not implemented.
- A0575 [missing/M] Pluggable LLM drivers (in 1 projects): pluggable llm drivers not implemented.
- A0591 [partial/S] Runtime audit records (in 1 projects): Activity log exists; not dedicated audit component.
- A0602 [missing/M] Ultracode plugin lifecycle (in 1 projects): ultracode plugin lifecycle not implemented.
- A0615 [partial/M] Lockdown and tool policy (in 1 projects): Tool permissions enforced; no lockdown mode.
- A0624 [partial/M] Approval-gated side effects (in 1 projects): user.ask pauses; no middleware for approval gates.
- A0663 [missing/M] C FFI (in 1 projects): c ffi not implemented.
- A0794 [missing/M] Project management (in 1 projects): No project-based flow organization; projects hold instructions/secrets only.
- A0834 [partial/M] Flow checkpointing (in 1 projects): No implementation found.
- A0840 [partial/L] Metadata filtering (in 1 projects): RAG not implemented.
- A0847 [partial/M] Chat engines (in 1 projects): No implementation found.
- A0928 [missing/M] Request caching (in 1 projects): No request-level caching; model calls go directly to provider.
- A1011 [missing/M] Local Studio/playground (in 1 projects): local studio/playground not implemented.
- A1141 [missing/M] LiteLLM (in 1 projects): litellm not implemented.
- A1193 [missing/L] Bidirectional live streaming (in 1 projects): No bidirectional audio/text streaming; unidirectional text streaming only.
- A1274 [missing/L] Nested flows (in 1 projects): Branch does not support nesting one task directly as a node in another.
- A1351 [partial/M] OpenAI batch inference (in 1 projects): openai batch inference has some implementation; specific features may be missing.
- A1352 [partial/M] Anthropic batch inference (in 1 projects): anthropic batch inference has some implementation; specific features may be missing.
- A1410 [partial/S] Pydantic structured output validation (in 1 projects): Delegates validate resultSchema; no Pydantic model integration.
- A1468 [missing/M] ADB operator (in 1 projects): adb operator not implemented.
- A1509 [missing/L] TypeScript, Python, and Go SDKs (in 1 projects): typescript, python, and go sdks not implemented.
- A1561 [missing/M] Action trace recording (in 1 projects): No action trace recording or scrubbed screenshot output.
- A1589 [partial/M] Bounded visual trajectory (in 1 projects): Visual trajectory limiting for multimodal context requires image handling.
- A1611 [missing/M] Side-panel chat (in 1 projects): side-panel chat not implemented.
- A1745 [missing/L] Retriever pipeline (in 1 projects): Retriever pipeline requires document indexing and ranking.
- A1749 [missing/M] Gradio interface (in 1 projects): gradio interface not implemented.
- A1976 [missing/L] Personal knowledge base (in 1 projects): Personal knowledge base with graph database requires graph storage; not applicable locally.
- A1979 [partial/M] Self-evolution executor (in 1 projects): Skill governance allows constrained skill updates; no general self-evolution.
- A2001 [missing/M] Prompt library and groups (in 1 projects): No prompt library or grouping system.
- A2243 [missing/M] Background terminal sessions (in 1 projects): Shell.execute is foreground/timed only.
- A2315 [missing/S] Headless mode (in 1 projects): Headless mode not explicitly implemented.
- A2334 [missing/M] Artifact file operations (in 1 projects): No artifact storage/versioning.
- A2375 [missing/L] Configurable intent pipeline (in 1 projects): No configurable intent pipeline; only skill discovery and dispatch.
- A2377 [missing/M] Fallback dispatch (in 1 projects): No fallback dispatch system; failures are errors.

## evaluation-and-benchmarks — 51 pieces (52 rows) {'M': 10, 'L': 38, 'S': 4}

- [x] FAMILY evaluation-framework (2 rows): Evaluation and replay framework, Chat quality evaluation — done (0.14.0): src/evaluation-suites.ts, src/evaluation-runner.ts; tests/evaluation-more.test.mjs
- [x] FAMILY provider-testing (1 rows): Provider matrix tests — done (0.14.0): one suite across two model choices; tests/evaluation-more.test.mjs
- [x] FAMILY benchmark-harness (1 rows): Evaluation harness — done (0.14.0): src/evaluation.ts with history and grading; tests/evaluation-more.test.mjs
- A0570 [missing/L] Benchmark harness (in 2 projects): No benchmark runner for evaluating agents on standard tasks.
- A0926 [missing/L] Evaluation runner (in 2 projects): No evaluation runner for programs over test sets with metrics.
- A0078 [missing/M] Agent tool evaluations (in 1 projects): No dedicated evaluation harnesses for individual tools; integration tests only.
- A0248 [missing/L] Telemetry and evaluation harness (in 1 projects): No telemetry exporter or SWE-bench evaluation harness.
- A0297 [missing/L] SWE-bench evaluation hook (in 1 projects): No SWE-bench evaluation hook or integration.
- A0347 [missing/L] Coding benchmark harness (in 1 projects): No coding benchmark harness or result analysis.
- A0374 [partial/L] Execution and debugging loop (in 1 projects): Execution occurs via shell/tools; troubleshooting agent capability missing.
- A0375 [partial/M] Task completion review (in 1 projects): Completion checks and reliability verify outcomes; lacks dedicated bug-hunter role.
- A0460 [missing/L] SWE-bench evaluation (in 1 projects): No SWE-bench evaluation tooling or benchmark configuration.
- A0499 [missing/L] Benchmark CLI (in 1 projects): No benchmark CLI or APPS/MBPP dataset evaluation.
- A0571 [missing/L] SWE-bench runner (in 1 projects): No SWE-bench runner or integration.
- A0724 [missing/L] SWE-bench harness (in 1 projects): No SWE-bench runner implementation.
- A0725 [missing/L] Terminal-bench harness (in 1 projects): No terminal-bench harness or Harbor integration.
- A0858 [missing/L] Evaluation and BEIR benchmarks (in 1 projects): No evaluation benchmarks or BEIR evaluators.
- A0884 [missing/L] Evaluation framework (in 1 projects): No evaluation framework classes for scoring agents.
- A0927 [missing/M] Built-in answer metrics (in 1 projects): No built-in answer metrics or evaluation helpers.
- A0973 [missing/M] Deterministic testing utilities (in 1 projects): No deterministic testing utilities or scripted test doubles.
- A1009 [missing/M] Scorers and evaluation runs (in 1 projects): No evaluator runners or score persistence.
- A1010 [missing/S] Evaluation gates (in 1 projects): No evaluation gates or threshold logic.
- A1128 [missing/M] Evaluation results and evaluators (in 1 projects): No evaluation result structures or evaluator components.
- A1190 [missing/L] Agent evaluation framework (in 1 projects): No agent evaluation framework or trajectory scoring.
- A1210 [missing/L] Evaluation datasets and evaluators (in 1 projects): No evaluation datasets, evaluators, or online evaluation hooks.
- A1231 [missing/L] Benchmark framework (in 1 projects): No benchmark framework or benchmark implementations.
- A1252 [missing/L] AGBench benchmark runner (in 1 projects): No AGBench runner or benchmark orchestration.
- A1253 [missing/M] AGBench result tabulation (in 1 projects): No AGBench result tabulation or CLI.
- A1499 [missing/L] Research evaluation suite (in 1 projects): No research evaluation suite or benchmark scoring.
- A1550 [missing/L] GAIA experiment configuration (in 1 projects): No GAIA experiment configuration or evaluation setup.
- A1593 [missing/L] OSWorld integration (in 1 projects): No OSWorld benchmark integration.
- A1594 [missing/M] Behavior Best-of-N (in 1 projects): No Best-of-N trajectory comparison or judgment.
- A1598 [missing/L] WindowsAgentArena integration (in 1 projects): No WindowsAgentArena integration or deployment guidance.
- A1599 [missing/L] AndroidWorld benchmark claim (in 1 projects): No AndroidWorld adapter or integration.
- A1691 [missing/M] Benchmark adapter (in 1 projects): No BenchmarkAdapter or eval command API.
- A1692 [missing/L] WAA checkpoint evaluation (in 1 projects): No WAA benchmark evaluation or checkpoint scorer.
- A1714 [missing/L] WebVoyager task evaluation (in 1 projects): No WebVoyager task evaluation or benchmark conversion.
- A1722 [missing/L] Study abstraction (in 1 projects): No study abstraction or reproducible experiment definition.
- A1723 [missing/L] Parallel experiment loop (in 1 projects): No parallel experiment loop with retries and checkpoints.
- A1726 [missing/L] BrowserGym benchmark integration (in 1 projects): No BrowserGym integration or environment APIs.
- A1727 [missing/L] OSWorld benchmark adapter (in 1 projects): No OSWorld task adaptation or benchmark runner.
- A1728 [missing/L] GAIA benchmark adapter (in 1 projects): No GAIA task adaptation or conversion.
- A1729 [missing/L] Experiment result inspection (in 1 projects): No experiment aggregation, result inspection or metrics computation.
- A1731 [missing/L] Agent X-ray analysis (in 1 projects): No action/observation diagnostics or visualizations.
- A1736 [missing/L] Reproducibility journal (in 1 projects): No reproducibility journal or study replay capability.
- A1752 [missing/L] Agent evaluation (in 1 projects): No agent evaluator or trajectory comparison scoring.
- A1753 [missing/L] QA test generation/execution (in 1 projects): No QA test generation or execution framework.
- A1764 [missing/S] String-answer evaluator (in 1 projects): No evaluator for string answers with matching logic.
- A1765 [missing/S] URL evaluator (in 1 projects): No URL pattern evaluator for endpoint validation.
- A1766 [missing/S] HTML-state evaluator (in 1 projects): No HTML-state evaluator or content matcher.
- A1767 [missing/L] End-to-end benchmark runner (in 1 projects): No end-to-end benchmark runner with task/trajectory/scoring pipeline.

## browser-automation — 26 pieces (51 rows) {'S': 19, 'M': 20, 'L': 12}

- [x] FAMILY browser-persistence (1 rows): Stateful browser automation — done (0.14.0): src/integrations/browser-profiles.ts, browser-session.ts; tests/browser-2.test.mjs
- [x] FAMILY web-access (2 rows): Web search and page reading tools, Browserbase Search and Fetch — done (0.14.0): src/integrations/web.ts and web-search.ts; tests/web-pin-hygiene.test.mjs
- [x] FAMILY vision-browser (1 rows): Vision web browser — done (0.14.0): numbered marks and element pictures; tests/browser-2.test.mjs
- [x] FAMILY desktop-automation (2 rows): Computer-use tool abstraction, Virtual computer abstraction — done (0.14.0): src/integrations/computer.ts and desktop-tools.ts; tests/screen-control.test.mjs
- [x] FAMILY framework-tools (1 rows): Toolkit abstraction — done (0.14.0): tool groups in src/catalog.ts; tests/catalog-diet.test.mjs
- [x] FAMILY hybrid-tooling (1 rows): Hybrid browser automation — not applicable: hybrid Python and TypeScript toolkits; Branch is TypeScript
- [x] FAMILY examples (1 rows): Browser-agent example — done (0.14.0): three shipped browser skills in src/browser-skills.ts; tests/browser-2.test.mjs
- [x] FAMILY browser-automation (22 rows): Search-engine query action, Browserbase remote operator, Browser-agent SDK, Natural-language actions, Page observation, Visual browser operation, Persistent browser daemon, Raw CDP access, Accessibility-tree element targeting, Download handling, Browser task execution, Fara browser agent … — done (0.14.0): src/integrations/browser*.ts marks, healing, attach; tests/browser-2.test.mjs
- [x] FAMILY extraction (3 rows): LLM-assisted page extraction, Browser-based scraping, Structured extraction — done (0.14.0): shaped extraction in src/integrations/browser-schema.ts; tests/browser-2.test.mjs
- [x] FAMILY tool-definition (1 rows): Custom typed action registry — done (0.14.0): typed browser actions in src/browser-skills.ts; tests/browser-2.test.mjs
- [x] FAMILY resilience (1 rows): Self-healing actions — done (0.14.0): src/integrations/browser-heal.ts renames heal by name; tests/browser-2.test.mjs
- [x] FAMILY cloud-compute (1 rows): Browserbase remote sessions — not applicable: hosted cloud browsers; Branch drives this computer's browser
- [ ] FAMILY doc-processing (1 rows): PDF text extraction — not done
- [x] FAMILY trace-capture (1 rows): Playwright trace capture — done (0.14.0): src/integrations/browser-trace.ts kept recordings; tests/browser-2.test.mjs
- [ ] FAMILY document-processing (1 rows): Document extraction — partial: Word, spreadsheet and HTML become text; a PDF still needs a helper Branch does not have
- [x] FAMILY remote-execution (1 rows): Remote computers — not applicable: remote or cloud computers; Branch runs on this one
- A2172 [partial/S] Browser-use automation (in 2 projects): Playwright automation exists; no Python runtime.
- A1568 [missing/L] Domain-specific browser skills (in 1 projects): No domain-specific browser skills; generic browser automation only.
- A1639 [missing/S] No browser file-upload control (in 1 projects): Browser tools support navigate/snapshot/click/fill only; no file-input handler.
- A2019 [missing/L] Browser/computer-use tools (in 1 projects): Shipyard sandbox backend not integrated; Playwright browser only.
- A2042 [partial/S] Browser-use integration (in 1 projects): Playwright browser exists with policy; no Python browser-use runtime.
- A2129 [partial/S] Computer/browser operator (in 1 projects): Browser has accessibility snapshots, not screenshot output.
- A2144 [missing/M] DOM annotation directives (in 1 projects): DOM annotation directives not implemented.
- A2183 [missing/L] Real-browser CDP control (in 1 projects): Playwright-based browser, not CDP-driven session reuse.
- A2241 [missing/L] Agent-driven signed-in browser (in 1 projects): Browser isolation prevents state reuse for signed-in sessions.
- A2286 [missing/M] Browser annotation session state (in 1 projects): No DOM annotation tracking.

## tracing-and-telemetry — 40 pieces (40 rows) {'L': 12, 'M': 25, 'N/A': 1, 'S': 2}

- [x] FAMILY otel-diagnostics (1 rows): OpenTelemetry diagnostics — done (0.14.0): src/tracing-shapes.ts OTLP spans and metrics; tests/tracing-policy.test.mjs T2
- [x] FAMILY otel-export (1 rows): OTLP monitoring export — done (0.14.0): src/tracing-export.ts batches and retries; tests/tracing-policy.test.mjs T2
- [x] FAMILY otel-tracing (1 rows): OpenTelemetry traces — done (0.14.0): src/tracing.ts nested spans and traceparent; tests/tracing-policy.test.mjs T1
- [x] FAMILY otel-integration (1 rows): OpenTelemetry and Langfuse — done (0.14.0): OTLP, Langfuse and Langsmith destinations; tests/tracing-policy.test.mjs T2
- [x] FAMILY langfuse-integration (1 rows): Langfuse tracing plugin — done (0.14.0): spansToLangfuse in src/tracing-shapes.ts; tests/tracing-policy.test.mjs T2
- A0031 [missing/L] OpenTelemetry tracing (in 5 projects): No OpenTelemetry SDK or OTLP export integration present.
- A0835 [missing/M] Telemetry (in 3 projects): No telemetry collection for agents/tasks/LLM calls.
- A0972 [partial/M] Tracing (in 3 projects): Tool/completion execution recorded; no trace/span processors or export.
- A1149 [missing/L] OpenTelemetry instrumentation (in 3 projects): No OpenTelemetry instrumentation for FastAPI/SQLAlchemy/Redis/HTTP.
- A0385 [missing/M] Opt-out telemetry (in 2 projects): No opt-out telemetry system or configuration controls.
- A0597 [missing/L] OpenTelemetry export (in 2 projects): No OpenTelemetry export or OTEL tracing.
- A0613 [missing/M] Langfuse tracing (in 2 projects): No Langfuse integration for agent/model tracing.
- A0823 [missing/M] LangSmith tracing integration (in 2 projects): No LangSmith tracer or integration for run submission.
- A0056 [missing/L] OpenTelemetry observability (in 1 projects): No OpenTelemetry logs/metrics/traces for agent interactions.
- A0155 [missing/M] Privacy-bounded telemetry (in 1 projects): No privacy-bounded telemetry collection or opt-out controls.
- A0225 [missing/M] Metrics and telemetry controls (in 1 projects): No metrics collection or telemetry opt-out controls.
- A0270 [missing/M] Telemetry client (in 1 projects): No telemetry client for product/runtime events.
- A0566 [missing/M] Sentry error telemetry (in 1 projects): No Sentry integration or error telemetry reporting.
- A0681 [missing/N/A] Tracing/logging (in 1 projects): No Rust tracing integration for diagnostics.
- A0799 [missing/L] Tracing integrations (in 1 projects): No tracing service for flow-run integration with external observability.
- A0800 [missing/L] Logs API and Grafana/Loki stack (in 1 projects): No logs API or Grafana/Loki integration.
- A0856 [missing/L] Instrumentation and OpenTelemetry (in 1 projects): No OpenTelemetry instrumentation package or OTEL integration.
- A0882 [missing/M] Runtime trace collection (in 1 projects): No runtime trace collection or authenticated trace routes.
- A0955 [missing/M] Tracing middleware (in 1 projects): No tracing middleware for agent/model/tool spans.
- A1127 [missing/M] Tracing integration (in 1 projects): No tracer abstractions or span propagation.
- A1189 [missing/M] Metrics (in 1 projects): No telemetry module or runtime metrics recording.
- A1263 [missing/L] OpenTelemetry (in 1 projects): No OpenTelemetry for agent/workflow spans and metrics.
- A1287 [missing/S] Tracing example (in 1 projects): No tracing example for node/flow execution.
- A1303 [missing/L] OpenTelemetry tracing and metrics (in 1 projects): No OpenTelemetry tracing and metrics support.
- A1334 [partial/S] Application logging guidance (in 1 projects): Python standard logging available; no framework telemetry backend.
- A1356 [missing/M] Langfuse trace export (in 1 projects): No Langfuse trace export or integration.
- A1418 [missing/M] Anonymous PostHog telemetry with opt-out (in 1 projects): No PostHog telemetry or anonymous usage tracking.
- A1440 [missing/M] Trace IDs and Langfuse (in 1 projects): No Langfuse trace ID binding or gateway.
- A1497 [missing/M] LangSmith tracing (in 1 projects): No LangSmith tracing or callback integration.
- A1498 [missing/L] OpenTelemetry/Monocle tracing (in 1 projects): No OpenTelemetry/Monocle tracing integration.
- A1523 [missing/M] LLM tracing and model usage telemetry (in 1 projects): No LLM tracing or usage telemetry.
- A1583 [missing/M] OpenTelemetry projection (in 1 projects): No OpenTelemetry projection or journal event export.
- A1620 [missing/M] Optional analytics (in 1 projects): No analytics service or optional event emission.
- A1751 [missing/M] Execution telemetry (in 1 projects): No telemetry module or anonymous metric emission.
- A1931 [partial/M] Event audit logs (in 1 projects): Activity log exists; limited event coverage.

## web-ui — 40 pieces (40 rows) {'M': 26, 'L': 10, 'S': 4}

- [ ] FAMILY sdk-react (1 rows): React SDK — not done
- [x] FAMILY agent-specialist (1 rows): Human proxy/console agent — done (0.14.0): src/ask-first.ts puts the question in the conversation; tests/web-ui.test.mjs U3
- [x] FAMILY user-intervention (1 rows): Live logs and intervention — done (0.14.0): live row, Stop and steering; tests/web-ui.test.mjs U3
- [ ] FAMILY app-building (1 rows): App-builder SDK MCP server — not done
- [x] FAMILY token-display (1 rows): Context/token usage display — done (0.14.0): context meter from src/catalog.ts accounting; tests/web-ui.test.mjs U4
- A0080 [partial/M] Agent Canvas web UI (in 1 projects): Web UI exists; specific framework/architecture may differ.
- A0275 [missing/M] Visual web workflow console (in 1 projects): visual web workflow console not implemented.
- A0285 [partial/M] Trajectory inspector web UI (in 1 projects): Web UI exists; specific framework/architecture may differ.
- A0401 [missing/M] Dashboard and desktop (in 1 projects): Desktop application not implemented.
- A0419 [missing/M] Chainlit UI example (in 1 projects): chainlit ui example not implemented.
- A0527 [partial/M] Chat web UI (in 1 projects): Web UI exists; specific framework/architecture may differ.
- A0704 [partial/M] Local WebUI (in 1 projects): Web UI exists; specific framework/architecture may differ.
- A0731 [missing/M] Interactive playground (in 1 projects): No dedicated interactive playground UI for testing or demos.
- A0956 [partial/M] Web UI example (in 1 projects): Web UI exists; specific framework/architecture may differ.
- A1131 [missing/M] Gradio UI (in 1 projects): gradio ui not implemented.
- A1192 [partial/M] Development web UI and API (in 1 projects): Web UI exists; specific framework/architecture may differ.
- A1302 [partial/M] HITL intervention (in 1 projects): Branch pauses for user input; no Slack/web UI specifically for HITL.
- A1435 [missing/L] Next.js web chat (in 1 projects): next.js web chat not implemented.
- A1452 [missing/S] Web crawling (in 1 projects): No Crawl4AI integration; uses playwright-based web fetching.
- A1536 [missing/L] Gradio web application (in 1 projects): gradio web application not implemented.
- A1585 [missing/L] Cross-platform GUI control (in 1 projects): cross-platform gui control not implemented.
- A1676 [missing/M] Streamlit demo UI (in 1 projects): streamlit demo ui not implemented.
- A1774 [partial/M] Web control UI and WebChat (in 1 projects): Web UI exists; specific framework/architecture may differ.
- A1904 [missing/M] Progressive Web App support (in 1 projects): Progressive Web App (PWA) offline support not implemented.
- A1905 [missing/L] Interactive terminal coding agent (in 1 projects): Dedicated Rust TUI not built; only JavaScript terminal interface.
- A1932 [missing/M] Browser extension (in 1 projects): Browser extension not implemented; only web app and desktop app.
- A1934 [missing/M] Embeddable chat widget (in 1 projects): Embeddable chat widget (for other websites) not implemented.
- A1940 [partial/M] Multi-assistant conversations (in 1 projects): Web UI supports multiple conversations but not Cherry Studio-style assistant profiles.
- A1983 [missing/L] Multilingual documentation/UI (in 1 projects): English-only interface and documentation; no i18n.
- A1984 [partial/L] Multi-user web chat (in 1 projects): Single-owner web chat exists; multi-user support not implemented.
- A1997 [missing/L] Interactive code artifacts (in 1 projects): No sandboxed artifact rendering; conversations are text-only.
- A2015 [partial/M] Web dashboard and webchat (in 1 projects): Web dashboard and chat exist but no file upload UI.
- A2033 [missing/M] Web Console (in 1 projects): Dedicated web console UI not implemented.
- A2093 [missing/S] Cron task interface (in 1 projects): No UI for cron task definition; schedules created via API.
- A2133 [missing/L] Obsidian plugin (in 1 projects): Obsidian plugin not implemented.
- A2157 [partial/S] Web management panel (in 1 projects): Web management panel exists but basic.
- A2197 [partial/M] Terminal UIs (in 1 projects): Terminal UI via Node.js, not Rust TUI.
- A2198 [missing/M] Streamlit web UI (in 1 projects): Streamlit UI not implemented.
- A2200 [missing/M] Desktop pet UI (in 1 projects): Desktop pet UI not implemented.
- A2240 [missing/L] Live embedded app surfaces (in 1 projects): Live embedded app surfaces not implemented.

## voice-io — 21 pieces (40 rows) {'L': 9, 'M': 27, 'S': 4}

- [ ] FAMILY model-provider (17 rows): Live voice provider, Voice provider: aws-nova-sonic, Voice provider: azure, Voice provider: cloudflare, Voice provider: deepgram, Voice provider: elevenlabs, Voice provider: gladia, Voice provider: google, Voice provider: google-gemini-live-api, Voice provider: inworld, Voice provider: mistral, Voice provider: modelslab … — partial: OpenAI, Gemini, Windows and local whisper only; no Deepgram, ElevenLabs, Azure or the live-voice services
- [ ] FAMILY content-fetching (1 rows): YouTube transcript tool — not done
- [x] FAMILY voice-io (4 rows): Speech-to-text input, Speech and text-to-speech, Speech transcription and TTS, Audio-capable model handling — done (0.14.0): src/voice-stt.ts, voice-tts.ts, voice-talk.ts; tests/voice-providers.test.mjs
- [x] FAMILY voice-input (1 rows): Speech-to-text — done (0.14.0): src/voice-stt.ts three shapes plus local; tests/voice-providers.test.mjs
- [ ] FAMILY voice (1 rows): Plugin-based speech and intent stack — partial: speech in and out is built in; there is no pluggable speech or intent stack
- A1995 [missing/L] Text-to-speech (in 2 projects): Text-to-speech synthesis not implemented in Branch Agent.
- A0328 [missing/M] Voice-message input (in 1 projects): voice-message input not implemented.
- A0654 [partial/M] Local voice-note transcription (in 1 projects): local voice-note transcription has some implementation; specific features may be missing.
- A0888 [missing/L] Image, audio and video inputs (in 1 projects): No image, audio, or video input attachment support.
- A0970 [missing/M] STT-agent-TTS voice pipelines (in 1 projects): stt-agent-tts voice pipelines not implemented.
- A1001 [missing/M] Speech-to-text and text-to-speech (in 1 projects): speech-to-text and text-to-speech not implemented.
- A1212 [missing/M] Realtime voice/model sessions (in 1 projects): realtime voice/model sessions not implemented.
- A1893 [missing/M] Speech-to-text transcription (in 1 projects): Speech-to-text transcription not implemented; text-based chat only.
- A1894 [missing/M] Text-to-speech synthesis (in 1 projects): Text-to-speech synthesis not implemented; text-based responses only.
- A2067 [missing/L] Voice notes and transcription (in 1 projects): No audio transcription pipeline in Branch.
- A2068 [missing/L] Text-to-speech and voice calls (in 1 projects): No TTS or voice-call implementation.
- A2107 [missing/L] Text-to-speech sending (in 1 projects): No TTS tool integration.
- A2162 [missing/M] Voice assistant interface (in 1 projects): Voice assistant (ASR/TTS) not implemented.
- A2173 [missing/L] Audio transcription and synthesis tools (in 1 projects): No Whisper, OpenAI audio, or TTS backends.
- A2266 [missing/M] Local text-to-speech (in 1 projects): No Kokoro or local TTS.
- A2293 [missing/L] Realtime voice input (in 1 projects): No real-time audio capture or ASR.

## permissions-and-policies — 33 pieces (33 rows) {'M': 19, 'L': 6, 'S': 8}

- [x] FAMILY network-diagnostics (1 rows): Allowlisted network probes — done (0.14.0): src/network-policy.ts and src/provider-probe.ts; tests/web-pin-hygiene.test.mjs
- [x] FAMILY enterprise (1 rows): Enterprise agent-builder policies — not applicable: organisation-wide builder policy; Branch has one owner
- A1805 [partial/M] Execution approvals (in 2 projects): user.ask pauses; not explicit execution approval protocol.
- A0048 [partial/M] Policy engine for tool decisions (in 1 projects): Permission set checked; no fine-grained policy rules.
- A0152 [partial/M] Approval modes (in 1 projects): user.ask for ask mode; no full approval policy.
- A0220 [partial/M] Interactive tool permissions (in 1 projects): user.ask for interaction; no persistent per-session grants.
- A0245 [partial/M] Tool approval and sandbox policy (in 1 projects): Tool permission gating; no sandbox policy selection.
- A0262 [partial/L] Granular permission rules (in 1 projects): Coarse permission set; no per-resource rules.
- A0365 [partial/L] Authentication and access policy (in 1 projects): Basic auth; no role-based access policy.
- A0398 [partial/M] Workflow approval (in 1 projects): user.ask pauses; no explicit workflow approval gates.
- A0596 [partial/M] Approval gates and tool policies (in 1 projects): Tool execution gated; no explicit approval gates.
- A0617 [partial/S] Human approval and file diffs (in 1 projects): File history tracks changes; user.ask for approval.
- A0796 [partial/L] Pluggable authorization and audit (in 1 projects): Simple permission model exists in contracts; no pluggable authorization framework.
- A0824 [partial/M] Human-in-the-loop middleware (in 1 projects): user.ask pauses execution for review; not implemented as middleware pattern.
- A1005 [missing/L] RBAC/FGA integrations (in 1 projects): No RBAC or FGA integration (WorkOS or other).
- A1126 [partial/M] Human-in-the-loop tool hooks (in 1 projects): user.ask for interaction; no tool-specific hook interception.
- A1465 [missing/S] OS permission checks (in 1 projects): Desktop app does not check OS accessibility/screen permissions.
- A1521 [missing/M] Browser action approval policy (in 1 projects): No approval flow for browser side effects.
- A1629 [partial/M] Command policy and approvals (in 1 projects): Shell commands can be allowed/denied; no granular policy UI.
- A1685 [missing/S] Explicit run authorization (in 1 projects): No --allow-run flag for execution authorization.
- A1686 [missing/L] Exact-byte sanitized approval (in 1 projects): No sanitized-derivative approval mechanism.
- A1834 [partial/M] Command approvals and guardrails (in 1 projects): Shell execution gated; no explicit approval UI.
- A2006 [missing/L] Role and resource permissions (in 1 projects): No role/resource permission system.
- A2027 [partial/S] Whitelist filtering (in 1 projects): Telegram allowlist exists; no generic whitelist.
- A2053 [partial/M] Tool-call policy guard (in 1 projects): Permission context exists; no allow/deny/ask policy UI.
- A2075 [partial/M] Interactive approvals (in 1 projects): user.ask for input; not WebSocket-based approval.
- A2076 [missing/S] Authentication rate limiting (in 1 projects): No rate limiting on authentication attempts.
- A2088 [partial/S] Tool-call approval state (in 1 projects): Approval via user.ask; no persistent state tracking.
- A2233 [partial/M] Manifest resource permissions (in 1 projects): Grants exist but not manifest-based permission system.
- A2276 [missing/S] Tool approvals (in 1 projects): No explicit approval gate for sensitive operations.
- A2278 [missing/M] Computer-use permissions (in 1 projects): Desktop service not part of Branch design.
- A2296 [missing/M] Cowork permission prompts (in 1 projects): No UI permission gates for sensitive operations.
- A2344 [missing/S] Conversation pruning (in 1 projects): Conversation pruning retention policy not implemented; no automatic history cleanup.

## agent-interop — 15 pieces (32 rows) {'L': 22, '?': 1, 'M': 9}

- [x] FAMILY acp-support (11 rows): ACP server, Agent Client Protocol mode, ACP agent servers, ACP agent integration, Agent Client Protocol server, ACP bridge and daemon, Agent Client Protocol, ACP, ACP integration, ACP connectors, ACP server and embedded mode — done (0.14.0): src/acp.ts and branch acp-serve; tests/interop-agents.test.mjs
- [x] FAMILY tool-registry (1 rows): Tool registry — done (0.14.0): src/registry.ts with OpenAPI and skill tools added at runtime; tests/tool-loading.test.mjs
- [ ] FAMILY agent-protocol (1 rows): Agent Protocol task API — partial: A2A tasks and an OpenAI-shaped endpoint exist; the Agent Protocol task API itself does not
- [x] FAMILY a2a-interop (7 rows): A2A, A2A delegation, A2A protocol, A2A remote agents, A2A integration, A2A server, A2A connectors — done (0.14.0): src/a2a.ts, a2a-client.ts, a2a-routes.ts; tests/interop-agents.test.mjs
- [x] FAMILY rest-api (1 rows): AgentOS REST runtime — done (0.14.0): src/server.ts routes plus packages/sdk client; tests/server.test.mjs
- [x] FAMILY agent-specialist (2 rows): A2A agent, A2A agent protocol — done (0.14.0): A2A agent card, tasks and cancel; tests/interop-agents.test.mjs
- [x] FAMILY protocol-adapter (1 rows): ACP SDK adapter — done (0.14.0): src/acp.ts speaks the protocol directly; tests/interop-agents.test.mjs
- [x] FAMILY protocols (1 rows): Multi-protocol serving — done (0.14.0): HTTP, OpenAI-shaped, MCP, A2A and ACP; tests/interop-agents.test.mjs
- [x] FAMILY interop (1 rows): ACP bridge — done (0.14.0): src/acp.ts bridge; tests/interop-agents.test.mjs
- [ ] FAMILY client-tools (1 rows): External client tools — partial: the socket streams events one way; a client cannot register its own tools over it
- A0429 [missing/M] Custom agent modes (in 1 projects): Custom agent modes not implemented; fixed identity/instructions only.
- A0813 [partial/M] Schema-constrained agent responses (in 1 projects): Delegates check resultSchema; provider-native structured JSON not exposed.
- A0969 [missing/M] Realtime multimodal agents (in 1 projects): realtime multimodal agents not implemented.
- A1187 [partial/M] OAuth/tool authentication (in 1 projects): MCP client integrated; OAuth depends on server implementation.
- A1857 [missing/L] Agent marketplace (in 1 projects): No agent marketplace or publication system.

## mcp-server-mode — 23 pieces (30 rows) {'M': 17, 'L': 9, 'S': 4}

- [x] FAMILY mcp-enhancements (2 rows): MCP client integration, MCP context servers — done (0.14.0): src/integrations/mcp.ts client and src/mcp-apps.ts; tests/mcp-mode.test.mjs
- [x] FAMILY mcp-server-config (1 rows): MCP server configuration — done (0.14.0): sharing settings with a tool list and snippets; tests/mcp-server.test.mjs
- [x] FAMILY mcp-apps (1 rows): MCP Apps proxy — done (0.14.0): src/mcp-apps.ts sandboxed frame; tests/mcp-mode.test.mjs C6
- [x] FAMILY mcp-client (1 rows): MCP plugin client — done (0.14.0): src/integrations/mcp.ts per-task connections; tests/mcp-mode.test.mjs C5
- [x] FAMILY mcp-transports (2 rows): MCP SSE transport, MCP client/server — done (0.14.0): streamable HTTP with an event stream, and stdio; tests/mcp-mode.test.mjs C1
- [x] FAMILY mcp-runtime (1 rows): MCP runtime — done (0.14.0): src/mcp-lifecycle.ts; tests/mcp-mode.test.mjs C5
- [x] FAMILY mcp-server (5 rows): MCP server, MCP server mode, MCP server and browser tools, MCP stdio server, MCP run tools — done (0.14.0): src/mcp-server.ts and branch mcp-serve; tests/mcp-server.test.mjs
- [x] FAMILY agentos-compat (1 rows): AgentOS MCP server endpoint — done (0.14.0): src/mcp-server.ts endpoint; tests/mcp-server.test.mjs
- [x] FAMILY mcp-types (1 rows): MCP client/server types — done (0.14.0): src/mcp-tools.ts and src/mcp-stdio.ts; tests/mcp-server.test.mjs
- [x] FAMILY mcp-workbench (1 rows): MCP workbench and tool adapters — done (0.14.0): src/mcp-workbench.ts tries a server; tests/mcp-mode.test.mjs C7
- [x] FAMILY mcp-examples (1 rows): MCP transports — done (0.14.0): connection snippets per client; tests/mcp-server.test.mjs
- [x] FAMILY mcp-resources (1 rows): MCP prompts and resources — done (0.14.0): resources and prompts served; tests/mcp-server.test.mjs
- [x] FAMILY mcp-snapshots (1 rows): MCP tool references and snapshots — done (0.14.0): src/mcp-snapshots.ts records the list shown; tests/mcp-mode.test.mjs C2
- [x] FAMILY mcp (2 rows): MCP HTTP server, Workspace MCP host — done (0.14.0): src/mcp-server.ts over HTTP from the workspace; tests/mcp-server.test.mjs
- [x] FAMILY examples (1 rows): MCP client integrations — done (0.14.0): copyable connection snippets carrying this install's address; tests/mcp-server.test.mjs
- [x] FAMILY connection-lifecycle (1 rows): Per-run tool and MCP connection lifecycle — done (0.14.0): src/mcp-lifecycle.ts opens and closes per run; tests/mcp-mode.test.mjs C5
- [x] FAMILY user-settings (1 rows): Per-user MCP server settings — done (0.14.0): connection settings kept per person; tests/mcp-mode.test.mjs C5
- [x] FAMILY mcp-api (1 rows): MCP API surface — done (0.14.0): src/mcp-policy.ts and the settings routes; tests/mcp-server.test.mjs
- [x] FAMILY mcp-oauth (1 rows): MCP client with OAuth — done (0.14.0): src/integrations/mcp-oauth.ts, key stays in the locker; tests/mcp-mode.test.mjs C4
- A0169 [partial/M] MCP OAuth (in 2 projects): MCP client exists; OAuth depends on server.
- A0636 [missing/M] Dry-run tool execution report (in 1 projects): No dry-run mode exists.
- A1342 [missing/M] MCP preflight policy (in 1 projects): MCP tools registered at startup; no preflight policy validation.
- A2082 [partial/M] Built-in browser MCP server (in 1 projects): MCP client exists; browser tools could be exposed via MCP.

## secrets-and-auth — 30 pieces (30 rows) {'M': 9, 'S': 9, 'L': 12}

- [x] FAMILY cloud-auth (1 rows): Vertex AI authentication — done (0.14.0): src/gemini-signin.ts bearer for Gemini and Vertex; tests/polish-observability.test.mjs G3
- [x] FAMILY mcp-oauth (1 rows): MCP OAuth — done (0.14.0): src/integrations/mcp-oauth.ts code flow with PKCE; tests/mcp-mode.test.mjs C4
- A0100 [missing/S] Session API-key authentication (in 1 projects): No per-session API-key authentication.
- A0221 [missing/S] Command-based secret expansion (in 1 projects): No command-based secret expansion.
- A0590 [missing/M] Secret scanning (in 1 projects): No secret scanning in skills.
- A0614 [partial/S] Session authentication and Telegram pairing (in 1 projects): Telegram pairing works; session auth loopback-only.
- A0686 [partial/S] Sender allowlist (in 1 projects): Telegram allowlist exists; no generic sender filter implemented.
- A0836 [partial/S] OAuth2 (in 1 projects): ChatGPT device-code OAuth flow; not full OAuth2 standard.
- A1003 [partial/L] Pluggable authentication (in 1 projects): ChatGPT and API-key auth; not pluggable provider system.
- A1004 [partial/M] Composite authentication (in 1 projects): Multiple auth types supported; not composable as chain.
- A1343 [partial/S] Secret vault and URI binding (in 1 projects): Locker stores secrets; no secret:// URI scheme resolution.
- A1414 [missing/M] Sensitive-data placeholder handling (in 1 projects): No placeholder mechanism for sensitive data redaction.
- A1519 [partial/L] Credential vault integrations (in 1 projects): Internal locker only; no Bitwarden/1Password integration.
- A1563 [missing/M] Recording secret redaction (in 1 projects): No redaction of secrets from logs.
- A1652 [partial/L] User authentication (in 1 projects): Provider auth exists; no user/account system.
- A1687 [partial/S] Secret references (in 1 projects): Env var injection exists; no URI scheme for secret refs.
- A1804 [partial/L] Gateway authentication (in 1 projects): Telegram pairing; no generic gateway auth.
- A1807 [partial/M] Secret providers (in 1 projects): Locker abstraction exists; no pluggable provider interface.
- A1841 [partial/L] Credential vault backends (in 1 projects): AES-256 locker only; no external vault backends.
- A1856 [partial/S] Credential storage and OAuth (in 1 projects): Model credentials supported; OAuth limited to ChatGPT.
- A1896 [missing/L] Local user authentication (in 1 projects): No local user login implemented.
- A1897 [partial/L] OAuth/OIDC authentication (in 1 projects): ChatGPT device-code only; not full OAuth/OIDC.
- A1930 [partial/S] API keys and temporary auth tokens (in 1 projects): API keys stored; no temporary token generation.
- A2002 [missing/L] Local account authentication (in 1 projects): No local account registration/login system.
- A2003 [missing/L] OAuth/OIDC social login (in 1 projects): Only ChatGPT OAuth; no configurable social login.
- A2074 [missing/L] WebAuthn authentication (in 1 projects): No WebAuthn registration/authentication.
- A2095 [missing/L] WebUI authentication and password reset (in 1 projects): No web UI auth or password reset.
- A2119 [missing/M] OAuth and PKCE (in 1 projects): OAuth and PKCE: only ChatGPT device-code OAuth.
- A2177 [missing/M] Profile authentication (in 1 projects): Profile authentication not part of single-owner local design.
- A2216 [missing/M] Multi-user authentication and OIDC (in 1 projects): Multi-user authentication not in scope for single-owner assistant.

## plugin-and-extension-system — 17 pieces (29 rows) {'L': 21, 'M': 6, 'S': 2}

- [ ] FAMILY plugin-marketplace (2 rows): Plugin management, Plugin marketplace — partial: plugins are installed and managed locally; there is deliberately no marketplace to browse
- [ ] FAMILY extension-packages (1 rows): CLI extension packages — partial: skill and plugin packages install from one file; there is no CLI extension package format
- [x] FAMILY extension-lifecycle (1 rows): Configurable extensions — done (0.14.0): a plugin adds nothing until switched on; tests/skills-plugins.test.mjs
- [x] FAMILY plugin-system (6 rows): Plugin system, Plugin API, Plugin SDK and DevKit, Plugin SDK and extension loading, Plugin framework, Plugin API and webhooks — done (0.14.0): src/plugins.ts and src/plugin-catalog.ts manifests; tests/skills-plugins.test.mjs
- [x] FAMILY plugin-lifecycle (2 rows): Plugin installation and lifecycle, Plugin manager and callbacks — done (0.14.0): src/plugins.ts install, enable, remove; tests/orchestration-2.test.mjs
- [x] FAMILY provider-bundles (1 rows): Provider bundle system — done (0.14.0): src/provider-plugins.ts brings a model connection; tests/sdk-misc.test.mjs
- [x] FAMILY framework-adapters (1 rows): MCP tools integration — done (0.14.0): src/integrations/mcp.ts tools; tests/mcp-mode.test.mjs
- [x] FAMILY tool-adapters (1 rows): LangChain and Hub Space tool adapters — not applicable: LangChain and Hugging Face Python tool adapters
- [x] FAMILY plugin-loading (2 rows): Plugin loader, Plugin loading — done (0.14.0): src/plugin-catalog.ts checks manifest and fingerprint; tests/orchestration-2.test.mjs
- [x] FAMILY skill-isolation (1 rows): Managed skills — done (0.14.0): src/skill-governance.ts sets failing skills aside; tests/governance.test.mjs
- [ ] FAMILY claude-integration (1 rows): Claude plugin package — not done
- [x] FAMILY external-frameworks (1 rows): Agent Skills integration — done (0.14.0): src/skill-document.ts reads Agent Skills front matter; tests/skills-plugins.test.mjs
- [x] FAMILY skill-distribution (1 rows): ClawHub skill distribution — done (0.14.0): src/registry.ts signed registry and registry-install.ts; tests/teams-registry.test.mjs
- [ ] FAMILY pipeline-integration (1 rows): Pipelines plugin integration — not done
- [ ] FAMILY filter-system (1 rows): Functions and filters extension system — partial: hooks and the content guard filter what passes; the owner cannot write filter functions
- [x] FAMILY manifest-system (1 rows): Demo extension contribution manifest — done (0.14.0): src/plugins.ts manifest declares what a plugin contributes; tests/orchestration-2.test.mjs
- [ ] FAMILY extensions (5 rows): Search plugins, Plugin and extension hooks, Extension SDK, Bundled extensions, Mods — partial: plugins, skills and hooks extend Branch; there are no search plugins or mods

## models.local-runtimes — 4 pieces (29 rows) {'?': 19, 'S': 3, 'M': 6, 'L': 1}

- [x] FAMILY provider-adapter (26 rows): Local Ollama models, Ollama local models, Local model endpoints, Local models, Local model support, Local model providers, Local model servers, Local LM Studio models, Local llama.cpp inference, Ollama integration, Ollama local-model adapter, Ollama local integration … — done (0.14.0): ollama, lm-studio, vllm, llama.cpp entries plus src/local-models.ts; tests/local-models.test.mjs
- [x] FAMILY model-serving (1 rows): Local inference server — done (0.14.0): src/local-models.ts downloads, lists and loads; tests/local-models.test.mjs L1
- A1788 [missing/S] Local model endpoints (in 2 projects): Local model endpoints not tested; Branch supports configured endpoints only.
- A2365 [missing/S] Local LLMs (in 1 projects): Local LLM endpoints not tested.

## cli-and-tui — 23 pieces (23 rows) {'M': 20, 'S': 2, 'L': 1}

- [ ] FAMILY custom-commands (1 rows): Custom commands — partial: saved procedures and skills are the owner's own; the terminal's slash commands are fixed
- A0284 [missing/M] CLI (in 10 projects): cli not implemented.
- A0205 [partial/M] Terminal UI (in 5 projects): Terminal streaming exists; full TUI panels not implemented.
- A0007 [partial/M] Terminal user interface (in 2 projects): terminal user interface has some implementation; specific features may be missing.
- A0012 [missing/S] Non-interactive exec mode (in 1 projects): non-interactive exec mode not implemented.
- A0136 [missing/M] Noninteractive exec mode (in 1 projects): noninteractive exec mode not implemented.
- A0137 [missing/M] Local web client (in 1 projects): local web client not implemented.
- A0183 [missing/M] CLI and TUI (in 1 projects): cli and tui not implemented.
- A0249 [missing/M] Headless CLI (in 1 projects): headless cli not implemented.
- A0306 [missing/M] Persistent server and multi-client attach (in 1 projects): persistent server and multi-client attach not implemented.
- A0383 [missing/M] CLI interface (in 1 projects): cli interface not implemented.
- A0425 [missing/M] Standalone CLI (in 1 projects): standalone cli not implemented.
- A0488 [missing/M] gpte CLI (in 1 projects): gpte cli not implemented.
- A0551 [missing/M] CLI entry point (in 1 projects): cli entry point not implemented.
- A0620 [missing/M] CLI command surface (in 1 projects): cli command surface not implemented.
- A0723 [missing/M] Scaffolding CLI (in 1 projects): scaffolding cli not implemented.
- A0793 [missing/M] LFX lightweight CLI (in 1 projects): lfx lightweight cli not implemented.
- A0910 [missing/S] Cron API client (in 1 projects): No LangGraph API client; local scheduler only.
- A1159 [missing/M] npm-distributed CLI (in 1 projects): npm-distributed cli not implemented.
- A1191 [missing/M] ADK CLI (in 1 projects): adk cli not implemented.
- A1211 [missing/M] CLI chat interface (in 1 projects): cli chat interface not implemented.
- A2103 [partial/M] Local/CLI model adapters (in 1 projects): CLI-invoked models supported but not all adapters.
- A2404 [missing/L] Interactive terminals (in 1 projects): Terminal chat (npm run chat) exists but not interactive PTY for shell sessions.

## deployment-and-packaging — 19 pieces (21 rows) {'M': 8, 'L': 11, '?': 2}

- [ ] FAMILY sandboxing (1 rows): Local execution with optional external isolation — partial: commands run in a Windows job with limits and no network; there is no container isolation
- [ ] FAMILY distributions (1 rows): Custom distributions — not done
- [ ] FAMILY sdk-python (3 rows): Python SDK, Python client, Python SDK/API client — not done
- [x] FAMILY sdk-java (1 rows): Java SDK — not applicable: a Java client for a local TypeScript app
- [ ] FAMILY desktop-packaging (1 rows): Cross-platform Electron packaging — partial: Electron packaging is built and tested for Windows only
- [x] FAMILY deployment-integrations (1 rows): Netlify deployment — not applicable: hosting deploys; Branch runs on this computer
- [x] FAMILY language-specific (1 rows): Private compiled Go modules — not applicable: private Go modules; Branch is TypeScript
- [x] FAMILY python-integration (1 rows): Custom primitive package isolation — not applicable: Python environment isolation for primitives
- [ ] FAMILY serialization (1 rows): Serialization and YAML marshalling — partial: skills are YAML and flows are JSON; there is no pipeline YAML marshalling
- [x] FAMILY hub-sharing (1 rows): Hugging Face Hub sharing — not applicable: publishing to a public model hub; the skill registry is the owner's own
- [x] FAMILY external-frameworks (1 rows): Letta Agent SDK — not applicable: an external agent app-server; Branch is self-contained
- [ ] FAMILY platform-support (1 rows): macOS and Windows/WSL quick-start deployment — partial: the Windows install is built and tested; macOS and WSL are not
- [x] FAMILY enterprise (1 rows): Enterprise feature boundary — not applicable: organisation and billing tiers; Branch has one owner
- [x] FAMILY administration (1 rows): Administrative settings UI and APIs — done (0.14.0): settings screens and their routes; tests/shell-ui.test.mjs
- [ ] FAMILY installers (1 rows): macOS, Linux and Windows installers — partial: a real Windows installer with an Uninstall entry; no macOS or Linux installer
- [x] FAMILY host-integration (1 rows): A0 CLI host bridge — not applicable: another CLI's host bridge; Branch runs commands itself
- [x] FAMILY installation (1 rows): Launcher and scripted installation — done (0.14.0): src/install/installer.ts and install-cli.ts; tests/deployment.test.mjs
- [x] FAMILY hardware (1 rows): GPU-specific Compose profiles — not applicable: Docker Compose GPU profiles; Branch runs natively
- A2406 [missing/L] Remote execution (in 1 projects): No SSH, RPC, or distributed execution; shell.execute is local only.

## memory-features — 20 pieces (20 rows) {'M': 13, 'L': 5, 'S': 2}

- [x] FAMILY research-pipeline (1 rows): Conversational knowledge curation — done (0.14.0): src/memory-consolidate.ts daily curation with review; tests/governance.test.mjs
- A0148 [partial/M] Persistent sessions (in 5 projects): No implementation found.
- A0422 [missing/M] Long/short-term role memory (in 1 projects): Memory scopes facts to entities/attributes with optional agent scope, not role-keyed histories.
- A0650 [missing/L] Automatic local long-term memory and RAG (in 1 projects): RAG not implemented.
- A1117 [missing/L] In-memory document store (in 1 projects): RAG not implemented.
- A1247 [partial/M] Task-centric memory (experimental) (in 1 projects): Task-centric memory requires per-task memory isolation; Branch uses owner/session scope.
- A1425 [partial/M] Pluggable DeerMem memory (in 1 projects): Pluggable memory backends require abstraction layer above SQLite.
- A1475 [missing/M] Pluggable session storage (in 1 projects): SQLite storage only; no file/memory/MongoDB support.
- A1795 [missing/L] Semantic memory search (in 1 projects): Semantic memory requires embeddings; only FTS5 implemented.
- A1892 [partial/L] User memory storage and retrieval (in 1 projects): User memory stored and retrieved via SQLite; embeddings for semantic retrieval missing.
- A1926 [partial/M] Workspace memory extraction (in 1 projects): Memory extraction from chats via model review implemented; semantic analysis limited to summarization.
- A1989 [partial/M] User memory (in 1 projects): User memory extraction and injection via model review implemented; semantic parsing limits.
- A2035 [partial/M] Three-layer memory (in 1 projects): Two-layer memory system (working + persistent); separate knowledge base layer not implemented.
- A2059 [partial/S] Workspace checkpoints (in 1 projects): Workspace snapshots via file history; memory snapshots and checkpoints partially implemented.
- A2168 [missing/L] Long-term memory with QMD retrieval (in 1 projects): Long-term memory with QMD backend requires external service; not configured.
- A2185 [partial/M] Layered filesystem memory (in 1 projects): Two-layer filesystem memory (procedures + facts); raw session layer mining not implemented.
- A2186 [partial/M] Raw-session compression and salient mining (in 1 projects): Conversation summarization implemented; session salient mining and compression missing.
- A2187 [missing/M] Memory cleanup workflow (in 1 projects): Memory cleanup workflow SOP requires agent-executable procedures; not provided.
- A2230 [partial/M] Persistent semantic memory (in 1 projects): SQLite memory with JSON mirroring exists; embeddings for usage tracking missing.
- A2245 [missing/S] Memory evaluation and cleanup (in 1 projects): Memory evaluation and cleanup scripts not provided for retrieval quality assessment.

## vector-and-hybrid-memory — 19 pieces (20 rows) {'L': 18, 'M': 2}

- [x] FAMILY storage-adapter (2 rows): Storage adapter: s3vectors, Storage adapter: vectorize — not applicable: hosted cloud vector stores; Branch's vectors live in its own database
- A0996 [missing/M] Vector-store abstraction (in 2 projects): No implementation found.
- A0278 [missing/L] Vector-backed agent memory (in 1 projects): Vector memory not implemented.
- A0417 [missing/L] Vector-store retrieval (in 1 projects): RAG not implemented.
- A0747 [missing/L] Vector memory retrieval (in 1 projects): Vector memory not implemented.
- [x] A0784 Vector-store integrations — not applicable: adapters for hosted vector services (Qdrant, Chroma, Pinecone, Weaviate and the like). Nobody running Branch on their own computer runs one beside it, an adapter could not be tested here without a network, and each is a new dependency for a service the owner does not have. Built instead: the `VectorBackend` contract, a second real place for the vectors on this machine (a database file the owner names, src/vector-store-file.ts), and a complete worked adapter in docs/configuration.md; tests/retrieval-2.test.mjs
- A0818 [missing/M] Vector-store abstraction and similarity search (in 1 projects): No implementation found.
- A0838 [missing/L] Vector-store indexing (in 1 projects): RAG not implemented.
- [x] A0947 Vector stores — not applicable: adapters for hosted vector services (Qdrant, Chroma, Pinecone, Weaviate and the like). Nobody running Branch on their own computer runs one beside it, an adapter could not be tested here without a network, and each is a new dependency for a service the owner does not have. Built instead: the `VectorBackend` contract, a second real place for the vectors on this machine (a database file the owner names, src/vector-store-file.ts), and a complete worked adapter in docs/configuration.md; tests/retrieval-2.test.mjs
- [x] A1103 Vector database connectors — not applicable: adapters for hosted vector services (Qdrant, Chroma, Pinecone, Weaviate and the like). Nobody running Branch on their own computer runs one beside it, an adapter could not be tested here without a network, and each is a new dependency for a service the owner does not have. Built instead: the `VectorBackend` contract, a second real place for the vectors on this machine (a database file the owner names, src/vector-store-file.ts), and a complete worked adapter in docs/configuration.md; tests/retrieval-2.test.mjs
- A1119 [missing/L] Embedding retrieval (in 1 projects): RAG not implemented.
- A1225 [missing/L] Vector retrieval and stores (in 1 projects): RAG not implemented.
- A1328 [missing/L] Vector-store RAG example (in 1 projects): Vector-store adapters (ChromaDB/Qdrant); Branch has no embedding backend.
- A1363 [missing/L] Vector-store retrieval agents (in 1 projects): Document retrieval and multi-agent RAG requires embedding support.
- A1373 [missing/L] Vector and keyword retrieval (in 1 projects): Vector and keyword retrieval requires embedding infrastructure.
- A1670 [missing/L] User-document vector retrieval (in 1 projects): User-document vector retrieval requires embedding infrastructure.
- [x] A1921 Vector database adapters — not applicable: adapters for hosted vector services (Qdrant, Chroma, Pinecone, Weaviate and the like). Nobody running Branch on their own computer runs one beside it, an adapter could not be tested here without a network, and each is a new dependency for a service the owner does not have. Built instead: the `VectorBackend` contract, a second real place for the vectors on this machine (a database file the owner names, src/vector-store-file.ts), and a complete worked adapter in docs/configuration.md; tests/retrieval-2.test.mjs
- A1975 [missing/L] Long-term vector memory (in 1 projects): Long-term vector memory requires embeddings and lexical search; no embedding service.
- [x] A2363 Vector database retrieval — not applicable: adapters for hosted vector services (Qdrant, Chroma, Pinecone, Weaviate and the like). Nobody running Branch on their own computer runs one beside it, an adapter could not be tested here without a network, and each is a new dependency for a service the owner does not have. Built instead: the `VectorBackend` contract, a second real place for the vectors on this machine (a database file the owner names, src/vector-store-file.ts), and a complete worked adapter in docs/configuration.md; tests/retrieval-2.test.mjs

## media-generation — 13 pieces (20 rows) {'S': 5, 'M': 13, 'L': 2}

- [x] FAMILY media-input (2 rows): Image input, Image prompt input — done (0.14.0): src/media-images.ts image parts on the composer; tests/media.test.mjs
- [x] FAMILY multimodal-input (2 rows): Multimodal agent inputs, Multimodal message parts — done (0.14.0): image, audio and video parts in src/media.ts; tests/media.test.mjs
- [ ] FAMILY media-gen (6 rows): Inline image generation, Multimodal media processing, Recording-to-video pipeline, Media understanding, Video generation, Image painting workspace — partial: pictures are made and edited and media is read; there is no video generation or painting workspace
- A1996 [missing/M] Image generation/display (in 1 projects): Image generation service integration not present.
- A2025 [partial/M] Rich-media handling (in 1 projects): Web fetch returns text only; no image/audio upload in UI.
- A2083 [missing/M] Image generation MCP server (in 1 projects): MCP support present but no image generation backend.
- A2106 [missing/S] Image loading (in 1 projects): Browser displays images but not as tool context input.
- A2174 [missing/M] Video processing and download (in 1 projects): No FFmpeg or yt-dlp integration.
- A2184 [missing/M] Vision API helper (in 1 projects): No screenshot/image understanding integration.
- A2265 [missing/L] OCR (in 1 projects): No Tesseract OCR integration.
- A2294 [missing/M] Media generation extension (in 1 projects): No bundled image/video generation.
- A2321 [missing/S] Image viewing (in 1 projects): Browser can display HTML but not as tool output display.
- A2368 [missing/S] DALL-E image generation (in 1 projects): No DALL-E image generation integration.

## desktop-automation — 15 pieces (18 rows) {'M': 8, 'L': 10}

- [x] FAMILY desktop-automation (4 rows): Desktop GUI operator, Screen capture and display selection, Cross-platform screenshot capture, Mouse control — done (0.14.0): src/integrations/desktop-tools.ts and computer.ts; tests/screen-control.test.mjs
- [x] FAMILY vision (1 rows): Screenshot-based perception — done (0.14.0): window photographs plus media.describe; tests/screen-control.test.mjs
- [ ] FAMILY capture (1 rows): Workflow recording — not done
- [x] FAMILY hardware (1 rows): Hardware peripheral tools — not applicable: GPIO and sensor peripherals
- A0230 [missing/L] Computer-use automation (in 4 projects): computer-use automation not implemented.
- A0032 [missing/M] App server protocol (in 1 projects): app server protocol not implemented.
- A0464 [missing/M] Persistent desktop chat sessions (in 1 projects): Desktop application not implemented.
- A0601 [missing/M] Codex app-server backend (in 1 projects): codex app-server backend not implemented.
- A1450 [partial/L] Computer use (in 1 projects): computer use has some implementation; specific features may be missing.
- A1696 [missing/M] Capture sessions (in 1 projects): No screen or interaction recording capability.
- A1697 [missing/M] Recording export (in 1 projects): No recording export for replay or analysis.
- A1775 [missing/L] macOS companion application (in 1 projects): macos companion application not implemented.
- A1776 [missing/L] iOS companion application (in 1 projects): ios companion application not implemented.
- A2043 [missing/L] Computer-use integration (in 1 projects): Computer-use integration not implemented.
- A2311 [partial/L] Computer-use subsystem (in 1 projects): Playwright browser present but not full desktop computer-use.

## skills-and-recipes — 17 pieces (17 rows) {'S': 8, 'M': 6, 'L': 3}

- [x] FAMILY rules-discovery (1 rows): Project and user rules — done (0.14.0): project instructions in src/projects.ts and src/identity.ts; tests/projects-locker.test.mjs
- [x] FAMILY skill-execution (1 rows): External executable skills — done (0.14.0): src/skill-http-tools.ts runs a skill's declared call; tests/skills-plugins.test.mjs
- [x] FAMILY playbook-system (1 rows): Playbook extensibility — done (0.14.0): src/recipes.ts with inputs and result shapes; tests/recipes.test.mjs
- [ ] FAMILY examples (1 rows): MCP example — not done
- [x] FAMILY domain-specific-api (1 rows): Python library API — not applicable: a Python library API; Branch is TypeScript
- [x] FAMILY sdks (1 rows): Skills and tool SDKs — done (0.14.0): packages/sdk client and src/skill-authoring.ts; tests/sdk-misc.test.mjs
- [x] FAMILY configuration (1 rows): Agent YAML specification — done (0.14.0): src/skill-document.ts YAML front matter; tests/skills-plugins.test.mjs
- A0147 [partial/S] Reusable workflows (in 1 projects): Branch procedures are reusable task sequences with parameters; no dedicated command/UI for browsing and loading them.
- A0468 [partial/S] Plan creation and approval (in 1 projects): Plans created as procedures with inputs/outputs; no explicit approval/rejection states.
- A0608 [partial/M] Self-evolving skills (in 1 projects): Skills stored in database and scanned; no autonomous creation or self-revision.
- A0728 [partial/S] Structured output (in 1 projects): resultSchema on procedures checked; limited JSON-Schema subset validation.
- A0776 [partial/S] Skill installation and removal (in 1 projects): Skills can be installed from registry; no AgentSkills.io-specific handling.
- A1827 [partial/M] Autonomous skill curation (in 1 projects): Skill governance proposes skills from runs; no autonomous creation.
- A1882 [partial/M] Prompt IDE (in 1 projects): Skill editing in web UI exists but not as a dedicated IDE like Dify.
- A2112 [partial/S] Self-evolving skill drafts (in 1 projects): Skill governance proposes drafts from runs; storage/retrieval implemented.
- A2341 [partial/M] Skills management (in 1 projects): Skills management via API and CLI; no import/export or git sync.
- A2374 [partial/S] Runtime skill installation (in 1 projects): Registry install/uninstall works; no runtime install output capture.

## models.routing-and-cost — 1 pieces (16 rows) {'?': 10, 'L': 2, 'M': 4}

- [x] FAMILY provider-adapter (16 rows): Multi-provider models, Multi-provider model support, Multiple LLM providers, Multiple hosted model providers, Multi-provider model catalog, LiteLLM multi-provider access, Multi-provider LLM abstraction, Multi-provider LLM facade, Model packs and multi-provider composition, Multi-provider model components, Multi-provider model adapters, Multi-provider model clients … — done (0.14.0): data/providers.json plus src/local-routing.ts profiles; tests/providers-2.test.mjs

## sandboxing-and-isolation — 15 pieces (15 rows) {'M': 10, 'S': 2, 'L': 3}

- A0018 [partial/M] Filesystem sandbox policies (in 1 projects): Workspace confinement enforced; no external sandbox selection.
- A0701 [missing/S] Post-write JSON validation (in 1 projects): JSON validation occurs at parse time, not after write operations.
- A0797 [missing/M] Code execution policy (in 1 projects): No policy controls code execution at runtime.
- A0875 [missing/L] PII detection guardrail (in 1 projects): No PII detection patterns or masking implemented.
- A0877 [missing/M] Moderation guardrail (in 1 projects): No OpenAI moderation API or content filtering integration.
- A0962 [partial/M] Input/output/tool guardrails (in 1 projects): Content guard for injection detection; not comprehensive guardrail suite.
- A1413 [partial/M] Allowed-domain navigation restrictions (in 1 projects): Browser allowlist in config; enforcement not validated.
- A1520 [missing/M] Code-block sandboxing (in 1 projects): No code-block validation before execution.
- A1618 [partial/S] Firewall settings (in 1 projects): Network policy config exists; no firewall UI exposed.
- A1770 [missing/M] Reusable authenticated browser state (in 1 projects): Fresh browser profile per session; no cookie export.
- A2028 [missing/M] Per-session rate limiting (in 1 projects): No per-session rate limiting.
- A2131 [missing/L] E2B/local code sandbox (in 1 projects): No sandbox isolation for code execution.
- A2152 [missing/M] Docker isolation (in 1 projects): Docker isolation not part of local Windows desktop design.
- A2160 [missing/L] Sandboxed code execution (in 1 projects): Shell is not sandboxed; no Docker/nsjail/E2B backend.
- A2277 [missing/M] Tool sandbox policy (in 1 projects): No per-mode sandbox restrictions.

## file-and-code-tools — 10 pieces (13 rows) {'M': 9, 'L': 1, 'S': 3}

- [x] FAMILY tooling (1 rows): File search and editing bundles — done (0.14.0): files and code toolboxes in src/catalog.ts; tests/catalog-diet.test.mjs
- [x] FAMILY file-editing (3 rows): Multi-file code editing, File editing and patching, Validated file editing — done (0.14.0): src/patch.ts and src/code-change.ts, all or nothing; tests/orchestration-2.test.mjs
- [x] FAMILY editing-features (2 rows): Undo and redo, File checkpoints — done (0.14.0): src/workspace-history.ts undo, redo and checkpoints; tests/code-ide.test.mjs
- [x] FAMILY file-operations (1 rows): Path management — done (0.14.0): files.list, files.find and files.delete in src/files.ts; tests/code-tools.test.mjs
- [x] FAMILY agent-export (1 rows): Agent export/import — done (0.14.0): src/agent-export.ts writes and reads one file; tests/code-ide.test.mjs
- [x] FAMILY browser-automation (1 rows): Browser session and profile management — done (0.14.0): src/integrations/browser-profiles.ts; tests/browser-2.test.mjs
- [x] FAMILY portability (1 rows): Agent import and export — done (0.14.0): src/agent-export.ts and src/backup.ts; tests/code-ide.test.mjs
- A0537 [missing/L] Project maps and syntax validation (in 1 projects): No syntax-aware parsing or tree-sitter project maps; file tools are generic.
- A1183 [missing/M] Artifact services (in 1 projects): No versioned binary artifact storage; skills and procedures are text only.
- A2359 [partial/M] Code generation and improvement (in 1 projects): Model can generate code; no dedicated refinement tools.

## context-management — 11 pieces (11 rows) {'M': 3, 'L': 2, 'S': 6}

- [ ] FAMILY context-providers (1 rows): Custom context providers — partial: knowledge bases, documents and pinned notes feed the context; there is no custom provider interface
- [x] FAMILY schema-system (1 rows): Pydantic input/output schemas — done (0.14.0): Zod shapes for tools, recipes and delegated results; tests/recipes.test.mjs
- A0074 [partial/M] Thread summarization/compaction (in 1 projects): Context management partial.
- A0353 [partial/L] Repository-context completion (in 1 projects): RAG not implemented.
- A0857 [partial/S] Token budget cost governance (in 1 projects): Token tracking exists; cost estimates not exposed to user.
- A1269 [partial/S] Shared store (in 1 projects): Branch memory and context are shared across a run; not mutable shared state between nodes.
- A1640 [missing/M] No image task inputs (in 1 projects): No vision/image input support for user-provided image files.
- A2023 [partial/S] Context compression and truncation (in 1 projects): Context truncation via clipping implemented; LLM summarization-based compression exists.
- A2110 [missing/S] JSONL session persistence (in 1 projects): JSONL session persistence not implemented; SQLite storage only.
- A2269 [missing/S] Session summaries (in 1 projects): Session summarization for context not implemented; compaction uses LLM summary instead.
- A2379 [missing/S] Working session tracking (in 1 projects): Working session tracking via middleware context propagation not implemented.

## webhooks-and-triggers — 7 pieces (11 rows) {'M': 9, 'S': 1, 'L': 1}

- [x] FAMILY webhooks (5 rows): Webhook/event triggers, GitHub-triggered automations, Webhook execution, Workflow webhook delivery, Webhook ingress — done (0.14.0): src/triggers.ts and src/webhooks.ts, signed both ways; tests/triggers-webhooks.test.mjs
- [x] FAMILY hook-system (1 rows): Lifecycle hooks — done (0.14.0): src/hooks.ts lifecycle hooks; tests/guardrails.test.mjs
- [x] FAMILY web-access (1 rows): HTTP requests — done (0.14.0): web.fetch in src/integrations/web.ts under the network rules; tests/web-pin-hygiene.test.mjs
- [x] FAMILY research-pipeline (1 rows): Autonomous web research — done (0.14.0): src/research.ts multi-page run with citations; tests/data-research.test.mjs
- [x] FAMILY api-tools (1 rows): Custom API tools — done (0.14.0): src/openapi-tools.ts builds tools from a description; tests/code-ide.test.mjs
- A1838 [missing/M] Outbound webhooks (in 2 projects): No outbound webhook delivery for agent events to external endpoints.
- A1816 [partial/M] Webhook and hook triggers (in 1 projects): Local event hooks (run.finished, tool.completed, file.changed) exist; no external webhook triggers.

## git-integration — 9 pieces (11 rows) {'L': 2, 'M': 7, 'S': 2}

- [x] FAMILY git-integration (3 rows): GitHub and GitLab integrations, Git integration, GitHub repository publishing — done (0.14.0): src/integrations/git.ts, github.ts and gitlab.ts; tests/code-ide.test.mjs
- [ ] FAMILY integrations (1 rows): GitHub App integration — not done
- [x] FAMILY github-integration (1 rows): GitHub repository actions — done (0.14.0): src/integrations/github.ts issues, checks, releases; tests/code-ide.test.mjs
- A0388 [partial/M] Pull requests (in 1 projects): shell.execute can run git, but no built-in PR creation or git push automation.
- A0393 [missing/M] GitHub (in 1 projects): github not implemented.
- A0435 [missing/S] Ignored-file access controls (in 1 projects): Fixed secret patterns; no .gitignore-style ignorefile.
- A0542 [partial/M] Plan branches and version history (in 1 projects): Recipes versioned in procedures table; no explicit plan-branch version history.
- A2317 [missing/L] Git-backed MemFS (in 1 projects): Git-backed memory filesystem not implemented; SQLite-only storage.
- A2333 [missing/M] Git worktree tools (in 1 projects): No Git worktree isolation.

## app-integrations — 10 pieces (10 rows) {'L': 7, 'S': 3}

- [x] FAMILY openai-compat (1 rows): OpenAPI/HTTP service — done (0.14.0): src/openai-compat.ts endpoint; tests/interop.test.mjs
- [x] FAMILY openapi-plugins (1 rows): OpenAPI plugins — done (0.14.0): src/openapi.ts and src/openapi-tools.ts; tests/code-ide.test.mjs
- [ ] FAMILY examples (1 rows): Notion MCP example — not done
- [x] FAMILY openclaw-integration (1 rows): OpenClaw integration — not applicable: a different product's own integration
- [ ] FAMILY integration-blocks (1 rows): Third-party application blocks — partial: GitHub, GitLab and Linear are built in; there is no third-party block catalogue
- A0008 [missing/L] Language-server integration (in 1 projects): No language-server protocol integration or LSP client found.
- A0612 [missing/L] Cursor-based source synchronization (in 1 projects): No data ingestion pipelines for Telegram, Gmail or GitHub.
- A1895 [missing/L] Image generation API (in 1 projects): No image generation; model is text-only.
- A2221 [missing/L] Hindsight memory integration (in 1 projects): Hindsight memory integration requires external service connection; not implemented.
- A2353 [partial/S] REST API service (in 1 projects): HTTP REST API exists but not Python-specific.

## codebase-search — 4 pieces (9 rows) {'M': 6, 'L': 2, 'S': 1}

- [x] FAMILY workspace-search (2 rows): Fuzzy repository file-path search, Project grep and path search — done (0.14.0): files.find puts the closest names first; tests/code-tools.test.mjs
- [x] FAMILY codebase-search (5 rows): Repository search, Codebase search, Code search, Workspace grep, File grep and glob — done (0.14.0): files.grep and files.glob in src/code-search.ts; tests/code-tools.test.mjs
- [x] FAMILY codebase-indexing (1 rows): Repository map — done (0.14.0): src/code-map.ts request-ordered map; tests/code-ide.test.mjs
- A2128 [partial/M] Deep research workflow (in 1 projects): Web tools exist but no dedicated research coordinator.

## mobile-and-remote-access — 9 pieces (9 rows) {'L': 6, 'M': 3}

- A0329 [missing/L] Native SSH transport (in 1 projects): SSH transport protocol not implemented; shell.execute handles local commands only.
- A0544 [missing/M] Git-aware apply workflow (in 1 projects): File writes bypass git stash; no conflict detection or git-aware apply workflow.
- A0648 [missing/L] SSH node operations (in 1 projects): SSH nodes and constrained service operations not implemented.
- A1582 [partial/M] Git workspaces (in 1 projects): Procedures versioned; no explicit git workspace branch/snapshot API.
- A1699 [missing/L] Mobile support (in 1 projects): mobile support not implemented.
- A1777 [missing/L] Android companion application (in 1 projects): Android native companion app not implemented.
- A2080 [missing/L] Companion mobile client (in 1 projects): Mobile client (iOS/Android native) not implemented.
- A2213 [partial/M] Web and mobile-responsive UI (in 1 projects): Web UI exists but not mobile-responsive.
- A2279 [missing/L] Remote SSH workspaces (in 1 projects): No SSH-based remote workspace transport.

## data-and-analytics — 8 pieces (8 rows) {'M': 4, 'L': 1, 'S': 3}

- [x] FAMILY cost-tracking (1 rows): Run and block cost tracking — done (0.14.0): src/pricing.ts and per-run receipts; tests/cost-trace.test.mjs
- [x] FAMILY cost-accounting (1 rows): Token usage and cost accounting — done (0.14.0): src/usage.ts carries money as well as tokens; tests/cost-trace.test.mjs
- [x] FAMILY usage-response (1 rows): Usage and token accounting — done (0.14.0): src/usage.ts reported tokens per run; tests/usage.test.mjs
- [x] FAMILY telemetry-collection (1 rows): Anonymous telemetry — not applicable: Branch collects nothing; the promise is written where the owner reads it
- [x] FAMILY message-costing (1 rows): Per-message cost accounting — done (0.14.0): cost per round in src/usage.ts; tests/cost-trace.test.mjs
- [x] FAMILY usage-stats (1 rows): Usage statistics — done (0.14.0): src/metrics.ts and the usage screen; tests/usage.test.mjs
- A0504 [missing/M] Consent-gated analytics collection (in 1 projects): No analytics or consent flow.
- A1082 [missing/L] Dataset and experiment management (in 1 projects): No datasets, experiment versioning or structured experiment evaluation (evaluation.ts is fixed suite only).

## scheduling-and-automation — 7 pieces (7 rows) {'M': 4, 'S': 1, 'L': 2}

- [x] FAMILY automation (1 rows): Scheduler tool — done (0.14.0): src/scheduler.ts with schedules.* tools; tests/automation.test.mjs
- A0632 [partial/M] Delegation scheduler (in 1 projects): Branch delegates tasks and aggregates results; no explicit scheduler tracking independent executions.
- A0697 [missing/M] Holiday-aware schedules (in 1 projects): Holiday calendar integration not implemented; schedules use cron only.
- A0862 [partial/M] Durable workflows (in 1 projects): Branch delegates and schedules; no explicit durable workflow step/state persistence.
- A1378 [missing/L] Queue and Redis-backed coordination (in 1 projects): No distributed queue or Redis coordination; local SQLite only.
- A1657 [missing/L] Background and cron jobs (in 1 projects): No Celery or distributed worker infrastructure; local scheduler only.
- A2073 [missing/M] Queued sessions (in 1 projects): No session queue; runs execute immediately or queue via follow-ups.

## multi-user-and-teams — 6 pieces (6 rows) {'L': 3, 'M': 3}

- [x] FAMILY multi-user (1 rows): Multi-user access boundaries — done (0.14.0): src/profiles.ts household profiles kept apart; tests/collab-workflows.test.mjs
- A0366 [partial/L] Team and group administration (in 1 projects): Branch does not support enterprise team/group administration schemas.
- A1901 [partial/M] Conversation sharing (in 1 projects): Conversations can be exported/imported; no URL-based sharing.
- A1999 [missing/M] Shared conversation links (in 1 projects): Shared conversation links require public endpoint and access control; not implemented.
- A2212 [partial/L] Shared sessions and forking (in 1 projects): Conversations can branch from history; no co-driving or live sharing.
- A2226 [missing/M] Project comments and labels (in 1 projects): No collaborative project comments or labels.

## research-pipeline — 4 pieces (6 rows) {'S': 5, 'M': 1}

- [x] FAMILY agent-specialist (3 rows): Research agent, Researcher agent, Multi-agent research workflow example — done (0.14.0): researcher style plus src/research.ts; tests/data-research.test.mjs
- A0742 [missing/S] Firecrawl web search (in 1 projects): Firecrawl web search not integrated; uses DuckDuckGo endpoint.
- A0743 [missing/S] Scrapling page fetch (in 1 projects): Scrapling page fetch not integrated; uses playwright-based fetching.
- A0931 [missing/M] Experimental citations and document types (in 1 projects): No citation normalization or citation-aware output rendering.

## ide-and-editor — 3 pieces (3 rows) {'L': 3}

- [x] FAMILY ide-integrations (1 rows): IDE integrations — done (0.14.0): src/acp.ts speaks to an editor; tests/interop-agents.test.mjs
- [ ] FAMILY claude-integration (1 rows): Claude Code plugin — not done
- A0192 [missing/L] Debug Adapter Protocol operations (in 1 projects): No Debug Adapter Protocol implementation.
