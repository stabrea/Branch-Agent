# What happens after 0.18.0 — the owner's order, 18 September 2026

The owner agreed this order. Work down it. Everything here is decided, not a proposal.

## 1. Ship 0.18.0

`docs/agents/RELEASE-018-READY.md` has the steps. The gate is one green run on all three systems
on the exact tree being released. Do not tag before that.

## 2. The scoreboard — the owner's original ask, still not started

"Beat Hermes and prove it with a scoreboard." Nothing measures this yet, and no feature matters
more than the answer.

1. **The fly-brain learning core against a real model.** Everything so far used stand-ins, so
   `experiments/fly-core/` is a design, not a result. Run it for real, and record what it changes.
2. **Head to head against Hermes.** The same tasks, the same models, the same machine. Measure what
   a person cares about: did it finish, how long, what did it cost, how often did it need rescuing.
3. **A scoreboard the owner can read** — plain numbers, honest about what was not measured. Tower is
   the machine for this (see `reference_hermes_nas.md` in the owner's memory).

Do not report a win that the numbers do not show.

## 3. What the audits found

- Open source: `~/Code/agent-refs/rescans/re-audit-2026-09-18.md`.
- Closed products: `~/Code/agent-refs/rescans/closed-audit-2026-09-18.md` — 29 things Branch lacks,
  5 where Branch is weaker, 28 already matched, 13 not for us.

The closed audit's real finding: **the gap is fixes and reliability, not features.** Claude Code's
last two releases were ~200 changes, about 85% of them fixes. Its ranked list:

1. **Projects that outlive a conversation** — the one true feature gap. A goal that survives across
   threads, shared memory, per-thread steering, per-project cost. Branch's `src/projects.ts` is a
   folder; `orchestration-modes.ts` lives inside one task. Anthropic and Cursor shipped this shape
   eight days apart.
2. **A week breaking Branch on purpose** — match their fix energy on resume, rewind, compaction,
   malformed history, plugin reloads.
3. **Meet the person at the desk** — no global shortcut, no floating companion, no "send the agent
   this window". Low effort, largest daily effect.
4. **Biometric approvals and per-command network limits** — Branch's restraint machinery is already
   the best in this field; these make it usable rather than switched off.
5. **A dozen finished workflow packs in the box** — `autonomy/blueprints.ts` exists, the content
   does not.

## 4. Never break, no matter what

`mac7/install-torture` is the second chaos round: killed mid-update, mid-migration, mid-rollback;
a full disk, a read-only folder, a truncated database, a torn journal; new data opened by an old
version; the clock jumping; two copies on one data folder; a half-downloaded extra. A pass means
Branch starts, the owner's data is intact, and every refusal is in plain words. Anything needing a
human to clean up by hand is a failure. Merge it, then keep it running in CI like the 200 seeds.

## 5. Already building, for the release after this one

- `mac7/one-click` — one button that installs a local model runner and a model that fits this
  computer (public issue #107). It asks before it installs, checks what it downloads, and is the one
  place Branch changes the person's machine.
- `mac7/phone-pairing` — pair a phone from the phone: scan the code, key in the phone's own secure
  storage, a "never allow" list on the phone itself.

## 6. Size and identity — research first, then build

`~/Code/agent-refs/rescans/identity-and-size-2026-09-18.md` (being written) answers two things the
owner asked for:

- **Keep the system's permissions across an update without paying for a developer account.** On a
  Mac, permission is tied to the app's identity, and for an unsigned app that includes the program's
  own contents — so an update looks like a stranger and asks again. Replacing only the inner files,
  or signing with a free self-made certificate, may avoid that. The report settles which.
  Android already has this for free through the owner's own signing key: **do not lose that key**
  (`~/.branch-mobile-keystore/`).
- **The smallest honest download**, with everything else fetched when a feature is switched on.
  Today's 127–163 MB is almost all the engine that draws the window; Branch's own code is 22 MB and
  there are four runtime dependencies. A command-line-and-server build with no window is roughly
  25–30 MB. Every fetch must survive no network, a blocked network, half a download, a corrupt file,
  a full disk and being killed mid-install — nothing fetched may ever be needed to start.

## The rule that decides dependencies

Four runtime dependencies today (`@modelcontextprotocol/sdk`, `playwright`, `yaml`, `zod`). The
default stays **no new npm dependency**. Break it only when all of these hold: it gives a capability
we genuinely cannot build, it is MIT or Apache and small in its own dependency count, we pin and
check the exact version, and we could remove it later without tearing out a feature. Prefer using a
program the person already has on their machine over shipping one.
