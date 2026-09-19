# The real update test — run it before every release

Installs the release before the new one on a test machine the way a person would, puts real work in
it (a conversation, a changed setting, a memory, a schedule), presses the app's own **Update and
restart** button over its DevTools port, and checks what the person is left with. Then it breaks the
update on purpose, once each way. Everything runs in throwaway folders; nobody's real Branch, data,
`~/.claude`, `~/.codex`, `~/.hermes` or `~/.openclaw` is touched. Never run it on the owner's Mac.

Files, all in `docs/agents/scripts/`:

- `real-update-test.mjs` — the driver (launch, plant, update with an optional fault, verify, quit).
  Runs on the test machine next to `playwright-core`.
- `real-update-linux.sh` — Linux runner for `branch-test-linux`.
- `real-update-windows.ps1` and `drop-connection.ps1` — Windows runner for `legion-branch`.

## Linux (`ssh branch-test-linux`)

```sh
scp docs/agents/scripts/real-update-{test.mjs,linux.sh} branch-test-linux:/tmp/
ssh branch-test-linux 'mkdir -p /tmp/ru/driver && cp /tmp/real-update-* /tmp/ru/driver/ &&
  sh /tmp/ru/driver/real-update-linux.sh setup v0.18.0 v0.19.0'
for s in normal-stock normal corrupt drop kill-switch installer; do
  ssh branch-test-linux "flock -o -w 7200 /tmp/branch-linux.lock sh /tmp/ru/driver/real-update-linux.sh run $s"
done
ssh branch-test-linux 'sh /tmp/ru/driver/real-update-linux.sh clean'
```

Set `FROM_VERSION` / `TO_VERSION` in the environment when they are not 0.17.0 / 0.18.0.

## Windows (`ssh legion-branch`)

```sh
ssh legion-branch 'mkdir C:\ru\driver'   # from cmd; Git Bash eats backslashes, use C:/ru/driver there
scp docs/agents/scripts/{real-update-test.mjs,real-update-windows.ps1,drop-connection.ps1} legion-branch:/C:/ru/driver/
ssh legion-branch 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/ru/driver/real-update-windows.ps1 setup v0.18.0 v0.19.0'
for s in normal corrupt drop kill-switch installer installer-open; do
  ssh legion-branch "powershell -NoProfile -ExecutionPolicy Bypass -File C:/ru/driver/real-update-windows.ps1 run $s"
done
ssh legion-branch 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/ru/driver/real-update-windows.ps1 clean'
```

It runs over plain SSH (the app starts without a visible window there; the relaunched version
appears on the signed-in desktop). The owner may have a real Branch open on Legion: the runner only
ever stops processes started from `C:\ru\w`, and the installer is always given `--install-root`,
`--start-menu`, `--desktop`, `--uninstall-hive HKCU\Software\BranchRealUpdateTest` and `--user-data`
under `C:\ru\w`. `clean` removes that registry key.

## Scenarios and what passing means

| Scenario | What happens | Passes when |
| --- | --- | --- |
| `normal` | Update button, nothing interfered with | The engine reports the new version; all four planted things are unchanged; it starts again after a restart with them still there |
| `corrupt` | 22 bytes of the half-downloaded file are changed | The app says the download did not match its checksum, stays open on the old version, restarts on it with the work intact |
| `drop` | The app's own HTTPS connections are reset mid-download | Same as `corrupt`, and the message is in plain words |
| `kill-switch` | The hand-over script (and its copy) is killed the moment it starts copying files | The program folder still holds one whole version that starts, with the work |
| `installer` | The next release's one-step installer over the closed old one | One copy, the new version, the work intact |
| `installer-open` (Windows) | The same with the old one still open | Branch is closed through its own route, or the installer says in plain words that it is open and changes nothing |
| `normal-stock` (Linux) | Update with no help at all on Ubuntu 24.04 | See below |

Two things the harness does that a person would not, both printed in the output:

- **Linux:** Ubuntu 24.04 needs Chromium's sandbox helper made root's (`sudo chown root chrome-sandbox
  && sudo chmod 4755 chrome-sandbox`, docs/configuration.md). `fresh` does this for the old version as
  the docs tell a person to. In `normal`, a root helper pauses the hand-over and does the same to the
  new copy, because 0.17.0 and 0.18.0 cannot carry the helper over themselves. `normal-stock` is the
  honest run without that help. From the release after 0.18.0 the hand-over carries the helper over
  itself when the new one is identical, so `normal-stock` should pass and `normal` becomes redundant.
- **Windows:** the app starts its hand-over through the Task Scheduler, so the new version is opened
  with the signed-in person's environment and would open *their* Branch data. The driver adds the
  test's `BRANCH_DESKTOP_HOME` and `TEMP` to the lines of `apply-update.cmd` that start the app, and to
  nothing else.

Also look at what the runner prints under "on disk": the copies of the program (`.previous` is
intended; `.incoming` or `.failed` after a clean run is not) and how much the update left in the temp
folder.

## First run: 0.17.0 to 0.18.0, 2026-09-18

Linux (Ubuntu 24.04):

- `normal-stock` **failed, and left neither version working.** The new copy's sandbox helper was not
  root's, so 0.18.0 did not start; the hand-over then *copied* 0.17.0 back, which dropped the helper's
  root owner, so 0.17.0 did not start either. The work was untouched. Recovery: run the documented
  `sudo chown root … && sudo chmod 4755 …` on `chrome-sandbox` in the program folder again.
- `normal` (with the helper made root's) passed; 487 MB was left in the temp folder.
- `corrupt` passed (131 MB left in temp). `drop` passed, but the app said only "terminated".
- `kill-switch` passed: 0.17.0 intact; a whole `…incoming` copy was left beside it.
- `installer` kept the work but left **two copies** (the unpacked 0.17.0 folder and
  `~/.local/share/branch-agent/app`), and the new copy does not start its window on Ubuntu 24.04 until
  the sudo step is run on it too; the installer says nothing about that.
- A portable copy (`portable.txt` beside the program): the update left the work in `….previous/Branch
  Data`, and 0.18.0 opened empty. The next update deletes that folder.

Windows (Legion):

- `normal` passed; 589 MB left in temp; the update deleted `Uninstall Branch Agent.cmd`, which
  Add or remove programs runs.
- `corrupt` passed. `drop` passed, but the app said only "terminated".
- `kill-switch` **failed, and left neither version working**: the new files had been mirrored
  straight over the program folder, so it held part of each and would not start. Recovery: run the
  0.18.0 one-step installer (with Branch closed), which writes every program file again.
- `installer` passed (one copy, `.previous` kept, work intact). `installer-open` failed with a raw
  `EPERM: operation not permitted, unlink …Branch Agent.exe`.

What branch `mac7/real-update` changes for the releases after 0.18.0 is in `tests/real-update.test.mjs`.
Updating *from* 0.17.0 or 0.18.0 still runs those versions' own updater, so their failures above stay
until a person is on a fixed version.
