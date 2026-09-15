# Feature coverage

This inventory preserves 169 researched acceptance requirements. It is a development checklist, not a claim that all listed features are implemented.

The source/fixture audit recorded 19 implemented, 53 partial, 1 external and 96 missing entries. A passing local fixture does not establish configured external-service readiness. Refresh individual entries after implementation and verification.

Machine-readable criteria, source paths, test names and remaining work are in [features.json](features.json).

## Surfaces

| Feature | Status | Remaining acceptance work |
| --- | --- | --- |
| Browser chat and settings (`surfaces.web`) | implemented | Covered by the listed local fixtures. |
| Interactive terminal with streaming and interruption (`surfaces.terminal`) | implemented | Covered by the listed local fixtures. |
| Desktop and menu-bar clients (`surfaces.desktop`) | implemented | Covered by the listed local fixtures. |
| Voice dictation and transcription (`surfaces.voice-input`) | missing | Submit an audio fixture and produce a readable transcript that can be sent as a conversation turn. |
| Text-to-speech (`surfaces.voice-output`) | missing | Generate playable speech from a response using the selected provider. |
| Images audio video and document attachments (`surfaces.attachments`) | missing | Attach representative image, audio, video and document files and preserve their content types and accessible references in the conversation. |
| Image and video generation (`surfaces.generation`) | missing | Generate one image and one video through configured adapters and verify that both output files can be decoded. |
| Inline media playback (`surfaces.playback`) | missing | Play an attached audio file and video file inside the supported conversation client. |
| Grouped side-by-side conversations (`surfaces.panes`) | missing | Arrange multiple topics side by side and verify that messages remain assigned to the correct topic. |
| Mobile installable web app and push notifications (`surfaces.mobile-push`) | missing | Install the supported mobile web app and receive a push notification for a completed task when the app is backgrounded. |
| Localized application interface (`surfaces.i18n`) | missing | Switch between two supported interface languages and verify that navigation and task controls remain usable. |
| Background task attention notifications (`surfaces.attention`) | partial | Implement pending-user-input task state and background notification linked to the exact task. |
| Personal knowledge access from note editors (`surfaces.editor-clients`) | missing | Query indexed personal knowledge from a supported note-editor client and open the cited document. |

## Routing

| Feature | Status | Remaining acceptance work |
| --- | --- | --- |
| Direct and group chat adapters (`routing.channels`) | missing | Receive and reply to a direct message and a group message through configured channel adapters. |
| Mention activation and engagement policies (`routing.activation`) | missing | Ignore a non-triggering group message and respond when the configured mention or engagement rule matches. |
| Sender allowlists and pairing (`routing.pairing`) | missing | Reject an unknown sender and accept that sender only after the configured pairing or allowlist process completes. |
| Conversation spanning channels (`routing.shared-session`) | missing | Continue one conversation from two linked channels with both surfaces observing the same ordered history. |
| Shared agent identity with separate conversations (`routing.shared-identity`) | partial | Demonstrate two distinct sessions explicitly recalling the same permitted memory while keeping histories separate. |
| Separate memory and workspaces across audiences (`routing.isolated-agents`) | partial | Provide per-agent file roots and prove file plus memory isolation between isolated agents. |
| Search resume duplicate import and export sessions (`routing.lifecycle`) | implemented | Covered by the listed local fixtures. |
| Temporary chats excluded from history and memory (`routing.temporary`) | missing | Close a temporary chat and verify that its messages do not enter persisted topic history or long-term memory. |
| Branch a conversation from a selected prior state (`routing.branch`) | implemented | Covered by the listed local fixtures. |

## Models

| Feature | Status | Remaining acceptance work |
| --- | --- | --- |
| Hosted and local model endpoints (`models.hosted-local`) | external | Configure actual hosted and local model endpoints and complete the same fixture on both. |
| API-key and supported OAuth routes (`models.oauth`) | partial | Implement and verify a supported OAuth authentication route alongside the API-key route. |
| Model and provider presets (`models.presets`) | missing | Select two named model presets and verify that each task uses the selected provider and model. |
| Bounded retries preserving completed work (`models.retry`) | implemented | Covered by the listed local fixtures. |
| Auth rotation cooldowns and model fallback (`models.fallback`) | missing | Inject an eligible provider failure and verify the configured cooldown and fallback order. |
| Respect explicit selected-model policy (`models.strict-choice`) | implemented | Covered by the listed local fixtures. |
| Live switching with visible fallback notices (`models.switching`) | missing | Switch the active model and expose the actual model used on the next turn. |
| Hardware-aware local model acquisition (`models.local-download`) | missing | Recommend a model for measured hardware, download it with progress and run a local prompt without a cloud endpoint. |
| Per-session reasoning effort controls (`models.reasoning-default`) | missing | Set a default reasoning effort and override it for one session while preserving the default for a new session. |

