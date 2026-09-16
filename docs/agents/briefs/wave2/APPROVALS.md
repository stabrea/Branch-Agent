# Wave 2 task: approval policies, rate limits and execution guardrails

Rules: docs/agents/briefs/wave1/BUILD.md. Branch: wave2/approvals from origin/feat/assistant-runtime. Themes: permissions-and-policies (#66), sandboxing-and-isolation (#80) S/M items. No new screens (the shell is being redesigned elsewhere); a small additive section in the existing Settings form is fine, but the substance is runtime + policy + tests.

Read: src/contracts.ts (permissions, ToolContext), src/runtime.ts (tool gate, user.ask, reconciliation), src/permissions*.ts if present, src/integrations/shell*.ts and shell-config, src/network-policy.ts, src/integrations/browser.ts, docs/configuration.md.

Build:
1. Policy rules (A0048, A0262, A1629, A0152): a small declarative policy stored per owner (`settings/policy`) with ordered rules { tool (glob), match (e.g. path glob for files, command prefix for shell, host for web/browser), decision: "allow" | "ask" | "deny", remember: "never" | "session" | "always" }. Evaluation happens once in the runtime's tool gate before execution; default policy keeps today's behaviour exactly. An "ask" pauses through the existing user.ask flow and shows what will happen (tool, target, a short diff or command). "session" grants are kept in memory per conversation; "always" grants are written back as allow rules.
2. Approval modes preset (A0152/A0245): three named presets the owner can pick — "Ask before changes" (default: writes, shell, browser actions ask), "Just do it inside my workspace" (writes allowed, shell asks, network asks for new hosts), "Read only" (all writes/shell denied). Presets expand to rules; the owner can still edit rules.
3. Browser action approval (A1521): browser clicks/typing/form submits go through the same gate with the page origin as the match; navigation stays under the network policy.
4. Dry run (A0636, A1685): `POST /api/run` accepts `dryRun: true` and the CLI accepts `--dry-run`: the model runs, but every tool with side effects returns a simulated result stating what would have happened; the run report lists the intended actions. Read-only tools run for real.
5. Per-session rate limiting (A2028): configurable per-conversation limits for tool calls per minute and model rounds per minute; exceeding pauses the run with a plain message rather than failing it, resuming after the window.
6. Post-write validation hook (A0701): after files.write/patch of a .json file, parse and report a warning event if invalid (do not roll back).
7. Explicit run authorization for triggers/MCP/schedules (A1685): sources other than the owner's own UI/CLI use the policy preset "Ask before changes" at most, and cannot be granted "always" from inside the run.

Tests (tests/approvals.test.mjs): rule ordering and glob match; ask → session grant → second call not asked; always grant persisted as a rule; presets expand and default equals current behaviour (existing permission tests unchanged); browser action ask with origin; dry run simulates a write and the file is untouched; rate limit pauses and resumes; JSON post-write warning event; non-owner sources cannot escalate.

Acceptance: P1 default behaviour unchanged (all existing tests green); P2 three presets selectable via GET/POST /api/policy; P3 dry run proven; P4 rate limit proven; P5 docs/configuration.md documents rules, presets, dry run and limits in plain language; P6 no new dependency.
