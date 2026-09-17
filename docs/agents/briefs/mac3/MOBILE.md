# mac3/mobile: Branch on iPhone and Android (built, never published)

Area `mobile`, branch `mac3/mobile` from `mac/cross-platform`. Rules: `docs/agents/briefs/mac1/BUILD-MAC.md`,
`docs/agents/briefs/mac2/README.md` (three-way switches off by default; no waiting for the owner; licences),
`docs/places.md` and `docs/design.md` (the redesigned window is the look). **Nothing is uploaded anywhere: no App
Store, TestFlight, Play Store, F-Droid submission, no GitHub release.** Build install-ready files only.

The owner decided the "companion apps" rows are no longer declined. Branch already reaches a phone through the
paired address and the installable web page (`src/remote/*`, pairing, Tailscale); the apps are proper native
shells on top of that.

**You own:** a new `apps/mobile/**` folder with its own `package.json` (dependencies there only, never in the root
package), `scripts/package-mobile.mjs`, `.github/workflows/mobile.yml` (build only, artifacts only, never publish),
`tests/mobile*.test.mjs`, and a "Phone apps" section in `docs/configuration.md`.

1. **Stack:** Capacitor (MIT) around Branch's own web app, so the redesign, themes and every screen are the same on the
   phone. Justify the dependency in your report (Capacitor is the smallest way to one codebase for both platforms).
   Study OpenClaw `apps/ios` and `apps/android` (MIT) in `/Users/taofikbishi/Code/agent-refs/openclaw` for what a
   phone companion needs; borrow with notices.
2. **What the app does:** pair with the owner's Branch by scanning the pairing code or pasting the address (existing
   pairing flow), then shows the full window from that Branch; keeps the session key in the phone's secure storage
   (iOS Keychain / Android Keystore); locks with Face ID / fingerprint (switch, off by default); share sheet "Send to
   Branch" for text, links, pictures and files; voice button using the existing live-voice route; notifications when
   a task needs you (local polling now; push needs store accounts later — build the code path behind a switch and
   document the account step). Works with the phone on the owner's Tailscale or home network; refuses plain http to
   anything but a private/Tailscale address.
3. **Build outputs** (in `release/mobile/`, never committed):
   - iOS: a Simulator build tested with `xcrun simctl` (boot headless, install, launch, screenshot — do not open the
     Simulator app window), and an unsigned `Branch-Agent-ios.ipa` suitable for Sideloadly/AltStore (the person's
     free Apple ID signs it). Document the paid-account path (TestFlight/App Store) as steps only.
   - Android: `Branch-Agent-android.apk` (release, signed with a local keystore generated into
     `~/.branch-mobile-keystore/` — never committed, password generated and stored in the macOS Keychain via
     `security add-generic-password`, never printed), plus an `.aab` for Play later; F-Droid metadata file
     (`apps/mobile/fdroid/`) so it can be submitted later from source. Verify with an Android emulator headless
     (`emulator -no-window`) — install, launch, screenshot.
   - `.sha256` next to each.
4. **Android tooling on this Mac:** install what's needed with Homebrew (`openjdk@17`, `android-commandlinetools`) and
   `sdkmanager` (platform, build-tools, one system image for the emulator). Justify sizes in the report. Xcode 26.6 is
   already installed.
5. **Tests:** unit tests for the pairing/URL rules and secure-storage wrapper; a build test that skips cleanly when the
   SDKs are missing; the CI workflow builds both on macOS and Linux runners and uploads artifacts (7 days) only.
