# STATUS: prepare 0.19.0 and run the owner's release gate (mac7/release-019)

Agent: Claude (Legion), 2026-09-19. Worktree `C:/Users/bishi/Code/wt/release-019`, branch `mac7/release-019`,
cut from trunk `mac/cross-platform` at **d7e7de13**. Version-bump commit: **e08c98e4** — every gate below
ran on e08c98e4 unless it says otherwise.

Nothing here is tagged, published or merged into trunk. That is the coordinator's, after CI is green twice.

**Heads.** Every gate result below was measured on **e08c98e4** (trunk `d7e7de13` plus the version bump).
Trunk then moved to **f9499e4f**, which is merged into this branch as **f90751b7** (version still 0.19.0,
`npm run build` and `npx tsc --noEmit` both exit 0 on it). Of everything trunk added after d7e7de13, only
two commits touch product code: `d8da7f4e` fix(git) — path rules written without a lookahead the ChatGPT
endpoint refuses — and `125fde48` fix(x-search) — switching it on no longer leaves the assistant with no
tools. The rest is test and `public/*.js` flake work. Re-run on the merged tree f90751b7 (Legion):
`wire-safe-patterns`, `git`, `personal`, `personal-connectors`, `static-assets`, `index-structure`,
`handbook` — **54 tests, 54 pass, 0 fail**. Neither fix touches the engine kill/restart paths or the
installer, so the chaos and install-torture rounds are not affected by them.

**Second re-merge (2026-09-20).** Trunk moved again to **b84c702e**, which carries the `mac7/speed`
merge (`b59804bd`), three landed batches and a NUL-byte fix. Merged into this branch as **34d27bb5**:
`npm ci`, an empty `dist`, `npm run build` and `npx tsc --noEmit` all clean, version still 0.19.0 with
no `0.18.1` anywhere. Targeted re-run on it (Legion, concurrency 2): `speed`, `wire-safe-patterns`,
`git`, `personal`, `personal-connectors`, `static-assets`, `index-structure`, `handbook`,
`coding-next`, `walk-rules` — **179 tests, 179 pass, 0 fail**. The Linux and macOS whole-suite,
chaos and install-torture numbers above are still the e08c98e4 ones; they have not been re-run on
34d27bb5, and CI on trunk is what covers the rest of the suite for the speed merge.

The notes now carry the speed work with the coordinator's corrected numbers (14 of 30 → 1 of 30 with
the switch on, the 1-of-30 being the tools-in-front part alone; the share-out alone 17 → 14, with the
17 named as a pre-branch figure never re-measured on the built branch; `rename` 9 → 4 and `fix-range`
6 → 4; measured against a stand-in for the model). The withdrawn "lifts the worst request off the
floor" claim is not in them. Its three integration-review security fixes are in the safety section.
An HTML comment in the notes holds a slot for the two things still landing (three more tools that
named no target — `knowledge.manage`, `research.run`, `channels.broadcast` — and the brand marks
coming out of Accounts, Secrets, Models and the channel cards); their wording is deliberately not
invented yet.

- [x] 1. Version 0.19.0 everywhere (e08c98e4)
- [x] 2. Release notes `docs/agents/briefs/release-notes-0.19.0.md` (verification section left as a placeholder)
- [x] 3. Linux gate on `branch-test-linux`: desktop tests (xvfb, one at a time), full suite, chaos 200 seeds, install-torture 200 seeds
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
| desktop tests (xvfb, concurrency 1) | **PASS on the re-run** — 8 tests, 7 pass, 1 skip, 0 fail, 2 m 36 s (first attempt failed on the machine's `chrome-sandbox` setup, see below) |
| full suite (concurrency 2, no desktop/screen-control) | **PASS** — 4295 tests, 42 skipped, 0 product failures (2 h 43 m); the only 2 non-passes were my own 300 s per-test cap and both pass without it, see below |
| chaos, `BRANCH_CHAOS_SEEDS=200` | **PASS** — 4 tests, 4 pass, 0 fail, 1 h 47 m |
| install-torture, `BRANCH_INSTALL_SEEDS=200` | **PASS** — 22 tests, 22 pass, 0 fail, 3 h 07 m |

**Harness step, not a product fault.** The first desktop run exited after 8 seconds with
`Error: Process failed to launch!` on five files. A fresh `npm ci` brings a fresh Electron, whose
`chrome-sandbox` is not root-owned, which Ubuntu 24.04 requires — the same `sudo chown root … && sudo chmod
4755 …` step `docs/configuration.md` tells a person to run. The 0.18.1 round hit exactly this and re-ran.
Applied here, and the desktop files are re-run afterwards.

### The two that hit my 300 s cap

`tests/auth-tracing-cli.test.mjs` → *C1 every command Branch knows has help of its own, and asking never
does the work*, and `tests/settings-grown.test.mjs` → *S4 Settings search finds every one of the 530
settings, at any level*, both ended on `test timed out after 300000ms`. The cap was mine: CI's own Linux
run (`xvfb-run -a npm test --shard=…`, `scripts/run-tests.mjs`) sets no `--test-timeout`, so nothing there
stops them. Re-run on the same machine and commit with no cap: **46 tests, 46 pass, 0 fail** — C1 took
3 m 02 s and S4 5 m 24 s on this 2-processor box (29 s and 54 s on the Mac). Machine speed, not the product.

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

**The Windows suite has not run against this tree.** `.github/workflows/checks.yml` fires on pushes to
`main`, `wave2/integration`, `release/**`, `mac/**`, `mac2/**`, `mac5/**`, `mac6/**` and `wave9/**`, and on
pull requests — `mac7/**` is not in that list, and `gh run list --branch mac7/release-019` is empty. CI's
six Windows shares will cover it the moment this lands on trunk (or through a PR), which is the
coordinator's "green twice". What *was* run on Windows is below. On top of that, the packaged desktop tests are run on
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
- **CI green twice** — the coordinator's, after the merge. No Checks run exists for `mac7/release-019`
  at all (see section 5), so nothing on Windows beyond the four packaged desktop files has been run
  against the 0.19.0 tree here.
- **The version was re-checked on the final head** (`ec06ee62`): no `0.18.1` left in `package.json`,
  either lock, the three plugin manifests, `build.gradle`, the iOS project or `ios-project.mjs`.
- **Test file lists**: both the macOS and Linux suites are a superset of `docs/agents/scripts/verify.sh`
  — they exclude only `tests/desktop*` and `tests/screen-control`, so `mac2-desktop-ui` (headless
  Chromium), `background-screen` (a fake runner) and `posix-desktop-script` (writes scripts, runs none)
  were included. Nothing opened a window on the owner's Mac.

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
