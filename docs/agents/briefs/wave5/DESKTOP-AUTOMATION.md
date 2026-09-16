# Wave 5 task: careful desktop automation on Windows

Rules: docs/agents/briefs/wave1/BUILD.md. Branch: wave5/desktop from the local branch wave2/integration. Theme: desktop-automation (#77, 15 pieces). Backend tools with strict gating; a small additive Settings card. Absolutely no automated clicking or typing during your own tests on this machine except inside a window your test created (Notepad launched by the test is acceptable and must be closed by the test); never run tests/desktop*.test.mjs.

Read: src/integrations/shell*.ts, src/integrations/process-usage.ts, src/policy.ts (approval policy; desktop actions must be "ask" by default), src/artifacts.ts, src/integrations/browser.ts (screenshot artifact pattern), src/contracts.ts.

Build (PowerShell + .NET through the existing shell runner, no dependency; every tool records an artifact/receipt and goes through the approval gate as a changing action; a per-run cap on actions):
1. `desktop.screenshot { display?, window? }` — whole screen or one window (by title match) to PNG via System.Drawing; password-manager and lock-screen windows are refused by title/class allowlist; the picture becomes an image part when the model accepts images.
2. `desktop.windows { action: list|focus|minimize|close }` — via user32 through Add-Type; close asks.
3. `desktop.read { window }` — UI Automation tree (names, roles, values) for a window as structured text, bounded, so the model can act on text rather than pixels.
4. `desktop.click { window, name | point }`, `desktop.type { text }`, `desktop.key { chord }` — UI Automation Invoke/SetValue first, coordinates second; each asks unless the approval preset allows; typing never carries secret references; a global "stop" (Esc held or `POST /api/runs/:id/cancel`) stops the sequence within 500 ms.
5. `desktop.open { app | path }` — Start-menu app names or workspace files with the default app; `desktop.clipboard { action: read|write }` gated separately.
6. Safety: a visible on-screen banner (small always-on-top window) while the assistant controls the desktop, with a Stop button; a settings switch "Allow the assistant to use my screen and keyboard" that is off by default and must be on for any of this; every action logged with the window title.

Tests (tests/desktop-automation.test.mjs; create and drive a Notepad window only): screenshot of the Notepad window is a PNG artifact; windows list contains it; read returns its edit control; type into it via UI Automation and read back; close it; approval gate asks when the preset is "Ask before changes"; the switch off → every tool refuses with a plain sentence; action cap; refused titles (a fake window titled "Bitwarden" created by the test) are never captured.

Acceptance: D1 switch off by default and enforced; D2 approval gate proven; D3 UI Automation read/type proven on Notepad; D4 banner with Stop exists (screenshot of it in your report); D5 docs section with a candid list of what it cannot do; D6 no new dependency. Report the ids you consider done.
