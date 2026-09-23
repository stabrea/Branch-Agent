## What changed in 0.19.3

**Beta finds new builds as soon as they are published.** For a while after a Beta was published, GitHub's list of releases could still show it without its downloads, so Check for updates on the Beta channel said the download was missing. Branch now asks that release for its own files when the list lags, and if a Beta really is still unfinished it offers the newest complete one instead of an error. Downloads are still checked against their published checksums, and only files from that exact release are accepted.

**Uninstalling on Windows removes Branch, and only Branch.** The Windows uninstaller now removes the installed folder, its previous version, its shortcuts and, when asked, its data, even when your account folder has a space, `&`, `^`, `!`, `%` or `'` in its name, and even when Windows command settings on this computer differ from the defaults. Before this, some account names made it leave the installed folder behind and point the removal at a differently named folder. You can uninstall Branch on Windows again.

**Updating on Windows opens no window.** Handing over to the new version runs hidden, including on computers where the scheduled task cannot be created, and two quick presses of Update are one update, not two.

**Limits.** Windows builds remain unsigned. Automatic installation still waits while tasks are running or waiting for an answer, as in 0.19.2; it does not yet cover every kind of background activity.

**Install**
In an existing desktop installation, open **Settings → Updates & about → Check for updates**. Beta stays an opt-in choice on that same page.

For a new Windows installation, download `Branch-Agent-windows-x64.zip`, its `.sha256` file and `Install Branch Agent.cmd` into the same folder, then run the installer. macOS and Linux use `install-branch-agent.sh`. Downloads are checked against their published checksums before installation.
