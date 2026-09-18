# Checkpoint 2026-09-18 — 0.18.0 prepared; one machine now, and how to carry on

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
**Windows too, not just commands.** An SSH login lands in session 0, which has no desktop, so
anything that draws cannot draw there. `docs/agents/scripts/desktop-bridge.ps1` closes that gap: a
scheduled task against the owner's own interactive logon, triggered from the SSH session, so the
command runs in session 1 on the real screen with full rights and no prompt.

    powershell -NoProfile -File docs/agents/scripts/desktop-bridge.ps1 -Run 'notepad.exe'
    powershell -NoProfile -File docs/agents/scripts/desktop-bridge.ps1 -Run 'npm run package:desktop' -Wait

Installed and proved on 2026-09-17: the bridge reports `SessionId 1`,
`UserInteractive True`, and opened a real window (handle read back, then closed). Installing it
needs the admin rights an SSH session has and a local unelevated shell does not, so install it over
SSH: `desktop-bridge.ps1 -Install`.

- **Do not close or interrupt the Claude Code session on that machine.** The desktop and
  screen-control tests can now genuinely be run through the bridge — but they put a window on the
  owner's screen while they run, so ask first. `docs/agents/scripts/verify.sh` leaves both out,
  which is why it is the thing to run unattended.

## Where the work stands

**Prepared, not yet published: 0.18.0.** The version is set to 0.18.0 on `mac7/release-018`, the
notes are written, and the release path has been checked without being run. Nothing is tagged and
nothing is published: the coordinator presses go, and `docs/agents/RELEASE-018-READY.md` says in what
order.

- **What 0.18.0 is:** `mac/cross-platform` — 0.17.0 plus the 660 commits staging never saw. The nine
  re-audit groups (devices, model savings, comfort settings, deeper learning, flows and boards, safety
  extras, personal, coding, reach and platform), the three security follow-ups, the chat-source and
  chat-permission work, credential autofill, pinned settings, the wake word, waves 9 to 11, the Node
  floor correction, and the Linux, Windows and macOS round fixes. `wave2/integration` is still at the
  0.17.0 point and has to be moved forward as part of publishing.
- **The three things a person must be told**, and the reason each is in the notes rather than left to
  be found: **Node 24.14.0 or newer is now required** (25.4.0 or newer on the 25 line), because the
  proxy setting works by handing the proxy to Node and older Nodes have no way to be told; **a task
  started from a chat app now holds four read-only permissions** instead of everything minus a named
  handful, which is a real narrowing that will stop things that used to work; and **a chat cannot
  approve a change** unless the owner ticks approvals on a line naming that one person on that one
  app.
- **Every new group ships off.** A fresh install is still the provider talking and nothing in the way.
- **Proof so far:** build-fast mode only — `npm run build`, `npx tsc --noEmit`, and the macOS test
  files each branch touched, at `--test-concurrency=2`. **No full three-system round has been run on
  this tree.** That round is the first thing the coordinator owes the release, and until it passes
  0.18.0 is prepared rather than ready.
- **Downloads, and one thing CHECKPOINT used to get wrong:** the publish job no longer uploads with
  `--clobber`. `fix(package): never upload over a download already on the release` added a guard that
  keeps any asset already attached, together with its checksum. So a hand-built Windows zip attached
  to the release *before* the tag is kept, not replaced, and does not need attaching a second time.
  The job also builds the phone download, `branch-agent-<version>.tgz` with its `.sha256`, and refuses
  the release if the tag and `package.json` disagree about the version.
- **Update rehearsal:** not yet run for 0.18.0. The staging folder holds 0.17.0, which is the right
  base for it.
- **Ticks:** not yet rewritten. The `(merged, ships in 0.18.0)` markers in the theme issues become
  `(0.18.0)` at release, and #103 is regenerated after that.

What the 0.17.0 release run found and fixed (all in `9515f87`'s history), kept because each one
will recur:

1. **Signed out by an early reload** (`public/app.js`): the token was saved only after the locker
   answered, so a reload in that gap showed the sign-in form again. This caused the "Tab walks the
   rail" timeouts on the Mac.
2. **Pictures mistaken for keys** (`src/leak-guard.ts`): random base64 can match the Google key
   pattern (`/AIza` plus 35 characters). Matches entirely inside a `data:…;base64,` payload are ignored now.
3. **Activity lists closing themselves** (`public/automations.js`): every refresh redraws the panel.
   A list that is open is now drawn open again.
4. **Linux desktop settings:** Playwright's Electron launcher always adds `--password-store=basic`,
   so no Linux test run can reach a keyring, even when the machine has one (proved on
   branch-test-linux). The test checks the refusal there and says why. Do not try a CI keyring again.
5. Test-only fixes: wait for the words or the variable, not a clock (`cli-tui`, `shell-ui`,
   `session-ui`). Close the server before the app in the same hook (`projects-locker`, `skills`).
   The docs table test no longer breaks on a space in the checkout path. The desktop tests allow two
   minutes for app startup, because the shared Windows runner needed more than 30 s on some runs.
6. **This Mac's `/usr/bin/git` needs the Xcode licence accepted** (owner's password). Until then,
   use `DEVELOPER_DIR=/Library/Developer/CommandLineTools` for git and gh, and put a `git` symlink
   to the Command Line Tools copy first on PATH for suite runs, or `tests/git*.test.mjs` fails with a
   licence message.

**Staging `wave2/integration` is behind the work, not ahead of it.** It still sits at the 0.17.0
point; `mac/cross-platform` is the trunk everything has been merged into since. Moving staging
forward is a step in publishing 0.18.0, not something that already happened.

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

## Two more that were found and fixed, worth knowing because they will recur

- **Teardown order decides whether Windows finishes the run at all.** node runs `after` hooks in
  the order they were registered, so a scratch folder registered in a fixture and an app closed in
  the test tear down backwards: the folder goes first, while SQLite still holds its write-ahead log
  open. macOS allows unlinking an open file; Windows raises EBUSY, the hook throws, node marks the
  **whole file** failed with no message beyond `'test failed'`, and the database that never closed
  keeps the process alive so the run never ends. One stalled for half an hour with 39 node processes
  up and nothing written to the log. It explained two earlier whole-file failures nobody could
  place. `tests/mac-followups.test.mjs` now names what holds the folder open and shuts it first;
  `tests/posix-os.test.mjs` had the same fault a day earlier. **Close the app in the same hook that
  removes the folder, app first.**
- **Linux Electron tests had never once run.** `ubuntu-24.04` switches off unprivileged user
  namespaces, which Electron's sandbox is built on, so all five desktop tests died with "Process
  failed to launch!" before reaching an assertion. Relaxed on the build machine only, in
  `.github/workflows/checks.yml`. The shortcut going around it is passing `--no-sandbox` to Electron,
  which would mean shipping everyone a weaker sandbox so that CI goes green.
