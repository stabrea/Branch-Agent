# Wave 4 task: local models that just work

Rules: docs/agents/briefs/wave1/BUILD.md. Branch: wave4/local-models from the local branch wave2/integration. Themes: models.local-runtimes (#71), models.routing-and-cost leftovers (#79), inventory item "Models: local model download" (#4). Backend plus the existing Model settings card (additive).

Read: src/providers/presets.ts, src/providers.ts, src/models*.ts, src/server.ts provider routes (`/api/providers/local`), src/pricing.ts, docs/configuration.md model sections, tests/provider-presets.test.mjs.

Build:
1. Ollama management through its local API (no dependency): list installed models, pull a model with progress events (`model.download.progress`), delete, show model details (size, family, context length), detect whether Ollama is installed and offer the download link if not; the same for LM Studio where its API allows (list/load). Route family `/api/local-models/*`; a Settings card "Models on this computer" with a picker of recommended models by machine size (RAM detection via os.totalmem) and a progress bar.
2. Hardware-aware recommendations: read RAM, CPU cores and, when present, GPU name/VRAM (via `powershell Get-CimInstance Win32_VideoController` once, cached) and recommend small/medium/large local models with plain-language expectations ("fast, good for notes"; "slower, better at reasoning").
3. Routing rules: per-task routing preferences (`settings/routing`): "use a local model for private tasks", "use the cloud model for hard tasks", a simple classifier (length, tool needs, presence of personal data flagged by the PII guard if present) that picks a preset; fallback chain when a local server is down; cost-aware choice using the pricing table (prefer free local when the estimated cost exceeds a threshold and the task is simple).
4. Embeddings and vision locally: use Ollama's `/api/embeddings` for the documents and memory embedding accessor when the active preset is local; expose `supportsImages` for local vision models (llava family).
5. Health: the health report gains a local-runtime section (running, models, last error) and the context pane's model block shows "local" plainly.

Tests (tests/local-models.test.mjs): fake Ollama server: list/pull with progress/delete; recommendation by fake hardware numbers; routing picks local for a private short task and cloud for a long tool-heavy one; fallback when the local server is down; local embeddings feed documents search; health section.

Acceptance: L1 pull with progress proven; L2 recommendations by hardware proven; L3 routing rules proven; L4 local embeddings proven; L5 docs section; L6 no new dependency. Report the ids you consider done (models.local-runtimes and models.routing-and-cost sections).
