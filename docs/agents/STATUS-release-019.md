# STATUS: prepare 0.19.0 and run the owner's release gate (mac7/release-019)

Agent: Claude (Legion), 2026-09-19. Worktree `C:/Users/bishi/Code/wt/release-019`, branch `mac7/release-019`,
cut from trunk `mac/cross-platform` at **d7e7de13**. Version-bump commit: **e08c98e4** — every gate below
ran on e08c98e4 unless it says otherwise.

Nothing here is tagged, published or merged into trunk. That is the coordinator's, after CI is green twice.

- [x] 1. Version 0.19.0 everywhere (e08c98e4)
- [x] 2. Release notes `docs/agents/briefs/release-notes-0.19.0.md` (verification section left as a placeholder)
- [ ] 3. Linux gate on `branch-test-linux`: desktop tests (xvfb, one at a time), full suite, chaos 200 seeds, install-torture 200 seeds
- [x] 4. macOS: build, tsc, every non-desktop test file at concurrency 2
- [x] 5. Windows: packaged desktop tests over `ssh legion-branch` (session 0, no visible window)
- [x] 6. Commit and push `mac7/release-019` (not merged, not tagged)

## 1. Version

`package.json`, `package-lock.json` (both entries), the three plugin manifests
(`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`), and — following
0.18.1's own bump commit eb50d572 — the mobile app: `apps/mobile/package.json`, its lock (both entries),
`android/app/build.gradle` (`versionCode 1900`, `versionName "0.19.0"`), the four `MARKETING_VERSION` lines in
the iOS project and the two in `apps/mobile/scripts/ios-project.mjs`.

Legion: `npm run build` exit 0, `npx tsc --noEmit` exit 0.

## 3. Linux gate (branch-test-linux, 2 processors, 3 GB, Ubuntu 24.04)

Script: `~/rel019-linux.sh` on that machine, run detached under `flock -o -w 7200 /tmp/branch-linux.lock`;
logs and a progress file in `/tmp/rel019/`. Worktree `~/wt/rel019` at e08c98e4, fresh `npm ci` and build.

| Item | Result |
| --- | --- |
| desktop tests (xvfb, concurrency 1) | (pending — first attempt failed on the machine's `chrome-sandbox` setup, see below) |
| full suite (concurrency 2, no desktop/screen-control) | 4295 tests, 4251 pass, 42 skipped, **2 timed out on my own 300 s cap** (2 h 43 m) — re-run without the cap, see below |
| chaos, `BRANCH_CHAOS_SEEDS=200` | **PASS** — 4 tests, 4 pass, 0 fail, 1 h 47 m |
| install-torture, `BRANCH_INSTALL_SEEDS=200` | (pending) |

**Harness step, not a product fault.** The first desktop run exited after 8 seconds with
`Error: Process failed to launch!` on five files. A fresh `npm ci` brings a fresh Electron, whose
`chrome-sandbox` is not root-owned, which Ubuntu 24.04 requires — the same `sudo chown root … && sudo chmod
4755 …` step `docs/configuration.md` tells a person to run. The 0.18.1 round hit exactly this and re-ran.
Applied here, and the desktop files are re-run afterwards.

## 4. macOS (TK-1, Node 26.5)

Worktree `/Volumes/512GB SSD/branch-wt/release-019` at e08c98e4, `npm ci`, then `npm run build`
(exit 0) and `npx tsc --noEmit` (exit 0). Suite: every `tests/*.test.mjs` except `desktop*` and
`screen-control`, plus `packages/sdk/test/sdk.test.mjs`, at concurrency 2. Logs in `~/rel019-mac/`.
`tests/mac2-desktop-ui.test.mjs` was kept: it drives headless Chromium against the local server and opens
no window.

**PASS with one flake: 4295 tests, 4275 pass, 1 fail, 19 skipped, 14 min 11 s.**

The one failure is `tests/fly-core-real-eval.test.mjs` → *R1 --dry-run runs both arms against throwaway
Branch copies and says the numbers mean nothing*, at line 63:
`with it on, the second pass uses what the first taught it` (`advicePerTask` for the second pass was 0).
It does not reproduce: the file passes on its own, and all four `fly-core*` files together at
concurrency 2 passed three times out of three straight after. Load-sensitive, not a product fault as far
as this run can show — worth handing to whoever keeps the flake list, since it is a *value* that came back
0 rather than a timeout.

## 5. Windows

CI covers the suite on `windows-latest` in six shares. On top of that, the packaged desktop tests are run on
Legion over `ssh mac-mini-tk1 ssh legion-branch` (session 0, no visible window), not through
`desktop-bridge.ps1`, which is the visible session. Separate worktree
`C:/Users/bishi/Code/wt/release-019-win` at d86268fb (same code as e08c98e4), own `npm ci` and build.

**PASS: 8 tests, 8 pass, 0 fail, 34 s** (`tests/desktop.test.mjs`, `desktop-export`, `desktop-identity`,
`desktop-settings`, concurrency 1). Log on Legion:
`C:/Users/bishi/AppData/Local/Temp/claude-session-files/rel019-win-desktop2.log`.

The first attempt showed 3 pass / 3 whole-file failures with no test output: `npm ci` had not fetched the
Electron binary yet, so the files that started while it downloaded could not launch. Harness, not product —
each of those files passes on its own and all four pass together on the re-run.

## Not run here, and why

- **The real-update test** (`docs/agents/real-update-test.md`) needs published 0.19.0 downloads, so it can
  only be run after the tag. It is the coordinator's step, and 0.19.0 is the first release whose *previous*
  version (0.18.1) has the fixed updater, so this is the first honest run of it.
- **CI green twice** — the coordinator's, after the merge.

## Waiting on trunk, not in the notes

`mac7/speed` is unmerged, so nothing of it is described in the 0.19.0 notes. Its builder has a ready
paragraph at the bottom of `docs/agents/STATUS-speed.md` on that branch ("Doing more in one go", which
ships off; plus unswitched fixes, including a task that runs out of rounds giving its best answer, and a
new Settings → Advanced field *Times one task may go back to the model*, empty meaning 12). If an
integrator merges it into trunk before the tag, that paragraph should be folded in — keeping its two
conditions: the numbers were measured against a stand-in for the model where they were, not a live one,
and no wall-time percentage is claimed.

Its builder has since corrected that draft (2026-09-20): **do not use the "the model only sends one tool
call a turn" claim** — on the real plan model Branch already batches (23 of 95 rounds carried more than
one call). The defensible story is the exchanges spent just *finding* a tool (27 of 95 rounds on the real
model), and the unswitched fixes for it: no toolbox can take every place, a tool arriving part-way through
no longer pushes another off, and a tool found comes with its inputs. Read the branch's own status file
rather than this summary before writing anything.
