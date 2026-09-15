# Verification record

Date: 2026-09-15. Local platform: Windows x64, Node.js 24.15.0, Python 3.12.10. Packaged desktop: Electron 44.3.0 with Node.js 24.20.0.

## Application

The strict TypeScript build and 75 behavioral tests passed locally; one Windows short-name case was skipped because this local volume has no short-name aliases enabled. Tests cover tool loops, SQLite persistence, interrupted transcript repair, permissions, shared budgets, cancellation, specialist versions, procedure step traces, concurrent evaluation, schedules and graceful shutdown.

- OpenAI-compatible and Anthropic adapters use protocol fixtures; no paid provider account has been exercised by this record.
- Real Chromium tests verify forms, denied origins/redirects/password fields, overlapping run isolation, cancellation, resource limits and shutdown during pending launch.
- MCP tests use a real local stdio server and HTTP fixtures, including version/tool allowlists, credential handling and bounded responses.
- Streaming tests use real loopback HTTP SSE responses for text-before-completion, fragmented tool inputs, CR-only framing, token limits and cancellation. Received usage remains recorded on failed streams. Terminal tests verify Ctrl+C and revisions continue the same session after cleanup.
- The browser UI test sends a task, saves memory and checks mobile-width overflow, logo loading, actual acorn pixel changes, pause, keyboard rotation and reduced motion.
- The native desktop test executes a task, checks renderer isolation and token non-exposure, attempts navigation to an unapproved local server, tests popup rejection, persists appearance across process restart, hides to tray, follows the home link and verifies shutdown closes the process and listener.
- Desktop connection tests save a synthetic API key with actual Windows device protection, reject another native window at the IPC boundary, restart into a local fixture provider, and recover from damaged JSON, keys and endpoints.
- A raw TCP preconnection regression verifies quit cannot hang on speculative browser connections after runtime work is drained.
- The generated Windows executable has been run through all four native desktop/settings tests, including its bundled logo, acorn, preload and provider configuration. Package contents contain runtime/public files, production dependencies and license notices; private state and workspace are excluded.

Re-run `npm test` for the current tree. Review findings produced additional regression cases; an earlier passing suite did not cover all of those failures. CI is configured for Windows and must independently pass on the pushed revision.

## Experiments

All 16 standard-library Python tests passed. They check accounting of failures, retries and learning costs, matched held-out comparisons, incomplete accounting rejection, and model-adapter provenance/output preservation. Synthetic fixture comparisons do not establish live model savings.

A separate full-graph stimulus-response run completed with 127,400 simulated neurons and 14,687,178 connections. Source revision: `c976c7a90b2ac5a472c028b5862974217e93573f`. Seed: 42. Duration: 100 ms per condition. Brian2: 2.10.1.

| Stimulation | Spikes | Active neurons | Spikes outside stimulated neurons |
| --- | ---: | ---: | ---: |
| 0 Hz | 0 | 0 | 0 |
| 100 Hz | 849 | 245 | 643 |

No reset correction was applied. The run used zero language-model tokens but consumed local simulation compute. It did not include plasticity, a simulated body, an assistant task or a learning benefit. External model code/data and detailed run artifacts remain outside the application distribution. See [experiments.md](experiments.md) for reproduction requirements.

## Completion boundary

The 169-entry inventory currently has 9 implemented entries, 58 partial, 1 external and 101 missing. These are individual acceptance criteria, not a release-completeness percentage. The broad project objective is not complete.

Outstanding work includes remaining capability families, actual configured-service checks, broader failure scenarios, supported-platform packaging, installers/signing/updates, and measured learning/efficiency comparisons. No AGI, sentience or complete feature-parity claim is supported by these checks.
