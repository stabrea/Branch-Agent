# Checkpoint 2026-09-17 (early morning) — one machine now, and how to carry on

**Read this first, then `docs/places.md`, then `docs/agents/README.md`.**

## Who is building

**The Mac mini is the only builder.** Two Windows sessions worked on this repository; both have
finished. Everything either of them left behind has been audited — all 114 worktrees, every local
branch, the shared stash stack — and **nothing is stranded**. The one unpushed branch,
`wave9/redesign-old`, was content-diffed against the pushed `wave9/redesign` and is strictly older.

**The Mac holds the baton, with no one to coordinate with.** It may merge into `wave2/integration`,
cut and publish releases, tick the theme issues and regenerate public issue #103 — all of it, on its
own judgement. The coordination chat (`stabrea/branch-coordination` issue #1) is now a log rather
than a conversation; the ten-minute check can be switched off.

## The Mac can drive this Windows machine

Windows stays on. When something has to be proved on Windows — packaging, the installer, the update
rehearsal, anything that only fails on this platform — the Mac signs in and does it itself.

    ssh -i <key> bishi@100.108.156.35        # or taofiks-legion, over Tailscale
    cd C:/Users/bishi/Documents/Codex/Branch-build

The key is in Bitwarden, item **"Branch Agent - Mac mini SSH into Windows (Legion)"**, in its hidden
password field, with the address and a test command in its notes. It was tested end to end on
2026-09-17: generated, authorised, fetched back out of the vault and used to log in over Tailscale.

**Write it out with its trailing newline and `chmod 600` it.** OpenSSH refuses a private key that
has lost its final line ending, which is easy to do with a shell that trims.

Two things that will waste an afternoon otherwise:

- **`~/.ssh/authorized_keys` on this machine does nothing.** `bishi` is in the Administrators group,
  so OpenSSH reads `C:\ProgramData\ssh\administrators_authorized_keys` and ignores the user file
  entirely. Two older Mac keys sit in the user file having no effect at all. Adding a key to the
  administrators file needs elevation and the strict ACL (`icacls … /inheritance:r /grant
  Administrators:F /grant SYSTEM:F`), or sshd silently refuses it.
- **Do not close or interrupt the Claude Code session on that machine**, and never run
  `tests/desktop*.test.mjs` or `tests/screen-control.test.mjs` over SSH — they open a window on the
  owner's screen. `docs/agents/scripts/verify.sh` leaves both out, which is why it is the thing to
  run.

## Where the work stands

**Released: 0.16.0**, installed and running on the owner's PC.

**0.17.0 is cut and waiting on CI** — branch `feat/assistant-runtime`, pull request #104. It began as
the eight top buckets of the public list and now also carries buckets 9–11, the Mac's own
cross-platform work, the wave 9 window redesign, the owner's hand-written context files, and the
trusted mid-task steering channel. `docs/agents/briefs/release-notes-0.17.0.md` describes all of it.

**Staging `wave2/integration`** additionally holds the Mac's third-wave briefs and the prompt
library is on `wave9/prompt-library`, backend and screen complete with 8 passing tests, not yet
merged.

**Everything the owner reversed is back on the list.** The forty rows once marked "decided against"
are re-opened. Nothing is declined any more: if a feature exists in any agent, it exists in this one,
reimplemented as ours rather than ported.

**Every new thing ships with a three-way switch** — on, off, or loaded only when the work calls for
it — and ships **off**. A fresh install is the provider talking and nothing in the way.

## The rules that cost the most to learn

1. **Where a feature goes is written down.** `docs/places.md` gives every feature a home, and a card
   places itself with `data-home="settings:computer"`. Never edit `layout.js` to place a card, never
   append to another screen's element, and open a screen in tests through `tests/places.mjs` the way
   a person would. A new place, a thirteenth Settings page or a fifth pane tab needs the owner's
   approval first.
2. **A new file in `public/` is not served until it is in the allowlist in `src/server.ts`.** A
   missing entry 404s silently and the feature simply never appears.
3. **A new tool with no toolbox lands in the always-open set** and grows the per-round catalog for
   every task that never touches it. `tests/catalog-diet.test.mjs` catches it.
4. **A test that sleeps is a test that fails somewhere else.** Six were fixed in one day: four slept
   for a guess at how long something takes, two read a toast that was already on screen. A build
   machine under load is many times slower than a laptop. Wait for the thing, never for a clock.
5. **A bare filename is not a translation.** `Q6` in `tests/web-ui.test.mjs` treats a key that
   answers the same in both languages as English that was never translated, and it is right to.
6. **`dist` can be stale after a merge.** Delete it, rebuild, and grep the built file for something
   you know changed before trusting any run.
7. **Never run the suite in the checkout you are editing.** Three runs were binned in one day to
   learn this. `verify.sh` checks a commit out in a worktree nobody is touching.
8. **A caveat is a bug you have not fixed yet.** A flow box interrupted between finishing and its
   checkpoint was silently re-run, and that was nearly shipped as a line in the release notes.

## Two things known to be wrong, and worth someone's attention

- **Whole-file test failures under concurrency.** Twice now a file has failed as a whole — first
  `tests/chatgpt.test.mjs`, then `tests/evaluation-more.test.mjs` — with every test inside it
  passing and no error printed beyond `'test failed'`. Both pass on their own. `busy_timeout` is set
  to 100ms in `src/store.ts`, which is short for a loaded machine, and is the first thing worth
  looking at.
- **Linux Electron tests had never once run.** `ubuntu-24.04` switches off unprivileged user
  namespaces, which Electron's sandbox is built on, so all five desktop tests died with "Process
  failed to launch!" before reaching an assertion. Relaxed on the build machine only, in
  `.github/workflows/checks.yml`. The shortcut going around it is passing `--no-sandbox` to Electron,
  which would mean shipping everyone a weaker sandbox so that CI goes green.