## Execution

| Feature | Status | Remaining acceptance work |
| --- | --- | --- |
| File editing and shell execution (`execution.files-shell`) | implemented | Covered by the listed local fixtures. |
| Web search and fetch (`execution.web`) | missing | Search for a query and fetch a selected page with readable content and its source URL. |
| Browser automation screenshots and persistent sessions (`execution.browser`) | partial | Add actual screenshot output and a multi-page fixture proving same authorized browser session across pages. |
| Live shared Linux desktop (`execution.desktop`) | missing | Operate a desktop-only test application and allow the user to take over the same live desktop. |
| DOM inspection and element-attached comments (`execution.annotations`) | missing | Attach a comment to a DOM element and include the element identity and inspection context in the resulting task. |
| Host file browser and command bridge (`execution.host-bridge`) | missing | Perform an authorized operation on an explicitly selected host and return the host identity with its result. |
| SSH and serverless execution adapters (`execution.remote`) | missing | Run the same bounded command through configured SSH and serverless adapters and record the execution target. |
| Paired camera screen location and notification commands (`execution.nodes`) | missing | Pair a device, discover its granted commands and execute a permitted device command while rejecting an unavailable one. |
| MQTT and embedded hardware integrations (`execution.hardware`) | missing | Exchange an MQTT fixture and exercise declared serial, GPIO, I2C or SPI adapters against device fixtures while reporting unsupported protocols or disconnects explicitly. |

## Extensions

| Feature | Status | Remaining acceptance work |
| --- | --- | --- |
| Progressive skill loading (`extensions.progressive`) | missing | Expose only skill metadata initially and load full instructions only when that skill is selected. |
| Skill creation editing installation and curation (`extensions.authoring`) | partial | Implement skill install/remove and full metadata/revision authoring lifecycle. |
| Pin a procedure to active chat (`extensions.pinning`) | missing | Pin a skill to a chat and verify that subsequent turns retain the selected procedure until unpinned. |
| MCP servers and tool selection (`extensions.mcp`) | implemented | Operational use requires a configured trusted server; fixture coverage does not establish every server or tool capability. |
| Plugin and channel adapter registry (`extensions.registry`) | missing | Install a chosen plugin from a declared registry and verify that its capabilities appear only after activation. |
| Agent templates without secrets (`extensions.templates`) | partial | Provide a template creation/import flow and a test that instructions/tool requirements transfer without secrets. |
| Parameterized recipes and requirements (`extensions.recipes`) | partial | Add parameter definitions, required-input binding and invalid-input rejection before recipe execution. |
| JSON Schema outputs (`extensions.structured`) | partial | Validate recipe result against a declared JSON Schema and reject a nonconforming fixture. |
| Generate capability-limited WASM tools (`extensions.tool-building`) | missing | Build a requested WASM tool and execute it with only declared host capabilities. |
| Lifecycle event hooks with failure isolation (`extensions.lifecycle-hooks`) | missing | Invoke a registered lifecycle hook and disable or isolate it after the configured repeated-failure threshold. |
| Connect external hosted agent platforms (`extensions.platform-bridge`) | missing | Invoke a configured external agent-platform workflow and return its correlated result through the assistant. |
| Visual branching workflow editor (`extensions.visual-workflows`) | missing | Build a workflow with connected blocks and a conditional branch, save it and execute the selected branch. |

## Memory

