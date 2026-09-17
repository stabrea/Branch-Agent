# mac2/followups: finish the macOS/Linux loose ends from wave mac1

Area `followups`. Read `docs/agents/briefs/mac2/README.md`.
**You own:** `src/install/background-engine.ts`, `src/deployment-api.ts`, `src/desktop/main.ts` (install-root logic only),
`src/desktop/updater.ts` + `src/desktop/updater-ipc.ts` (messages and install-target only), `scripts/release-notes.mjs`,
their tests, and `docs/CHECKPOINT.md` is NOT yours.

1. `background-engine.ts` still calls `taskkill` everywhere: on macOS/Linux ask the engine to close over its own
   local API, then SIGTERM, then SIGKILL on its recorded pid, bounded; no 12-second pause. Windows unchanged.
2. `deployment-api.ts` shows "Branch Agent daemon" everywhere: use plain per-platform wording
   ("starts by itself when you sign in to your Mac" etc.). Add a test for the macOS engine script path
   (`Contents/Resources/app/dist/cli.js`).
3. One way to work out where the app is installed: make `main.ts` and `updater-ipc.ts` use the same function
   (`installTarget` or a new shared one), tested for win32/darwin/linux layouts.
4. `scripts/release-notes.mjs` takes download names from `release-assets.ts`; extend the name-drift test to cover it.
5. Updater message: a packaged Mac app outside a `.app` bundle must not be told it is "running from source".
6. The Settings model list: the ChatGPT models are now gpt-5.6-sol (light, first), gpt-5.6-terra, gpt-5.6-luna,
   gpt-5.5 (e2d8d61). Check every place the UI, docs/configuration.md or tests mention gpt-5.4 or plain gpt-5.6 and fix them.
