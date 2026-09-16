# Wave 3 task: browser automation that a non-technical owner can trust

Rules: docs/agents/briefs/wave1/BUILD.md. Branch: wave3/browser from the local branch wave2/integration. Theme: browser-automation (#62, 26 pieces) plus the browser items in desktop-automation (#77) that are about screenshots. No UI restructuring (the shell was just redesigned); a small additive "Browser" settings card is fine.

Read: src/integrations/browser.ts (Playwright-based BranchBrowser: navigate/snapshot/click/fill under the network policy and origin rules), src/network-policy.ts, the approval policy (src/policy.ts, browser action approval), tests/browser.test.mjs.

Build:
1. Persistent, named browser profiles: `browser.profile { action: list|create|remove|use }` storing Playwright storage state (cookies, localStorage) encrypted with the existing locker key under the data dir; a "Sign in once" flow where the owner opens a headed window, signs in by hand, and the state is saved — the assistant never sees the password. Profiles are chosen per run; default stays a fresh profile.
2. Screenshots and vision input: `browser.screenshot { fullPage?, selector? }` returns a PNG (bounded size, stored as a run artifact with a receipt) and, when the active model accepts images (OpenAI-compatible vision or Anthropic), the runtime can pass it to the model as an image part; otherwise the accessibility snapshot is used. Add the image-part plumbing to the provider layer if absent (OpenAI `image_url` with data URL; Anthropic base64 image block), behind a size cap.
3. File upload and download: `browser.upload { selector, path }` from the workspace only; downloads land in a `downloads/` folder inside the workspace with a receipt; both honour confinement and `.branchignore`.
4. Wait and extract: `browser.wait { text | selector | networkIdle, timeoutMs }`, `browser.extract { selector, fields }` returning structured rows (tables and repeated cards) with a size cap; `browser.pdf` for the current page.
5. Tabs and frames: open/switch/close tabs, iframe scoping, dialog handling (auto-dismiss with a recorded event; alert text surfaced).
6. Safety: every action still goes through the network policy and the approval policy; a per-run cap on actions and on distinct origins visited with a plain-language stop; downloads limited by size and type; screenshots redact fields marked type=password before capture.

Tests (tests/browser-more.test.mjs, headless Chromium already in devDependencies; local static pages served by node:http): profile save/restore keeps a cookie across sessions; screenshot bytes are a PNG and the receipt exists; upload reaches the page and a download lands in downloads/ with confinement enforced; wait/extract on a table; tab switching; dialog auto-dismiss recorded; origin cap stops the run with the expected message; password field redaction (pixel check of the region or DOM masking before capture).

Acceptance: W1 profiles encrypted at rest (test reads the file and finds no cookie value); W2 screenshot → model image part proven with a fake vision provider; W3 upload/download confined; W4 extract returns rows; W5 caps and approvals proven; W6 docs section; W7 no new dependency beyond the existing Playwright. Report which audit ids (browser-automation section of docs/audit/todo.md) you consider done.