| Feature | Status | Remaining acceptance work |
| --- | --- | --- |
| Editable user profile and assistant identity (`memory.profile`) | implemented | Covered by the listed local fixtures. |
| Bounded durable facts (`memory.facts`) | implemented | Covered by the listed local fixtures. |
| Full-text prior-session retrieval (`memory.search`) | implemented | Covered by the listed local fixtures. |
| Vector plus full-text rank fusion (`memory.hybrid`) | missing | Retrieve relevant seeded memories through both lexical and semantic matching with inspectable ranking. |
| External memory provider support (`memory.providers`) | missing | Replace the memory backend through configuration and verify that read and write operations use the selected backend. |
| Explicit agent and project memory boundaries (`memory.scope`) | partial | Add explicitly shared scopes and demonstrate eligible queries across agent/private/shared scopes. |
| Source lineage and admission controls (`memory.lineage`) | partial | Add session admission/denial policy and automatic-ingestion exclusion fixtures. |
| Preview removal of tracked derived memory (`memory.forget`) | partial | Implement session-derived deletion preview, exclusions, and durable suppression of automatic re-ingestion. |
| Semantic retrieval over personal document formats (`memory.documents`) | missing | Index PDF, Markdown, Word, org-mode, image and supported connected-note fixtures and return source-linked answers to their contents. |
| Automatic archival and expiry of stale memory (`memory.hygiene`) | missing | Apply a configured retention policy to seeded stale memories and report which entries were archived or purged. |
| Export and restore complete memory state (`memory.export-import`) | implemented | Covered by the listed local fixtures. |
| Time-aware entity and relationship memory (`memory.temporal-graph`) | missing | Store changing facts about an entity and answer a time-qualified query using the fact valid at that time. |
| Editable linked knowledge pages (`memory.linked-wiki`) | missing | Create related knowledge pages, follow their links and preserve a user correction in subsequent retrieval. |
| Shared memory through independent host adapters (`memory.cross-agent`) | missing | Ingest a supported host's session log and retrieve its permitted memory through a second host adapter. |
| Locally searchable email calendar and message datasets (`memory.connector-datasets`) | missing | Synchronize configured email, CalDAV and messaging fixtures and search their local projections with source identifiers. |

## Learning

| Feature | Status | Remaining acceptance work |
| --- | --- | --- |
| Context compaction preserving task handoff (`learning.compaction`) | missing | Compact an oversized conversation while preserving recent turns and the active task handoff. |
| Scheduled consolidation from append-only history (`learning.dream`) | missing | Process only new archive entries during scheduled consolidation and advance the consumption cursor after success. |
| Versioned durable memory (`learning.versioning`) | partial | Version and restore durable-memory content itself. |
| Post-task memory and skill review (`learning.review`) | missing | Run a post-task review that can propose a memory or skill change with a link to the originating task. |
| Pending memory write review (`learning.approval`) | missing | Stage a memory write when review is enabled and apply it only after acceptance. |
| Inspect edit prune and archive learning (`learning.journey`) | partial | Complete learning-view edit/remove/archive operations for memories and skills. |
| Bounded session-start memory snapshots (`learning.cache`) | missing | Keep the injected memory snapshot stable within a session and refresh it at the next session boundary. |
| Automatic recovery point before memory or skill edits (`learning.pre-edit-checkpoint`) | partial | Create and restore exact pre-mutation memory/skill checkpoints with acceptance fixtures. |
| Evidence-governed skill lifecycle and rollback (`learning.governance`) | partial | Add skill degradation policy based on eligible recorded evidence and prove complete skill governance semantics. |
| Optimize skill candidates from recorded traces (`learning.trace-optimization`) | missing | Generate a skill candidate from trace data and retain both candidate and original for comparison. |
| Compare skill versions on reproducible evaluation tasks (`learning.skill-benchmark`) | partial | Add a runner executing baseline/candidate skills against identical fixtures and seeds and persisting per-task outcomes/costs. |
| Environment-specific skill failure avoidance (`learning.failure-aware`) | missing | Exclude a skill with an active matching failure pattern and record the reason and allowed recovery trial. |

## Delegation

