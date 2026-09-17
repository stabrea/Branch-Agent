# Never breaks

The owner's words: *"this agent never breaks, even for updates … even if the gateway is restarted
mid-task the agent picks up where it left off."* OpenClaw breaks when its agent edits its own gateway;
Hermes broke three times. This page is the design that stops Branch doing either, the list of ways it
could break, and the test that proves each one is handled. Brief: `docs/agents/briefs/mac3/NEVER-BREAK.md`.

## The shape

```
            owner's app, phone, browser, chat webhooks
                              │
                    ┌─────────▼──────────┐
                    │  gateway (small)   │  listens on the public port, owns gateway.json and the
                    │  src/never-break/  │  last good copy, starts/restarts the worker, watches the
                    │  gateway.ts        │  first minutes after an update, never opens the database
                    └─────────┬──────────┘
                    loopback  │  IPC (ready / health / stop, contract version)
                    ┌─────────▼──────────┐
                    │  worker = engine   │  the whole assistant: models, tools, chat channels,
                    │  dist/cli.js start │  scheduler, branch.sqlite and journal.sqlite
                    └────────────────────┘
```

**Why the worker holds the database, not the gateway.** `src/store.ts` opens `branch.sqlite` with
`locking_mode=EXCLUSIVE`; a second process gets "already running against this data directory"
(checked on 17 September). The runtime and every tool read and write the store synchronously, in
hundreds of places, so taking model and tool work out of the process that holds the store would be a
rewrite of the engine, not a gateway. Instead the gateway holds **nothing that can be corrupted by
the work**: no database, no model, no tool. It keeps the public port open, so the owner's app and
chat webhooks always reach something that answers; it forwards to the worker on a private loopback
port; and when the worker dies it starts another only after the old one has gone (so the lock is
free). A worker whose gateway disappears notices its IPC channel closing and closes itself, so a
killed gateway never leaves an orphan holding the lock.

Chat connections and the scheduler clock run in the worker, next to the store they write to. What
makes them survive a restart is that their position is written down: the Telegram offset is saved
after each message is handled, and a schedule is claimed in the database before it runs.

Ideas studied (MIT, reimplemented, see `THIRD_PARTY_NOTICES.md`): Hermes' restart-loop breaker
(`gateway/restart_loop_guard.py`: boots chained by gap, auto-resume skipped once tripped), Hermes'
lifecycle ledger (a "running" sentinel left behind means the last exit was unclean), and OpenClaw's
last-known-good config promotion (`src/config/io.observe-recovery.ts`).

## What the switch covers, and what it does not

Every new feature ships behind the three-way switch, off. Two things here are deliberately **not**
switchable, because a switch that could turn them off would itself be the override the brief forbids:

- **The hard deny** on the install folder, the gateway's config, the database files and the updater.
  Like path confinement, it is a security property and never loosens.
- **The journal**, and marking interrupted tasks on start. Writing down what happened costs little
  and is what every other mechanism reads.

The switch, `settings:general` → "Keeps running through crashes and updates", covers the new
*behaviour*: off (as today: `branch start` is the engine alone), when needed (the gateway runs, and
interrupted tasks are offered to the owner to carry on), on (the gateway runs and interrupted tasks
carry on by themselves, asking only where a step may already have reached the outside world). The
canary self-test before an update and the Telegram setup card follow the same switch.

## Threats, mechanisms and the test for each

Result is filled in as each part lands; the final report copies this table.

| # | Threat | Mechanism | Test | Result |
| --- | --- | --- | --- | --- |
| 1 | The assistant edits or deletes its own gateway, config, database or updater | `protectedTarget` in `src/never-break/protected.ts`, checked in `Runtime.checkPolicy` beside the role refusal, before any rule, grant, hook, Lockdown or switch; covers file tools and every word of a command; also refuses commands that stop or reinstall Branch's own service | `tests/never-break-deny.test.mjs` | pending |
| 2 | A bad gateway config (typo, wrong port, junk) | `gateway.json` is validated by schema; a proposed change is checked by a dry-run start of a throwaway gateway on a copy and waits for the owner; `gateway.good.json` is promoted after a healthy start and restored when the current one fails | `tests/never-break-gateway.test.mjs` | pending |
| 3 | A crash in the middle of a tool call (worker or gateway killed) | The gateway restarts the worker with back-off and a restart-loop breaker; `journal.sqlite` records every model turn and tool call (idempotency key, side-effect class) before it runs, fsync'd; on start interrupted tasks are resumed: finished steps are kept, an in-flight step is re-run only if it changes nothing or is idempotent, a step that may have reached the outside is checked (file checksum) or asked about | `tests/never-break-journal.test.mjs`, `tests/never-break-chaos.test.mjs` | pending |
| 4 | Power loss | `journal.sqlite` uses `synchronous=FULL`; the store's WAL recovery plus `recoverInterruptedRuns`; chat offsets and schedule claims are in the database; missed schedules run once with a note | `tests/never-break-journal.test.mjs` | pending |
| 5 | An update with data the new (or old) version cannot read | Data format stamp (`PRAGMA user_version` + `branch_format` with the oldest reader); versioned migrations run on a backup first, each with a tested down-path (additive columns need none: the older version ignores them); a version refuses, in a sentence, data newer than it can read instead of damaging it | `tests/never-break-update.test.mjs` | pending |
| 6 | An update that does not start | Blue/green: the new version is unpacked beside the old, started as a canary on a copy of the data (migrations applied to the copy) and must pass `branch selftest` before the swap; after the swap the gateway watches the first minutes and rolls back; the last two versions are kept; the gateway/worker contract is versioned both ways | `tests/never-break-update.test.mjs` | pending |
| 7 | Half-written files (config, swap interrupted) | Every file the gateway writes is written to a temporary name, fsync'd and renamed; an update interrupted at any step is repaired on the next start (`repairSwap`: a missing target is put back from the previous copy, a leftover incoming copy is removed) | `tests/never-break-update.test.mjs`, `tests/never-break-chaos.test.mjs` | pending |
| 8 | A full disk | A journal write that fails stops the task with a plain sentence instead of running a step it could not record; the gateway keeps answering | `tests/never-break-chaos.test.mjs` | pending |

## Tests

All of them use temporary folders and child processes the test starts itself. None signals, reads or
writes the owner's real install, and none calls `launchctl`, `systemctl` or `schtasks`. The quick
chaos set runs a handful of seeds and belongs in CI; `BRANCH_CHAOS_SEEDS=200` runs the long set on
the Linux test machine through the shared lock.
