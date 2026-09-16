# Wave 4 task: talking to other agents (A2A and ACP)

Rules: docs/agents/briefs/wave1/BUILD.md. Branch: wave4/interop from the local branch wave2/integration. Theme: agent-interop (#67, 15 pieces; families acp-support and a2a-interop), plus inventory "Interop" (#13). Backend only.

Read: src/mcp-server.ts and src/mcp-stdio.ts (transport patterns), src/openai-compat.ts, src/server.ts (auth, rawApi, upgrade handling), src/ws.ts, src/teams.ts, src/network-policy.ts, docs/configuration.md interop sections.

Build:
1. A2A (Agent-to-Agent protocol) server: publish an Agent Card at `/.well-known/agent.json` (name, description, skills from the catalog the owner chose to share, auth scheme = bearer), implement `tasks/send`, `tasks/sendSubscribe` (SSE), `tasks/get`, `tasks/cancel` over JSON-RPC at `/a2a`, mapping tasks to runs (source "a2a"), artifacts to run outputs, and the owner's exposure policy (reuse the MCP sharing settings, extended with an "A2A" switch). Streaming via the existing run event stream.
2. A2A client: `agents.remote { action: add|list|remove }` to register another agent by its card URL (under the network policy), and a tool `agents.ask { agent, task }` that sends a task and waits (with timeout and budget) so a specialist can delegate to an outside agent; results are recorded with receipts and shown in the context pane through activity.
3. ACP (Agent Client Protocol as used by editors) server over stdio: `branch acp-serve` implementing initialize, session/new, session/prompt with streamed updates, permission requests routed to the approval policy, and cancel; documented config for Zed/other ACP clients.
4. Discovery on the local network (opt-in): mDNS is NOT allowed (no dependency); instead a simple `GET /api/agents/discover` that probes a list of hosts/ports the owner enters, plus a QR/URL the owner can share with another Branch install to add each other as remote agents (pairing code, same pattern as channels).
5. Interop safety: remote agents never receive secrets or file contents beyond the task text and explicitly attached outputs; incoming tasks run under the "Ask before changes" preset at most; rate limits per remote agent; all traffic logged in activity.

Tests (tests/interop-agents.test.mjs): agent card served and gated; tasks/send creates a run and returns the artifact; sendSubscribe streams events; cancel; client add/ask against a fake A2A server; ACP over stdio (spawn the CLI) initialize → session/new → prompt with a scripted provider; permission request round trip; exposure policy off by default; rate limit.

Acceptance: I1 A2A server + client proven; I2 ACP stdio proven; I3 exposure off by default and preset cap proven; I4 docs/configuration.md section with a Zed config example; I5 no new dependency. Report the ids you consider done.
