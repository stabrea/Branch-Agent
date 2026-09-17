# mac2/desktop-ui: the Stop banner, voice and permission screens on macOS and Linux

Area `desktop-ui`. Read `docs/agents/briefs/mac2/README.md` (wave mac1 desktop-os is now merged; its files are free,
but `src/integrations/job-object.ts` & co. still belong to mac1/processes).
**You own:** `src/desktop-banner.ts`, `src/voice-service.ts`, `src/voice.ts`, `src/voice-api.ts`, `public/voice.js`,
new `public/os-permissions.js` (add to the static allowlist in `src/server.ts`), `src/integrations/desktop-script.ts`
(only the `enabled` switch), a small Keychain settings route (new file, one route block), and tests.

1. **Stop banner on macOS and Linux**, same promise as Windows: while Branch controls the screen, an always-on-top
   notice with a Stop button is visible and stops the task at once. On macOS use the app's own Electron window when the
   desktop app is running (a small frameless always-on-top BrowserWindow, created by the main process on request);
   the headless/CLI case refuses screen control with a plain sentence. Linux the same through Electron. Only when the
   banner is really shown may `desktop-script.ts` enable screen control on that platform. Tests with fakes; never show a
   real window on this Mac (the Electron part is covered by an injected window factory).
2. **Voice:** give `VoiceService` the platform, program runner and program lookup as inputs (tests must never start
   the real `say`); owner-facing words become "your computer's own voice" (Windows keeps its current wording);
   `public/voice.js` shows the system voice list on every platform (the API key stays `windows` for compatibility,
   add a neutral alias `system`).
3. **Permissions screen:** a plain card in Settings that reads `/api/os-permissions` and shows each item with its
   explanation and an "Open System Settings" link on macOS (deep link opened through the existing safe opener only
   when the owner clicks); on Linux shows the session type; Windows unchanged.
4. **Keychain entries:** a Settings route and small form to list which Keychain entries Branch may read (names only,
   never values), off by default, same rules as the password-command list.
