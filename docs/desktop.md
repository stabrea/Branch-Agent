# Branch Agent desktop

The native client shares the runtime and interface with the local web application. It starts a loopback service, opens an authenticated Electron window, and keeps scheduling active when the window is hidden to the tray.

## Run and package

```sh
npm ci
npm run desktop
npm run package:desktop
```

The portable Windows folder is `release/Branch Agent-win32-x64/`; launch `Branch Agent.exe` inside it. Keep the whole folder together. Packaging is unsigned and does not install shortcuts, a startup service or automatic updates. Those distribution capabilities remain on the feature inventory.

Electron is a development dependency because it supplies the native window, platform tray and bundled runtime. Electron Packager creates the distributable directory. Fontsource packages supply locally bundled typefaces; each font's license accompanies it. The package includes only runtime files, public assets, production dependencies, package metadata and notices.

## State and configuration

Desktop private state and workspace default to separate `state` and `workspace` subdirectories beneath Electron's user-data directory for Branch Agent. `BRANCH_DATA_DIR` and `BRANCH_WORKSPACE` override them. Model connections can be saved in Settings with device-protected keys; explicit `BRANCH_PROVIDER` environment configuration takes precedence. See [configuration.md](configuration.md) for model, key-recovery and integration behavior.

`BRANCH_DESKTOP_HOME` can select a separate Electron profile, for example for an isolated evaluation. Profiles contain UI caches and the default state location. Do not point two running applications at the same data directory.

Forest/Daylight preferences live in the application database, so they survive service port changes and app restarts. The renderer cannot read Node APIs or the session-token file. The main process adds authorization only to the local window's API requests.

## Sign-in and updates

`chatgpt-auth.json` in the user data folder holds the ChatGPT sign-in, encrypted with Electron `safeStorage`. The renderer only ever receives sign-in status, never tokens. Updates run in the main process (`updater.ts`): the GitHub release archive is downloaded to the temp folder, verified against the published SHA-256, expanded with PowerShell, and applied by `apply-update.cmd` after the app exits. The renderer may open only `https://auth.openai.com/` and the project's GitHub pages through `branch:open-external`.

## Verification boundary

The native test exercises a task that writes and verifies a file, checks renderer isolation, blocks navigation to a real local server outside the permitted origin, checks that tokens are absent from URL/HTML/session storage, changes appearance across reload and process restart, hides the window to tray, and verifies the process and loopback listener stop on quit.

The offline provider is deterministic. A working native shell does not establish live model access, a signed installer, automatic updates or complete capability parity.