| Feature | Status | Remaining acceptance work |
| --- | --- | --- |
| Focused child agents (`delegation.children`) | implemented | External model behavior remains configuration-dependent; local fixture establishes child/result isolation only. |
| Sequential and parallel tasks (`delegation.parallel`) | partial | Add explicit concurrent child orchestration and dependent-sequence acceptance fixtures. |
| Restrict child tool access (`delegation.tools`) | partial | Add a focused child fixture granted exactly one extension that succeeds on that extension and attempts/rejects a tool outside its grant. Current tests cover the components separately. |
| Depth concurrency timeout and turn bounds (`delegation.limits`) | partial | Enforce configured child concurrency and configurable depth/timeouts; test a child exceeding its timeout. |
| Structured child result contracts (`delegation.results`) | missing | Validate a child result against its requested schema and report an invalid result as unresolved. |
| Queue follow-ups while tasks run (`delegation.steering`) | partial | Implement queued follow-ups to an active session while another session continues. |
| Cascading child cancellation (`delegation.cancellation`) | partial | Exercise cancellation through a running parent, child and grandchild chain. |
| Preserve critical child results after parent finishes (`delegation.orphans`) | missing | Allow an explicitly critical child to finish after graceful parent completion and retain its result for delivery. |
| Persistent specialist roles and team rooms (`delegation.persistent-teams`) | partial | Add durable team membership/roles and shared room history with restart fixture. |
| Route task chains and fan-out across named teammates (`delegation.handoff`) | missing | Hand a task through a named agent chain and merge independent fan-out results under the original task. |

## Automation

| Feature | Status | Remaining acceptance work |
| --- | --- | --- |
| Recurring timed tasks (`automation.cron`) | partial | Add configured timezone/calendar recurrence semantics and a timezone-aware due-time fixture. |
| Periodic proactive checks (`automation.heartbeat`) | partial | Verify a periodic monitoring routine carries prior observation state into subsequent checks. |
| Event and webhook routines (`automation.events`) | missing | Trigger a saved routine from an authenticated webhook or declared event with the triggering payload. |
| Local script triggers (`automation.local`) | partial | Add saved-automation selection/invocation from a local script with correlated run record. |
| Pause and resume with state (`automation.pause`) | implemented | Covered by the listed local fixtures. |
| Route results to chosen channels (`automation.delivery`) | missing | Deliver a completed scheduled result to the configured destination and record the destination identifier. |
| Inspectable run history (`automation.history`) | partial | Store per-schedule run history and distinguish all successful, failed and active runs over repeated executions. |
| Package requirements settings and dashboard metrics (`automation.metrics`) | missing | Load a task package and expose its required tools, configurable inputs and declared runtime metrics. |
| One-time scheduled work (`automation.once`) | implemented | Covered by the listed local fixtures. |

## Workspace

| Feature | Status | Remaining acceptance work |
| --- | --- | --- |
| Project files instructions repositories and presets (`workspace.projects`) | partial | Implement project switching across files, instructions, repository and model presets. |
| Project-scoped secrets and knowledge (`workspace.secrets`) | missing | Use a secret from the active project while rejecting access to another project's secret. |
| Live editable Markdown artifacts (`workspace.markdown`) | partial | Provide user editor and conflict-aware nonconflicting agent/user merge fixture. |
| Document spreadsheet and presentation cowork (`workspace.office`) | missing | Create and reopen a document, spreadsheet and presentation in the supported office integration. |
| Visible file diffs and artifacts (`workspace.diffs`) | missing | Show the actual before-and-after file diff and link the resulting artifact after an edit. |
| Workspace snapshots and revert (`workspace.snapshots`) | missing | Capture a workspace snapshot, modify a file and restore its exact previous bytes. |
| Explicit topic context sharing (`workspace.cross-topic`) | missing | Attach another topic as context and record which topic was accessed for the task. |
| Authenticated managed files with read-only sandbox mounts (`workspace.managed-files`) | missing | Upload a managed file and expose it to a task through a read-only mount that rejects writes. |
| Tasks assigned to agents and teams on a board (`workspace.task-board`) | missing | Create a task, assign it to an agent or team and move it through board stages with persisted state. |

## Security

