# Handoff — 17 September 2026, Mac coordinator → cloud session

The Mac holds the baton. Read this, then `docs/CHECKPOINT.md`, then
`~/Code/branch-coordination/LIST.md` (Mac only; the cloud has the repo, not that file).

## Where the code is

- Trunk: `mac/cross-platform`, head **1b74f51**, pushed. Build and `npx tsc --noEmit` clean.
- Staging (`wave2/integration`) and `main` do **not** yet have today's work.
- Release target: **0.18.0**, not cut.

## Merged today (each built by an Opus builder, then reviewed by an adversarial Opus integrator)

Nine re-audit groups plus follow-ups, all off by default:

1. Devices / nodes (pairing a phone or another computer) — 8 holes fixed.
2. R17-E model savings (planning model, difficulty routing, cache keep-alive, OpenRouter, mixtures, round chart) — 9 fixed.
3. R17-S-C comfort settings (shortcuts, status line, notifications, auto-update, push-to-talk, browser care, proxy and certificates, ignore files, terminal controls) — 8 fixed.
4. R17-F deeper learning (memory blocks, skill curator, journey, meaning search, lessons, session lessons, tags and expiry, mirror read-back, outside providers) — 8 fixed.
5. R17-H flows and boards (time travel, recipe checks, kanban, widgets, waiting line, `/focus`, install requests) — 11 fixed.
6. R17-G safety extras (tool scripts, WASM add-ons, authenticator codes and emergency stop, command scan, progress judge, activity chain, history repair) — 8 fixed. Credential vault (R17-068) NOT built: waiting on the owner.
7. Three security follow-ups (Lockdown beats saved modes; Trunks never use sign-in accounts; workflows limited to the calling task's permissions) — 9 fixed.
8. R17-I reach and platform (other computers, remote Trunks, background screen, video, relay, `branch send` / `/platform`, Docker/Nix/Termux files, agent git and bundles, USB rules, notes) — 9 fixed, then 5 leftovers closed.
9. Chat source security (see below), and the chat permission allowlist.

### The chat security work (biggest change of the day)

- A task started from a chat app now carries `source: "channel"`, through helpers, side questions,
  workflow and flow prompt steps, schedules it creates, and resumed tasks. About 20 owner-only guards
  now refuse it. Before this, every "is this the owner?" check treated a chat sender as the owner.
- `chatPermissionsOf` (`src/channels/chat-permissions.ts`) is now an **allowlist**:
  `user.ask`, `files.read`, `memory.read`, `skills.read`, `web.read`. Everything else is refused,
  including permissions added later. The owner grants more per channel and per sender at
  Customize → Chat apps (`chat-permissions` setting, `POST /api/channels/permissions`).
- A chat sender cannot approve what a rule granted: that yes must come from the window. `n` still works from chat.
- `neverFromChat` covers whole families: `shell.` `remote.` `devices.` `nodes.` `personal.` `home.` `trunks.`.
- Every address under `/api/channels` and `/api/channel-setup` is now owner-only, guarded once at dispatch.

## Still open

### Running when this was written

- **waves-9-11** builder (`mac6/waves-9-11`, worktree `/Volumes/512GB SSD/branch-wt/waves-9-11`, head 20a5efa)
  merging helper branches `mac6/w911-evalfix` 98fb550, `w911-web` 02bb0b6, `w911-proof` c4fda32,
  `w911-sandbox` 3f6d8ee, `w911-annot` 4594650. Needs an adversarial integrator afterwards.
- **ci-green** (`mac6/ci-green`, head c34d6e9, worktree `/Volumes/512GB SSD/branch-wt/ci-green`):
  three fixes NOT in trunk — 116c6d7 (desktop files one at a time, macOS export timeout, move-in and
  memory-ui races, `checks.yml` triggers), e8925dd (label chip state, live-feed wait), 13a8d6e
  (one-click newest draw only), plus `scripts/run-tests.mjs` and a changed `test` script.
  Merge into trunk once its run is green on all three systems.
- A full macOS suite run on 1b74f51 (every file except `tests/desktop*` and `screen-control`).

### Before 0.18.0

1. Full three-system round: macOS, `ssh branch-test-linux` (flock lock, xvfb, concurrency 1), Windows
   via CI and `ssh legion-branch`; Linux chaos 200 seeds; Linux desktop tests.
2. Merge trunk into `wave2/integration`, then release 0.18.0, then update issue #103 and the theme issues.

### Owner decisions — decided by the coordinator 2026-09-17, owner may overrule

The owner was closing the session and did not want to spend answers on these, so the coordinator
decided and told them. Build all three; each ships off.

- **Credential vault (R17-068): autofill only.** Branch fills a saved sign-in when the owner asks and
  never shows, prints, logs or gives the value to the model, and never stores passwords itself: it
  reads from the password manager the owner already uses. The rest of a vault is not worth an agent
  holding the owner's passwords.
- **Wake word: build it, off, listening only on this computer.** No audio leaves the machine, nothing
  is recorded before the word is heard, push-to-talk stays the default. If local word-spotting is poor,
  it stays off rather than sending audio to a service.
- **Pinned settings: build it.** The owner can pin any setting so a household person sees it but cannot
  change it. Pinning is the owner's alone.

### Known gaps (not blockers)

- Phone app has no pairing screen; Capacitor notification and clipboard plugins not wired.
- Pairing another computer with its key is API/CLI only, no card.
- Fly-core has never run against a real model; no Hermes head-to-head scoreboard yet.
- Mem0 and Honcho were tested against fake servers only; meaning search with a fake embedder only.
- Docker, Nix and Termux packaging: all three were built for real on 2026-09-18 (mac7/packaging-real,
  on the owner's NAS and the small Ubuntu VM). The image is 287 MB on x86_64, runs as uid 999 and
  bakes in nothing; the flake builds against nixpkgs' nodejs 24.20.0 and its `branch` runs; the Termux
  script refuses a wrong checksum, refuses a missing `.sha256`, refuses an old Node, and installs the
  real tarball. Still unproven: a real Android phone (aarch64, `pkg install nodejs`, `termux-wake-lock`,
  the global install into Termux's own prefix) and the image on arm64.
- The Dockerfile's header documents `docker run --network host`, and that is the only run line that
  works: src/server.ts:3056 binds 127.0.0.1 with no way to change it, so a published port reaches
  nothing and host networking puts the listener on the NAS's own loopback. Product-side, not packaging.
- `docs/features.md` is stale; issue #103 is stale.
- `accounts` `viewAll` shows a household person pool metadata (kind, strategy, ChatGPT signed-in), no keys.
- Monthly spend figure misses a video a still-running task is making.
- Malware check counts a result longer than 10 pages as clean.

## Rules the cloud session must keep

- Owner bypasses permission prompts on Branch work: decide, act, report — do not ask for approval.
- Build-fast mode: macOS targeted tests per branch (`--test-concurrency=2`), plus `npm run build` and
  `npx tsc --noEmit`. One full three-system round before release.
- Never run `tests/desktop*` or `tests/screen-control` on the owner's Mac. Never open a window, play a
  sound, or load a launchd job there.
- Pass explicit file lists to `node --test`. A zsh glob that matches nothing aborts the command, and a
  bare `node --test` runs everything, which is forbidden.
- Check `git status --ignored` for real build outputs before `git worktree remove --force`.
- Every feature ships off, with an off / when-needed / on switch.
- Only MIT/Apache code may be ported. Lawful channel parity only: no unofficial clients, no userbots.
- Never print credentials or vault items.
- Conventional Commits, each message ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Recurring merge traps

- `python3 ~/Code/resolve-common.py` handles locale JSON, `public/index.html` script tags, additive
  `src/*.ts` conflicts and `docs/places.md` rows. Everything else is by hand, keeping both sides.
- Git has misaligned `src/server.ts` route-block conflicts several times: re-read every route block
  and the `src/index.ts` close sequence after each merge, and let `tsc` catch the rest.
- `dashboard-card.js` must stay directly before `layout.js`, and each script listed once
  (`tests/index-structure.test.mjs`, `tests/dashboard.test.mjs`, `tests/agent-interop.test.mjs`).
- `tests/handbook.test.mjs` H2 fails whenever a new setting name is missing from `docs/configuration.md`.

## Added after the first handoff (Mac, end of session)

Full macOS suite on 1b74f51 (every file except `tests/desktop*` and `screen-control`):
**3248 tests, 3227 pass, 7 fail, 14 skipped.** Fixed and pushed (d4e1992): a literal NUL in
`tests/personal-files-voice.test.mjs`, and 40 fixture credentials across 13 test files now marked
`not-a-real-secret`. The R17-S01 French check fails only when the machine is loaded; it passes alone.

Two builders were running when the Mac session ended. Their branches are NOT pushed; if a cloud
session takes over, redo the work from these notes.

1. **`mac7/chat-approvals`** (worktree `/Volumes/512GB SSD/branch-wt/chat-approvals`).
   Today's chat lock-down means the owner can grant their phone the right to change things but must
   then approve at the computer, so the three G2 tests in `tests/polish-observability.test.mjs` fail
   (the Yes button is gone). The fix: a per-sender `approvals` switch in the `chat-permissions` rules,
   shipped off, letting that sender answer Yes for what their own rule granted — never a standing yes,
   never anything on `neverFromChat` — with a plain warning on the card and in the docs that a chat app
   cannot prove who is typing. Then fix the three G2 tests to the settled behaviour.
2. **`mac7/tool-search`** (worktree `/Volumes/512GB SSD/branch-wt/tool-search`).
   `tests/tool-loading.test.mjs` "searching ranks an exact name…" fails: "make a new specialist" ranks
   `templates.import`, `media.info`, `git.worktree_add`. Today's several hundred new tools drowned the
   ranking, which costs every task quality and tokens. Weight the name and first sentence, damp terms
   carried by many tools, and add queries across devices, comfort, safety extras, flows and boards,
   learning-more and reach.

Both still need an adversarial integrator afterwards, like every other branch.
