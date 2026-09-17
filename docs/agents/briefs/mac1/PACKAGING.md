# mac1/packaging: a download for macOS and for Linux

Rules: docs/agents/briefs/mac1/BUILD-MAC.md. Area name: `packaging`.

**You own:** `scripts/package-desktop.mjs`, `scripts/prepare-icon.cjs`, `scripts/pack-cli.mjs`,
`scripts/dependency-notices.mjs`, new `scripts/package-macos.mjs`, new `scripts/package-linux.mjs`,
`.github/workflows/checks.yml`, a new `.github/workflows/package.yml`, `src/desktop/main.ts` (only for
macOS menu/dock/close behaviour), and new `tests/packaging.test.mjs`.

**Build:**
1. `npm run package:desktop` picks the platform. macOS: an `.app` bundle from the stock Electron
   (same approach as Windows: no repackaging tool, no new dependency), `Info.plist` with name,
   bundle id `com.keepoak.branch-agent`, version, icon (`.icns` made with `sips`/`iconutil`), and the
   microphone/screen usage descriptions; zipped with `ditto -c -k --keepParent` as
   `Branch-Agent-macos-<arch>.zip` plus `.sha256`. Linux: the unpacked folder with a `.desktop` file
   and icon, as `Branch-Agent-linux-x64.tar.gz` plus `.sha256`. Asset names exactly as in
   `src/desktop/release-assets.ts` from the service-update brief (write the same literals; the
   integrator will join them). Windows packaging unchanged.
2. Signing: when `APPLE_SIGNING_IDENTITY` is set, `codesign --options runtime` and notarise with
   `xcrun notarytool` (credentials from the environment, never logged); when it is not set, build
   unsigned and print one plain sentence saying macOS will warn on first open.
3. macOS app behaviour in `src/desktop/main.ts`: closing the window keeps the app in the dock,
   Cmd+Q quits, standard Edit menu so copy/paste works. Windows behaviour unchanged.
4. CI: in `checks.yml` run packaging on all three runners (upload the artifact, 7 days);
   `package.yml` on a tag builds the three downloads and attaches them to the release.
5. You may build the macOS package on this Mac to prove it, but **never open or launch the built app**;
   inspect it with `plutil`, `codesign -dv` and `ls`.

**Tests:** Info.plist content; asset names; the Linux `.desktop` file; the packaging plan per
platform with fake tools (pure functions), plus one real macOS build step guarded by
`skip: process.platform !== "darwin"` that only checks the bundle structure.

**Acceptance:** M1 (downloads); bucket 22 rows `family: desktop-packaging`, `family: distributions` partially.