| Feature | Status | Remaining acceptance work |
| --- | --- | --- |
| Approval and command policies (`security.permissions`) | implemented | Covered by the listed local fixtures. |
| Per-agent containers and mounts (`security.containers`) | missing | Execute in an agent container and prove unmounted host and other-agent paths are inaccessible. |
| Platform-specific OS sandboxes (`security.os`) | partial | Add actual supported OS sandbox backends and enforcement fixtures. |
| Capability-limited WASM (`security.wasm`) | missing | Run a WASM tool and reject a host operation absent from its capability manifest. |
| Host-side credential injection (`security.credentials`) | partial | Implement WASM execution with host-boundary credential injection and verify absence from WASM input/output. |
| Host/path allowlists and rate limits (`security.network`) | partial | Add path-specific policy and cover every outbound tool transport. |
| CPU memory and execution limits (`security.resources`) | partial | Enforce CPU/memory and hard execution-time limits that terminate noncooperative tool processes. |
| Encrypted credential store and hidden prompts (`security.secrets`) | implemented | Covered by the listed local fixtures. |
| Untrusted-output wrapping and detection (`security.content`) | partial | Add provenance envelopes and configured detection policy tested against injected instructions. |
| Execution audit and authenticated successful-call receipts (`security.audit`) | partial | Add verifiable successful-result receipts and detect modified results. |
| Passkey authentication for the assistant service (`security.passkeys`) | missing | Register a passkey and authenticate a fresh session while rejecting an invalid authentication attempt. |
| Block internal-network request forgery (`security.ssrf`) | missing | Reject tool HTTP requests resolving to disallowed loopback, private or link-local addresses. |
| Cross-origin WebSocket admission control (`security.origin`) | partial | Implement the WebSocket surface and test rejection/acceptance of upgrade origins. |
| Verify downloaded release provenance and hashes (`security.release-verification`) | missing | Verify an official artifact's attestation and checksum and reject a tampered copy. |
| End-to-end encrypted relay transport (`security.encrypted-relay`) | missing | Exchange a message through an enabled encrypted relay and verify that relay-visible payloads do not contain plaintext. |
| Pinned SSH host identity for remote execution (`security.host-pinning`) | missing | Execute against a recorded SSH host key and reject a connection whose host identity has changed. |
| Scan skills before activation (`security.skill-scanning`) | missing | Scan a skill containing a seeded hardcoded secret or exfiltration instruction and enforce the configured block or review policy before activation. |

## Interop

| Feature | Status | Remaining acceptance work |
| --- | --- | --- |
| OpenAI-compatible API (`interop.openai`) | missing | Complete a compatible conversation request through the exposed OpenAI-style endpoint. |
| Embedding SDK (`interop.sdk`) | implemented | Covered by the listed local fixtures. |
| REST WebSocket and SSE (`interop.streaming`) | partial | Expose and verify ordered activity over REST, WebSocket and SSE. |
| ACP integration (`interop.acp`) | missing | Complete a task through a supported ACP client or agent adapter using its documented subset. |
| Agent-to-agent surface (`interop.a2a`) | missing | Exchange a task and result with a compatible A2A peer using declared capabilities. |
| Remote tool skill and inference discovery (`interop.node-discovery`) | missing | Discover tools, skills and inference advertised by a node and identify their owning host. |
| Personal email calendar and task account connection (`interop.personal-connectors`) | missing | Connect a supported account and read permitted email, calendar and task data without exposing its credentials. |

## Operations

| Feature | Status | Remaining acceptance work |
| --- | --- | --- |
| Guided provider and channel setup (`operations.setup`) | partial | Provide onboarding with actual configured model and channel test calls. |
| Background gateway and foreground modes (`operations.daemon`) | partial | Add background-service launch independent of launcher and verify handling after launcher closure plus controlled stop. |
| Single-binary constrained deployment (`operations.portable`) | missing | Launch a packaged binary on a declared supported target and report measured gateway resource usage. |
| Serverless idle suspension (`operations.hibernation`) | missing | Suspend the configured serverless environment and resume an operation with its persisted workspace intact. |
| Status diagnostics and recovery (`operations.health`) | partial | Probe configured provider/adapters and identify a deliberately broken prerequisite with actionable health state. |
| Import configuration skills memories and sessions (`operations.migration`) | missing | Preview and import supported configuration, memory and skills while preserving original source state. |
| Preconfigured branded desktop distribution (`operations.distribution`) | missing | Build a distribution with selected branding, providers and extensions and verify those defaults on first launch. |
| Full application backup and restore (`operations.backup-restore`) | missing | Back up configured application state and restore it into a clean instance with sessions and configuration intact. |
| Manage reproducible agent sandbox lifecycle (`operations.sandbox-lifecycle`) | missing | Create, snapshot, stop and restore a configured agent sandbox while preserving its declared network and inference policies. |

## Packages

