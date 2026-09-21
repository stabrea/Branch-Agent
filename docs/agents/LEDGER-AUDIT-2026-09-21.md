# Feature-ledger audit, 2026-09-21

`docs/features.json` lists 169 features: **95 implemented, 59 missing, 14 partial, 1 external**.
That leaves **74 not fully verified**: 73 rows whose implementation is open (sections A to C, 43%)
and one whose connector exists but has never been proved against a real service (section D). This
audit checks each of them against the tests that exist today, so the ones already built can be
proved and moved, and the rest can be built.

**How it was done:** every test title in `tests/` (4,227 titles in 370 files) was matched against
each row's acceptance criterion. That finds *candidates*; it does not prove anything. **No row moves in
`features.json` until a named test meets that row's exact criterion** — the same bar the implemented
rows carry (paths, test names, a sentence of detail). `features.json` itself is untouched here: Codex
holds it in open PRs and will say when it is free.

**Ownership** follows the split on the coordination board: Codex takes security, execution
isolation, operations and release; Claude takes the rest.

---

## A. Tests already exist — verify against the criterion, then move (31)

Each needs one check: does a named test do exactly what the criterion says? Where it does, the row
moves to `implemented` with that test as evidence. Where it falls short, the gap is written in
`remaining` and it moves to `partial`.

| Row | Criterion, short | Candidate evidence (test file: title) | Who |
|---|---|---|---|
| surfaces.voice-input | audio → readable transcript → a conversation turn | `live-voice`: L19 a person presses Dictate, sees the words appear; `p2-voice-ui`: dictation puts the words in the box | Claude |
| surfaces.i18n | switch between two languages, navigation and controls still work | 81 tests across 66 files read each screen in French; #152 routes the rest of the page scripts through the locale files | Claude |
| surfaces.editor-clients | query knowledge from a note editor, open the cited document | `asks-surfaces`: A2133 the Obsidian plugin asks Branch and puts the answer in the note; `obsidian` O1–O3 | Claude |
| execution.annotations | a comment on a DOM element reaches the task with the element's identity | `browser-annotations`: A2144 a note naming a conversation is queued there and reaches the next turn | Claude |
| execution.nodes | pair a device, discover granted commands, run one, refuse one it lacks | `devices`, `devices-socket`, `devices-adversarial`: capabilities per device, pairing, refusal by name | Codex |
| extensions.registry | install from a declared registry; capabilities appear only after activation | `add-ons`: a package is installed switched off, switched on, taken back out; `add-ons-review`: signed lists | Claude |
| security.wasm | run a WASM tool, refuse a host operation not in its manifest | `safety-extras-wasm`: what a module asks for is read before it runs; runs sealed through the gate | Codex |
| memory.providers | swap the memory backend by configuration | `learning-more`: R17-060 outside memory services, Mem0 and Honcho; `hidden-knobs`: R17-S13 | Claude |
| memory.documents | index PDF, Markdown, Word, org-mode, image, notes; answers carry the source | `docs-memory-2`: PDF with page markers, ODF, decks and sheets keep slide and sheet | Claude |
| memory.cross-agent | ingest another host's session log, retrieve it through a second adapter | `learning-more`: R17-057 preferences from Claude Code and Codex chats; `move-in`: Codex CLI | Claude |
| memory.connector-datasets | sync email, CalDAV and messaging fixtures; search them with source ids | `asks-integrations`: A0612 IMAP after the last UID; `personal-connectors`: R17-029/030 | Claude |
| interop.personal-connectors | connect an account, read email, calendar and tasks without showing credentials | `personal-connectors`: Calendar, Drive, Outlook through Microsoft Graph | Claude |
| models.local-download | recommend for the hardware, download with progress, run with no cloud | `local-models`, `local-oneclick`, `local-models-review` | Claude |
| security.passkeys | register a passkey, sign in with it, refuse a bad attempt | `people`: B19-15 registration and signature checked, B19-16 register then sign in, B19-23 | Codex |
| security.origin | refuse a WebSocket upgrade from a foreign origin, allow the app's | `devices-socket`: upgrades get the same checks; `deployment`: Host and Origin checks | Codex |
| reliability.tracing | export a correlated trace and a service metric | `auth-tracing-cli`: T1–T5 spans, OTLP logs tied to the trace, `branch trace` | Claude |
| reliability.uncertain-effects | an interrupted write with unknown outcome is reconciled before any repeat | `never-break-journal`, `core-regressions`: crash-interrupted batches reconciled once | Codex |
| reliability.evaluation | a fixed suite reporting accuracy, latency, cost, energy, unknowns marked | `evaluation-2`, `evaluation-3`; energy is the likely gap | Claude |
| packages.trajectories | a batch of trajectories exported compressed, with task and outcome links | `polish-observability`: D2 trajectories as JSON Lines against the documented shape | Claude |
| packages.monitoring | detect a seeded change, keep the prior observation and the alert | `data-research`: a watch notices a change; `automation`: previous result handed on | Claude |
| packages.research | a multi-source report whose citations support its claims | `asks`: research-pipeline — outlined, cited, led and tidied | Claude |
| packages.morning-brief | a dated, spoken briefing from email, calendar, health and news with links | `data-research`: the brief gathers, sends, and goes out on time; spoken and health are the likely gaps | Claude |
| workspace.task-board | a task assigned to an agent or team, moved through stages, persisted | `asks`: A0794 a project board; `flows-boards`: the shared board | Claude |
| workspace.office | create and reopen a document, spreadsheet and presentation | `docs-3`: D2 and D8 spreadsheets written and edited; `docs-memory-2`: decks read | Claude |
| interop.acp | a task completed through an ACP client using its subset | `interop-agents`: `branch acp-serve` speaks the protocol | Claude |
| interop.a2a | exchange a task and result with an A2A peer | `interop-agents`: the agent card is hidden until shared; `src/a2a-routes.ts` | Claude |
| extensions.visual-workflows | connected blocks and a conditional branch, saved and run | `flow-editor`: F1–F3; `flow-graph`: G tests; the conditional branch needs checking | Claude |
| operations.migration | preview and import configuration, memory and skills, keeping the source | `move-in`: Codex CLI prompts, config and skill folders | Claude |
| operations.daemon | background service, close the launcher, tasks still handled, controlled stop | `never-break-*`, `daemon-update`, `mac-followups` | Codex |
| delegation.persistent-teams | a team of specialists keeps roles and a shared room after restart | `trunks-*`, `p2-rooms`; lands with #151 | Codex |
| collaboration.rooms | persistent shared rooms for people and agents | `p2-rooms`, `p2-rooms-ui`, `trunks-rooms`; lands with #151 | Codex |

