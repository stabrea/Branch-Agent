# Branch Agent checkpoint — 2026-09-15 (evening)

## Where things stand

The user's standing instruction: keep improving locally and publish to GitHub only at checkpoints
worth having; there are no live users besides the owner, who uses the packaged app and updates it
from **Settings → Updates**. Do not merge or release every batch.

- Worktree: `C:/Users/bishi/Documents/Codex/Branch-build`, branch `feat/assistant-runtime`.
- Remote: `https://github.com/stabrea/Branch-Agent.git`; PR #1 targets `main`.
- Published: https://github.com/stabrea/Branch-Agent/releases/tag/v0.2.0 (main merge b508f57; live updater check verified from 0.1.0 → available and 0.2.0 → current).
- 0.2.1 (fix): the ChatGPT backend rejects `max_output_tokens`, answers without a content-type
  header and sends `usage: null` in early events. Fixed and verified against the owner's real
  sign-in (streamed reply + real tool call). Provider error text is deliberately never persisted
  (see `tests/provider-retry.test.mjs`); do not add it to messages or events.
- The owner's app now runs from `C:/Users/bishi/AppData/Local/Programs/Branch Agent/` (copied
  from `release/`), so `npm run package:desktop` no longer fights the running executable. The
  in-app updater mirrors new releases into that folder.
- Smart App Control (state 1, enforcing on this machine) blocked the repackaged 0.2.1 executable while
  the stock Electron binary and the earlier 0.2.0 build ran. Packaging now ships the stock
  `electron.exe` as `Branch Agent.exe` (see docs/desktop.md); the update script keeps
  `<install>.previous` and rolls back if the new build does not start. Code signing (Azure Trusted
  Signing or an OV certificate) is the real fix; tracked under security (#12) and owner requests (#18).
- Version `0.2.1`. Release process: merge to `main`, tag `vX.Y.Z`, `gh release create` with
  `release/Branch-Agent-windows-x64.zip` and its `.zip.sha256`. The in-app updater reads
  `releases/latest` and requires both assets by exact name.
- The user wants the header mark to read **KeepOak** and the sidebar card to stay **Branch Agent**.
- Copy rule: plain language for non-technical people, no developer jargon in the interface.

## Tracking on GitHub

Nothing lives only in chat. Open work is tracked as checklists:

- Issues #2–#17: one per inventory family (`inventory` label), one checkbox per acceptance entry.
  Tick a box only when the criterion passes with a real fixture and the ledger is updated.
- Issue #18: the owner's direct requests (`owner-request` label).
- Regenerate `docs/features.md` with `branch-public-coverage.py` after ledger updates and mirror
  the change into the family issue with `gh issue edit`.

## Delivered this session

1. Skills batch shipped (coverage: `extensions.progressive`, `extensions.authoring` implemented).
2. Models: `src/models.ts` router with named presets, owner default, per-conversation override,
   thinking effort, ordered fallback with cooldowns, `model.selected` / `model.fallback` events,
   `models` in `/api/state`, `POST /api/models`, `GET|POST /api/sessions/:id/model`.
   `BRANCH_MODEL_PRESETS` JSON in the launch environment; keys via named variables only.
3. ChatGPT plan sign-in: `src/chatgpt-auth.ts` (device-code flow, vault, refresh sharing),
   `src/chatgpt-provider.ts` (Responses API, streaming, honest `originator: branch-agent`),
   `src/chatgpt-presets.ts` (registers `chatgpt-gpt-5.5|5.6|5.4`, prefers ChatGPT over the demo).
   Routes `/api/chatgpt/status|login|logout`; CLI `login`, `logout`; desktop vault under safeStorage.
4. Updates: `src/desktop/updater.ts` (GitHub latest release, SHA-256 verify, PowerShell expand,
   `apply-update.cmd` hand-over), `updater-ipc.ts` (+ allow-listed `open-external`), Settings card.
   CLI `update` refreshes a Git checkout. `package.json` has `bin.branch`.
5. UI: model controls above the composer, Models / ChatGPT account / Updates cards in Settings,
   plain-language demo notice, KeepOak header mark.

Coverage after this session: 26 implemented, 52 partial, 90 missing, 1 external (see
`docs/features.md`; ledger source in `../branch-build-research/coverage-assessment.json`).

## Verified

- Full suite before the desktop-bridge key update: 199 tests, 1 failure that was only the stale
  preload key list; that test now passes (`tests/desktop-settings.test.mjs` 3/3).
- New suites: `tests/models.test.mjs` 6/6, `tests/chatgpt.test.mjs` 6/6, `tests/updater.test.mjs` 4/4
  (the install test runs the real hand-over script against a scratch install folder).
- Function-length check: 0 bodies at or above 50 lines.
- ChatGPT sign-in was verified only against the local fake OpenAI fixture; the real device flow
  needs the owner to complete it once in the app. OpenAI's docs say device-code sign-in is a beta
  the user may need to enable in their ChatGPT security settings.

## Still unverified or pending

- The updater's end-to-end path against a real GitHub release (check → download → verify →
  restart) is unverified until a second release exists; the check step can be verified live once
  v0.2.0 is published.
- Anthropic thinking budgets and OpenAI `reasoning_effort` were verified at the request-body level
  only, not against live providers.
- The `identity-ui` file failed once under parallel Chromium load and passed alone; watch for flakiness.

## Next work (local until a checkpoint worth publishing)

1. Next release (0.3.0) is the first real end-to-end test of the in-app update path; watch it.
2. Onboarding polish (`operations.setup`): first-run screen that offers ChatGPT sign-in, API key
   or offline demonstration, with a real test call.
3. Continue the inventory: `routing.temporary`, `memory.forget`, `workspace.secrets`,
   `automation.*`, `delegation.*`, then channels (`routing.channels`, `routing.pairing`).
4. Terminal parity with Hermes: `branch` command polish, `/model` and `/think` commands in chat.
5. Keep `THIRD_PARTY_NOTICES.md` current (MIT/Apache upstreams require it).

Tools: `branch-function-check.mjs`, `branch-agent-archive.py`, `branch-public-coverage.py`,
`branch-agent-pr.md` under `C:/Users/bishi/AppData/Local/Temp/Codex-session-files/`.
Stop the running packaged app before `npm run package:desktop`; the packager cannot replace a
running executable.