| Feature | Status | Remaining acceptance work |
| --- | --- | --- |
| Cited multi-source reports (`packages.research`) | missing | Produce a multi-source report whose cited links support the associated factual claims. |
| Change monitoring and knowledge graphs (`packages.monitoring`) | missing | Detect a seeded source change and retain the prior observation and resulting alert evidence. |
| Prospect discovery enrichment scoring and deduplication (`packages.leads`) | missing | Enrich and score a fixture prospect set and exclude duplicates in the exported results. |
| Forecasts and calibration (`packages.forecasting`) | missing | Store probabilistic forecasts and calculate a calibration score after recording outcomes. |
| Video clipping captions and thumbnails (`packages.clips`) | missing | Generate a playable short clip with captions and a thumbnail from a valid input video. |
| Content scheduling approval and metrics (`packages.social`) | missing | Prepare and schedule a social post while retaining it in the approval queue until authorized. |
| Multistep browser workflows (`packages.browser`) | partial | Add multi-step form acceptance and an explicit approval-pause/resume flow before protected actions. |
| Trajectory generation and compression (`packages.trajectories`) | missing | Generate a batch of tool trajectories and export a compressed representation preserving task and outcome links. |
| Spoken daily briefing from personal sources (`packages.morning-brief`) | missing | Generate and play a dated briefing from configured email, calendar, health and news fixtures with source links. |

## Reliability

| Feature | Status | Remaining acceptance work |
| --- | --- | --- |
| Streaming tool activity (`reliability.activity`) | partial | Stream actual in-progress tool activity to clients with terminal tool status. |
| Context tokens and cache metrics (`reliability.context`) | partial | Include supported cache-use metrics and per-round client display, marking absent cache metrics unavailable. |
| Visible compaction events (`reliability.compaction`) | missing | Emit a visible compaction event with task continuity preserved after context reduction. |
| Success checks and bounded retry handlers (`reliability.checks`) | partial | Enforce declared completion checks for general runs and bounded retries after failure. |
| Stuck-operation recovery (`reliability.stuck`) | partial | Detect a stalled operation and implement/test the configured recovery with recorded outcome. |
| Context-limit and truncation recovery (`reliability.overflow`) | partial | Implement bounded recovery for context overflow and truncated output. |
| Differentiate successful receipts from failed and blocked audit events (`reliability.proof`) | partial | Add receipt-bearing successes and forged-receipt rejection. |
| Resume work from provider-neutral safe checkpoints (`reliability.checkpoints`) | partial | Add durable execution cursor and continue after restart without replaying already-completed effects. |
| Reconcile interrupted writes before retry (`reliability.uncertain-effects`) | partial | Classify unknown-outcome writes and require recorded external-state reconciliation before an allowed repeat. |
| Durable ordered outbound delivery independent of task completion (`reliability.delivery-ledger`) | missing | Complete a task while its channel is unavailable and deliver queued chunks in order using stable idempotency keys after reconnect. |
| Transactional queue retries and dead-letter inspection (`reliability.dead-letter`) | missing | Exhaust a message's retry allowance, retain it in a visible dead-letter queue and allow an explicit retry. |
| Runtime-verified task exit criteria (`reliability.completion-contract`) | partial | Apply declared exit criteria to each delegated task outcome and report failed evidence to parent. |
| Measure task accuracy energy latency and cost (`reliability.evaluation`) | partial | Execute a fixed evaluation suite and record accuracy/latency/cost/energy availability from actual runs. |
| Export task traces and service metrics (`reliability.tracing`) | partial | Add trace/metric export to configured observability endpoints. |
| Live inventory of tools and configuration readiness (`reliability.capability-inventory`) | partial | Report actual configuration/readiness and update inventory when an adapter is disabled. |

## Collaboration

| Feature | Status | Remaining acceptance work |
| --- | --- | --- |
| Identity-signed shared collaboration events (`collaboration.signed-events`) | missing | Publish a collaboration event under a member identity and reject a modified event whose signature no longer verifies. |
| Persistent shared rooms for people and agents (`collaboration.rooms`) | missing | Add human and agent members to a private room and enforce membership on its history and artifacts. |
| Unified search over conversations workflow events and patches (`collaboration.unified-search`) | missing | Search one query across conversation, workflow and repository events and return source-linked results. |
| Comments anchored to a media frame (`collaboration.media-comments`) | missing | Attach a comment to a video timestamp and reopen the comment at the same media position. |
| Repository changes represented as shared events (`collaboration.git-events`) | missing | Publish a patch and its repository status as searchable signed events linked to the correct repository. |
