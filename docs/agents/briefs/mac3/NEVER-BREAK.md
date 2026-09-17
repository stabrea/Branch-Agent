# mac3/never-break: a gateway the assistant cannot break, work that survives restarts, updates that cannot brick it

Area `never-break`. Rules: BUILD-MAC.md, mac2/README.md, mac3/DESIGN-EVERYWHERE.md, docs/places.md. Worktree on the
external SSD. The owner's words: "this agent never breaks, even for updates … we can literally change the whole code
and update it and it will still never break … OpenClaw always breaks when the agent edits its gateway, Hermes broke
three times … even if the gateway is restarted mid-task the agent picks up where it left off."

Read first: `src/cli.ts` (start/daemon), `src/install/*`, `src/desktop/updater.ts`, `src/desktop/hand-over.ts`,
`src/long-jobs*` / bucket 8 work (resume after restart), `src/runtime.ts` run lifecycle, `src/channels/router.ts`,
`src/scheduler.ts`, `src/files.ts` / `src/policy.ts` (what the assistant may touch). Study how OpenClaw's gateway and
Hermes' gateway are structured and how they break (`/Users/taofikbishi/Code/agent-refs/openclaw`, `hermes-agent`, MIT).
Start with `docs/never-break.md`: a short design (threat list: agent edits, bad config, crash mid-tool-call, power
loss, update with incompatible data, update that fails to start, half-written files) and, for each, the mechanism and
the test that proves it. Then build it, in order:

1. **An untouchable gateway.** A small, stable supervisor process ("gateway") owns: the HTTP/API listener, chat-app
   connections, the scheduler clock, the task journal. The model/tool work runs in a separate worker it starts and
   restarts. The assistant can never modify the gateway: a hard, non-overridable deny (no rule, grant, lockdown-off or
   switch can lift it) on the install folder, the gateway's config, the data folder's database files and the updater;
   config changes the assistant proposes go through a validator (schema + a dry-run start of a throwaway gateway on a
   copy) and are applied only after the owner accepts; the last known-good config is kept and restored automatically if
   the gateway fails to start. A worker crash never takes the gateway down.
2. **Work that survives any restart.** A write-ahead task journal (in SQLite, fsync'd): every model turn, every tool
   call with an idempotency key and a "side effects" class (none / idempotent / external). On gateway or worker restart,
   interrupted runs resume from the journal: finished steps are not repeated; a tool call that was in flight is
   re-run only if it is side-effect-free or idempotent, otherwise the task asks the owner ("this may have already sent
   the email — check or resend?") or verifies (file checksum, git state). Chat messages that arrived during the outage
   are fetched and answered (channel offsets persisted); scheduled jobs missed during downtime run once with a note.
   Build on the bucket 8 long-jobs work rather than beside it.
3. **Updates that cannot brick it.** Blue/green: the new version is unpacked beside the current one, started as a
   canary on a snapshot copy of the data with its migrations applied to the copy, and must pass a built-in self-test
   (start, API health, a scripted offline task, channel adapters load, scheduler ticks, journal resume) before the
   swap. Migrations are versioned, backed up first, and each has a tested down-path; data formats stay readable by the
   previous version for one release. After the swap a watchdog rolls back automatically if health fails in the first
   minutes. Keep the last two versions. The gateway/updater contract is versioned so a new worker works with an old
   gateway and vice versa. Same on Windows, macOS and Linux (the Windows hand-over keeps opening zero console windows).
4. **Chaos tests** that prove it: kill -9 the worker and the gateway at random points in scripted tasks (many seeds),
   corrupt a config, fill the disk, interrupt an update at every step — the assistant always comes back and finishes or
   asks. Keep them fast enough for CI (a quick set) plus a longer set for the Linux test machine.
5. **Telegram when the owner is ready:** Branch already has the official Telegram Bot API adapter. Add a guided setup
   card (BotFather steps in plain words, token straight into the locker, pairing with the owner's account) — do not use
   a real token; the owner will do it later.
