# mac1/service-update: starting by itself, and updating itself, on macOS and Linux

Rules: docs/agents/briefs/mac1/BUILD-MAC.md. Area name: `service-update`.

**You own:** `src/install/daemon.ts`, `src/install/installer.ts`, `src/install/windows.ts` (read only
unless a shared helper must move), `src/desktop/hand-over.ts`, `src/desktop/updater.ts`, `src/doctor-fix.ts`,
a new `src/install/launchd.ts`, a new `src/install/systemd.ts`, a new `src/desktop/release-assets.ts`,
and their tests (`tests/daemon-update.test.mjs`, `tests/deployment.test.mjs`, new `tests/service-update.test.mjs`).

**Build:**
1. `branch daemon install|uninstall|status` on macOS writes `~/Library/LaunchAgents/com.keepoak.branch-agent.plist`
   (RunAtLoad, KeepAlive on crash only, no window, logs under the data folder) and loads it with
   `launchctl bootstrap gui/<uid>`; uninstall uses `bootout` then removes the file; status uses
   `launchctl print`. On Linux it writes `~/.config/systemd/user/branch-agent.service` and runs
   `systemctl --user daemon-reload|enable --now|disable --now|is-enabled`. Same report shape and
   plain-language messages ("when you sign in to your Mac" / "when you sign in"). Windows unchanged.
   The path of every file is injectable so tests write into a temp folder; commands go through the
   injected runner and are asserted exactly.
2. Release asset names in one module, `src/desktop/release-assets.ts`:
   `Branch-Agent-windows-x64.zip` (unchanged, the updater on owners' PCs looks for it by exact name),
   `Branch-Agent-macos-arm64.zip`, `Branch-Agent-macos-x64.zip`, `Branch-Agent-linux-x64.tar.gz`,
   each with `<name>.sha256`. A function picks the name for `(platform, arch)` and returns null for
   anything else. The packaging brief uses these exact names.
3. The updater on macOS and Linux: download the right asset, verify the checksum, unpack beside the
   install, then hand over through a detached process with no terminal window (`spawn` with
   `detached: true, stdio: "ignore"`, then `unref`) that waits for the old process id to exit (bounded,
   then SIGTERM, then SIGKILL), swaps the app folder (macOS: the `.app` bundle; Linux: the unpacked
   folder), keeps the previous copy as `<name>.previous`, and relaunches (`open -n <app>` / the
   executable). Keep "Automatic updates are available on Windows only." out of macOS/Linux; when the
   running copy is not a packaged app (running from source), say so in plain words instead of failing.
   Windows hand-over (wscript + schtasks, zero console windows) stays byte-for-byte in behaviour.
4. `doctor --fix` items that are Windows-shaped: give each a macOS/Linux branch or an honest
   "not needed on this computer".

**Tests:** plist and unit contents; exact launchctl/systemctl argument arrays; asset name table for
every (platform, arch) incl. null; hand-over script/plan on each platform with a fake pid and fake
folders (never launch a real app); updater picks the asset and refuses a bad checksum.

**Acceptance:** M1 (service), M1 (updater); bucket 22 row `family: platform-support` partially.