## B. Partly there — the ledger already says what is missing (9)

| Row | What is missing | Who |
|---|---|---|
| routing.isolated-agents | per-agent file roots, and proof of file plus memory isolation | Codex |
| execution.browser | real screenshots, and a multi-page fixture keeping one authorised session | Claude |
| security.os | real OS sandbox backends with enforcement fixtures on each platform | Codex |
| security.credentials | host-boundary credential injection for WASM, proven absent from its input and output | Codex |
| security.release-verification | a published, signed attestation beside the checksum | Codex |
| workspace.markdown | a user editor and a conflict-aware merge of user and agent edits | Claude |
| operations.distribution | branding, providers and extensions chosen for a build and seen on first launch (`install-boring` covers only the assistant file) | Codex |
| reliability.context | token and cache metrics per round, never invented (`web-ui` U4 covers the meter only) | Claude |
| packages.browser | a multistep form fixture that pauses before an approval-requiring action | Claude |

## C. Really missing — to build (33)

| Row | What to build | Who |
|---|---|---|
| surfaces.voice-output | speech from a response, through the chosen provider, played | Claude |
| surfaces.attachments | image, audio, video and document attached, types and references kept | Claude |
| surfaces.generation | one image and one video generated and decoded | Claude |
| surfaces.playback | an attached audio and video play in the conversation | Claude |
| surfaces.panes | topics side by side, messages staying in the right one | Claude |
| surfaces.mobile-push | installable phone web app, push for a finished task | Codex |
| routing.shared-session | one conversation continued from two linked channels, same ordered history | Claude |
| execution.desktop | a desktop-only app operated, and the person taking over the same desktop | Codex |
| execution.host-bridge | an authorised step on a chosen host, answered with the host's identity | Codex |
| execution.remote | the same command through SSH and serverless, with the target recorded | Codex |
| execution.hardware | MQTT plus serial, GPIO, I2C or SPI adapters against fixtures | Codex |
| extensions.tool-building | a requested WASM tool built and run with only declared capabilities | Codex |
| extensions.platform-bridge | an outside agent platform's workflow run, its result returned | Claude |
| memory.hybrid | lexical plus semantic retrieval with inspectable, fused ranking | Claude |
| memory.linked-wiki | linked knowledge pages, links followed, a correction kept | Claude |
| automation.metrics | a task package's required tools, inputs and runtime metrics shown | Claude |
| workspace.cross-topic | another topic attached as context, with the access recorded | Claude |
| workspace.managed-files | an uploaded file given to a task through a read-only mount | Codex |
| security.containers | a real per-agent container, unmounted paths unreachable | Codex |
| security.encrypted-relay | a relay that never sees plaintext | Codex |
| security.host-pinning | a recorded SSH host key, and a changed one refused | Codex |
| interop.node-discovery | tools, skills and inference a node advertises, with their host | Codex |
| operations.portable | a single packaged binary on a declared target, gateway resources measured | Codex |
| operations.hibernation | a serverless environment suspended and resumed with its workspace | Codex |
| operations.sandbox-lifecycle | a sandbox created, snapshotted, stopped and restored with its policies | Codex |
| packages.leads | prospects enriched, scored and deduplicated in the export | Claude |
| packages.forecasting | probabilistic forecasts stored and scored for calibration | Claude |
| packages.clips | a short clip with captions and a thumbnail from a video | Claude |
| packages.social | a post prepared and scheduled, held in the approval queue | Claude |
| collaboration.signed-events | identity-signed shared collaboration events | Codex |
| collaboration.unified-search | one search over conversations, workflow events and patches | Claude |
| collaboration.media-comments | a comment anchored to a frame of a video | Claude |
| collaboration.git-events | repository changes shown as shared events | Claude |

## D. Built, but not proved against a real service (1)

| Row | What proof is missing | Who |
|---|---|---|
| models.hosted-local | The adapters accept a hosted HTTPS endpoint and a local loopback one, but today's fixtures only emulate the protocols. Complete the same fixture through a real configured hosted endpoint and a real local one (for example Ollama on this computer). | Codex |

**Totals:** 74 not fully verified: 31 with existing tests to verify, 9 partial, 33 to build, 1
external still to prove. Of the 33, 18 are Claude's and
15 are Codex's. Some rows in A will fall back to B once checked word for word against the criterion;
this table does not claim otherwise.
