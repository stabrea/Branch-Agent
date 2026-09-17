# mac2/chat-live: see and steer Branch from the chat apps

Area `chat-live`. Read `docs/agents/briefs/mac2/README.md`. **You own:** `src/channels/router.ts`,
`src/channels/deliveries.ts`, the channel adapter interface and the adapters under `src/channels/` (additive
methods only), new `src/channels/live-status.ts`, `src/channels/chat-commands.ts`, and tests.

1. **Working status in the chat:** while a task runs, keep the typing indicator on where the app has one; react to the
   owner's message with a state emoji (queued / thinking / using a tool / done / error) where reactions exist; keep
   one progress message edited in place listing the steps, and stream the reply by editing it where editing exists;
   degrade gracefully per adapter (optional interface methods). Study OpenClaw `src/channels/typing.ts`,
   `status-reactions.ts`, `progress-draft-compositor.ts`, `draft-stream-loop.ts` (MIT); PicoClaw
   `pkg/channels/tool_feedback_animator.go` (MIT).
2. **Control from chat while a task runs:** `/stop`, `/status`, `/new`, `/compact`, `/usage` (adds a tokens-and-cost
   line to replies), `/btw <question>` (answered on the side, never enters the task), and a follow-up message
   steers the running task through the existing steer path (`/api/runs/:id/steer` logic) instead of starting a new
   one; messages arriving in quick succession merge into one turn. Only paired/allowed senders. Study OpenClaw
   `src/auto-reply/commands-registry.shared.ts`, `inbound-debounce.ts`, `reply/btw-command.ts`,
   `reply/agent-runner-steer-adoption.ts`; PicoClaw `pkg/agent/steering.go`.
3. **Long replies split without breaking code blocks** (per-channel size, prefer paragraph breaks) — OpenClaw
   `src/auto-reply/chunk.ts`.
Tests with fake adapters; never contact a real chat service.
