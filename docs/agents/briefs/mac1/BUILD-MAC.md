# Wave mac1 build rules (shared by every Mac-side builder)

Branch Agent was built and tested on Windows only. Wave mac1 makes it run on **macOS and Linux as
well**, without changing anything a Windows user sees. You build ONE area, named in your brief.

## Where you work

- Machine: the owner's Mac (macOS, Apple Silicon, Node 26, zsh). **This Mac is also the owner's
  everyday computer**: nothing you run may open a window, play a sound, show a notification, ask for
  a macOS permission, install a login item, load a launchd job, or touch `~/Library/LaunchAgents`.
- Your worktree: `~/Code/wt/<area>` (new worktrees from 17 September on live in `/Volumes/512GB SSD/branch-wt/<area>`; the internal disk is nearly full — keep large caches, SDKs and build outputs on that SSD too) on branch `mac1/<area>`, cut from `wave2/integration` (already
  created for you; check `git branch --show-current`). Run `npm ci --no-audit --no-fund` once in it.
  Do not symlink `node_modules`.
- Linux check machine: `ssh branch-test-linux` (Ubuntu 24.04, Node 24, Xvfb, no desktop). Copy your
  tree there with `rsync -a --delete --exclude node_modules --exclude dist ./ branch-test-linux:wt/<area>/`
  then `ssh branch-test-linux 'cd wt/<area> && npm ci --no-audit --no-fund >/dev/null && npm run build && xvfb-run -a node --test <files>'`.
  It is shared by several builders: only use `~/wt/<area>` there, and never install system packages.
  **It has 2 processors and 4 GB. Run every Linux build or test through the shared lock, one at a time, with
  concurrency 1:** `ssh branch-test-linux 'flock -o -w 3600 /tmp/branch-linux.lock bash -c "cd wt/<area> && … && xvfb-run -a node --test --test-concurrency=1 <files>"'`.
  Use `flock -o` so the virtual screen never inherits the lock (an orphaned Xvfb once held it and froze every job).
  Put a time limit inside the screen wrapper so a hung test cannot hold the lock:
  `xvfb-run -a timeout -k 30 1500 node --test --test-concurrency=1 <files>` (a `timeout` outside `xvfb-run` only kills
  the wrapper, not `node`). Only run the test files your change touches there, never the whole suite. On 17 September several builders at once
  pushed it past 230% and it stopped answering.
- Windows is checked by the pull-request CI (`.github/workflows/checks.yml` runs Windows, macOS and
  Linux) and by the Legion machine. **Every Windows code path must behave exactly as before.** Keep the
  Windows branch of each function textually recognisable, and keep or strengthen its tests.

## Read first

`README.md`, `docs/CHECKPOINT.md` (top section), `docs/agents/README.md`, `src/index.ts`, the files
your brief owns and their tests (`grep -l <module> tests/*.mjs`).

## Rules (non-negotiable)

- Node 24+, strict TypeScript, ESM, zod for inputs, functions under 50 lines, clarity over cleverness.
- No new npm dependency. Use what macOS and Linux ship (`launchctl`, `systemctl --user`, `say`,
  `system_profiler`, `sysctl`, `ps`, `kill`, `nvidia-smi`, `lspci`, `/proc`), always behind a
  function that takes the executable runner as a parameter so tests can hand in a fake.
- **Tests use fake executables and temporary folders only.** Never call the real `launchctl`,
  `systemctl`, `say`, `osascript`, `open`, `xdg-open`, `security`, or anything that changes the
  machine. Assert the exact command and arguments that would have run. Platform-only tests use
  `{ skip: process.platform !== "darwin" }` (or `"linux"`), and pure logic takes `platform` as a
  parameter so all three platforms are tested on every machine.
- Security properties never loosen on any platform: path confinement, "a rule can only tighten"
  (`sandboxShape`), no secret in a log, network policy on every outbound call, no shell string
  built from user text (use argument arrays).
- Plain language in anything the owner reads ("starts by itself when you sign in", not "launchd agent").
- Tests tear down through `tests/temp-dir.mjs` (`discardTemp`), never a bare `rm`. **Close the app before deleting its
  folder, in one `after` hook** (`t.after(async () => { await app.close(); await discardTemp(root); })`): Node runs
  `after` hooks in registration order, and Windows refuses to delete a database that is still open, so the wrong order
  passes on macOS and fails on Windows every time.
- Never run `tests/desktop*.test.mjs` or `tests/screen-control.test.mjs`, never start Electron with a
  window, never set `BRANCH_SCREEN_TESTS`.
- Stay inside the files your brief owns. If the real fix is in a file another brief owns, write it
  down in your report instead of editing it. Small additive hooks in `src/index.ts` / `src/cli.ts`
  are allowed when unavoidable; keep them in one clearly separated block.
- Docs: a short "macOS and Linux" paragraph in `docs/configuration.md` under your area's section.
  Do not edit `docs/CHECKPOINT.md`, version numbers or release notes (the baton holder does).
- Do not push, open PRs or comment on issues. Commit on your branch with a Conventional Commit
  message ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Before your final commit: `git merge --no-edit origin/wave2/integration` (after `git fetch`),
  `npm run build`, `npx tsc --noEmit`, rerun your tests on macOS **and** on `branch-test-linux`.

## Final report (your last message, under 50 lines)

Branch and head SHA; what now works on macOS and on Linux in plain words; files changed; test
commands with pass/fail counts on each machine; what you could not prove (and why); anything that
belongs to another brief; audit ids you believe are done, each with source file + test.
