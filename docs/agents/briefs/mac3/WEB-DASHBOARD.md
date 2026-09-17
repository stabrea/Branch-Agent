# mac3/web-dashboard: a control dashboard in the browser, like OpenClaw's

Area `web-dashboard`, branch `mac3/web-dashboard` from `mac/cross-platform`. Read `docs/agents/briefs/mac3/DESIGN-EVERYWHERE.md`,
`docs/agents/briefs/mac1/BUILD-MAC.md`, `docs/agents/briefs/mac2/README.md`, and study OpenClaw's Control UI
(`/Users/taofikbishi/Code/agent-refs/openclaw/ui/`, MIT) and Hermes Agent's dashboard (find it in
`/Users/taofikbishi/Code/agent-refs/hermes-agent`, MIT) for what an owner wants at a glance.
**You own:** new `public/dashboard/**` (or a `dashboard` place-page if `docs/places.md` fits it better — decide and say
why), new `src/dashboard-api.ts` with one route block in `src/server.ts` (static allowlist too), tests.

A page served by Branch itself (same session key, same host/origin rules, reachable over the paired/Tailscale address
for the phone and other computers) that shows at a glance, in the Branch design:
- **Now:** is Branch running, which model and connection, what is running right now (with Stop), what needs you.
- **Health:** connections and chat apps (connected / failing, last message), automations (healthy / failing / never
  run), background engine and updater state, disk and memory use, recent errors in plain words.
- **Spend:** today / this month by connection and by project, with the forecast from the existing ledger.
- **Activity:** live feed of tasks and tool calls (existing events stream), filterable, with a link into each task.
- **Controls:** pause all automations, lockdown on/off, restart the engine, open Settings pages.
It must fit a phone (400 px) and a wall screen; everything read-only unless the key allows running things.
Reuse existing routes wherever they exist; add only the missing summary routes.
