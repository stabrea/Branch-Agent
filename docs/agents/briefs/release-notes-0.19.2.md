## What changed in 0.19.2

**Choose Stable or Beta.** Updates & about now lets the owner choose a release channel. Stable stays the default. Beta offers newer, tested preview builds as they are published, so you can follow development without installing Git or building the app yourself. Returning to Stable waits for a newer Stable release; it does not silently downgrade your installation.

**Check for progress more often.** Automatic updates remain off until you enable them. With automatic checks enabled, Beta looks every five minutes while the desktop app is open; Stable checks daily. Check for updates still works on demand. Publication, downloading and installation take additional time; five minutes is the checking interval, not a guaranteed delivery time.

**Wait for current tasks.** Automatic installation waits while tasks are running or waiting for an answer. The desktop app checks readiness again before handing over, retries a waiting update, and refuses overlapping installation attempts. This release does not claim that every possible background activity or new-task race has been proven interruption-free.

**Keep the two release channels separate.** Beta builds are prereleases and do not replace the latest Stable download. The publishing checks tie downloads to accepted source commits and require the expected archives and checksums before making a release visible. A merged pull request is not downloadable until its build finishes and is published.

**Fixed.** Pending updates are checked again after a restart; an installation cannot start a second hand-over while the first is still pending; short-lived access keys cannot use owner-only update controls.

**Limits.** This is the channel bootstrap release, not a claim of finished Grown-Up design parity. A newer Beta must be published before the Beta channel can offer another update. Windows builds remain unsigned. The separately tracked Windows uninstaller fix is not included here; do not uninstall Branch on Windows until that fix is released.

**Install**
In an existing desktop installation, open **Settings → Updates & about → Check for updates**. After installing this release, choose **Beta** on that same page if you want preview updates. Selecting Beta does not enable automatic installation; that remains a separate owner choice.

For a new Windows installation, download `Branch-Agent-windows-x64.zip`, its `.sha256` file and `Install Branch Agent.cmd` into the same folder, then run the installer. macOS and Linux use `install-branch-agent.sh`. Downloads are checked against their published checksums before installation.
