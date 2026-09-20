# Feature smoke test — Branch Agent end to end

**What this is.** Every feature area the owner asked about, tried against the real app, with a real
cloud model where a model is needed. Each row says WORKS, BROKEN or NOT TESTED in plain words, with
the exact command or screen it was tried on. Every BROKEN row has a repro paragraph below the table.

**Build under test:** `0a5a1245` (trunk `mac/cross-platform` as of 2026-09-19 20:20 EDT),
fresh clone + `npm ci` + `npm run build` on the taofik-ai VM at `/workspace/bench/smoke-0920/app`.
Nothing is re-pulled mid-run, so every repro below refers to that one commit.

**Where it ran.** taofik-ai VM, headless, everything under `/workspace/bench/smoke-0920`.
Throwaway data dirs (`data-a`, `data-fresh`, ...) and workspaces (`ws-a`, ...). The owner's own
Branch install, Hermes, OpenClaw and Codex desktop were not touched.

**Model.** `gpt-5.6-terra` on the owner's ChatGPT plan, via a copy of the bench-only sign-in at
`/workspace/bench/cg/sub-auth/chatgpt-auth.json`. No new sign-in.

**Deliberately not done** (from the brief): anything that messages a real chat app, publishes
anything, or touches the owner's accounts beyond the ChatGPT plan already signed in. That rules out
`branch connect`, `branch send`, `branch node pair`, `branch phone`, `branch update --yes`,
`branch uninstall`, `branch rollback --yes` and `branch daemon install` (it writes user-level
services on the owner's VM, which the brief puts off limits).

## Results

| # | Item | Verdict | Tried with |
|---|------|---------|-----------|
| 0.1 | Build from a clean clone at a pinned commit | WORKS | `git clone` + `git checkout 0a5a1245` + `npm ci` + `npm run build` on the VM; `SETUP OK 0a5a1245` |
| 1.1 | First run: fresh data dir, first-run flow | NOT TESTED | |
| 1.2 | Connect the model | NOT TESTED | |
| 1.3 | Practice workspace | NOT TESTED | |
| 1.4 | First task finishes | NOT TESTED | |
| 2.1 | Coding: read a file | NOT TESTED | |
| 2.2 | Coding: edit a file | NOT TESTED | |
| 2.3 | Coding: patch | NOT TESTED | |
| 2.4 | Coding: multi-file change set | NOT TESTED | |
| 2.5 | `code.check` | NOT TESTED | |
| 2.6 | Read-before-edit switch on | NOT TESTED | |
| 2.7 | Read-before-edit switch off | NOT TESTED | |
| 2.8 | The tests question: ask | NOT TESTED | |
| 2.9 | The tests question: Always for this folder | NOT TESTED | |
| 2.10 | The tests question: `--allow-tests` | NOT TESTED | |
| 2.11 | The tests question: unattended skip | NOT TESTED | |
| 3.1 | Permission mode: Ask first | NOT TESTED | |
| 3.2 | Permission mode: Plan | NOT TESTED | |
| 3.3 | Permission mode: Auto | NOT TESTED | |
| 3.4 | Permission mode: Full access | NOT TESTED | |
| 3.5 | Mode is per conversation | NOT TESTED | |
| 3.6 | Lockdown | NOT TESTED | |
| 3.7 | A household profile | NOT TESTED | |
| 3.8 | A short-lived key | NOT TESTED | |
| 3.9 | Outside-started task keeps its hold | NOT TESTED | |
| 4.1 | Remember | NOT TESTED | |
| 4.2 | Recall | NOT TESTED | |
| 4.3 | Tidy | NOT TESTED | |
| 4.4 | Add a document, ask about it | NOT TESTED | |
| 4.5 | A knowledge base over a folder | NOT TESTED | |
| 5.1 | Schedules | NOT TESTED | |
| 5.2 | Triggers | NOT TESTED | |
| 5.3 | Workflows / flows | NOT TESTED | |
| 5.4 | Rewind / undo | NOT TESTED | |
| 5.5 | "Do this again" | NOT TESTED | |
| 5.6 | Steer | NOT TESTED | |
| 5.7 | Resume after a restart | NOT TESTED | |
| 6.1 | Make a Trunk | NOT TESTED | |
| 6.2 | A Trunk's face | NOT TESTED | |
| 6.3 | A room with two Trunks | NOT TESTED | |
| 6.4 | @mention | NOT TESTED | |
| 6.5 | A room yes, and Revoke | NOT TESTED | |
| 7.1 | Settings levels: Regular / Advanced / Technical | WORKS | Settings › Appearance, the "How much to show" control: Regular 2 cards / 16 controls, Advanced 11 / 54, Technical 11 / 54 with the level note changing each time |
| 7.2 | Search finds settings | WORKS | the Search settings box: "lockdown" 11 cards → 5, "pet" → 2 and it opens Appearance, "read before" → 2 and it opens Assistant |
| 7.3 | Accounts page | WORKS | Settings › Accounts: "Every sign-in and key Branch can use, which one answers, and what happens when one runs low" |
| 7.4 | Agent-files editor | WORKS | Settings › Assistant, the "Your assistant's files" card: SOUL.md and the rest, each with what it is for and whether it is read now |
| 7.5 | Usage ring and popover | WORKS | the ring under the message box; pressing it opens #usage-pop with what each connection has left |
| 7.6 | The 95% prompt | WORKS | forced: the window was handed a connection at 96% with tasks running, and the question appeared — "Almost out on Smoke plan… Save progress / Not now" with a five-second countdown |
| 7.7 | Suggestion bars | WORKS | `GET /api/deployment/suggestion` answers `{"bar":null}` (nothing to suggest on a fresh install, which is right); the starter bar in the conversation is in the page |
| 7.8 | Glass dropdowns | WORKS | pressing the Language select opens #glass-list: aria-expanded=true, a positioned panel with "English" and "Français (machine draft)" |
| 7.9 | Hide anything | WORKS | Appearance → right-click works as Hide this → right-click the title → menu "Hide this / What's on screen…" → html[data-hide]="page-title" and the title is gone |
| 7.10 | Achievements / pets / background on, then off | WORKS | Appearance: pet and achievements ship off; switched on, #pet-lane shows in the conversation; switched off again, it is hidden |
| 7.11 | Panels: Browser and Terminal tabs, resize, Ctrl+B | WORKS | the side panel's six tabs (Activity, Plan, Files, Memory, Browser, Terminal) all open; dragging .panels-rz took the side list 272px → 440px; Ctrl+B adds and removes `no-rail` on the body |
| 8.1 | TUI at 80x24 | WORKS | `script -q -e -c "stty cols 80 rows 24; node dist/cli.js chat"`: header, the five places, the message box drawn 78 wide, the footer line — nothing past the edge |
| 8.2 | TUI at 120x40 | WORKS | the same at 120x40: the side frame and the extra key-help line come back, the box is drawn 114 wide |
| 8.3 | Web UI at 390x844, approvals answerable | NOT TESTED | |
| 8.4 | `branch run` | NOT TESTED | |
| 8.5 | `branch chat --plain` | NOT TESTED | |
| 9.1 | Deny rule refused through read | NOT TESTED | |
| 9.2 | Deny rule refused through grep | NOT TESTED | |
| 9.3 | Deny rule refused through list | NOT TESTED | |
| 9.4 | Deny rule refused through patch | NOT TESTED | |
| 9.5 | Deny rule refused through git | NOT TESTED | |
| 9.6 | Secrets never echoed | NOT TESTED | |
| 9.7 | The problem report redacts | WORKS | a canary secret was left in the workspace; `branch report --save report.zip` wrote 11 entries and the canary is in none of them |
| 10.1 | `branch doctor` | WORKS | `branch doctor`: nine checks, all ok (saved data, workspace, device key, models, ChatGPT account, local models, channels, schedules, tasks waiting) |
| 10.2 | A killed engine recovering | NOT TESTED | |
| 10.3 | The daemon | NOT TESTED | |
| 11.1 | Branch checks itself and reports (its claims) | NOT TESTED | |
| 11.2 | Its claims checked against what I found | NOT TESTED | |

## Broken, worst first

### B1 — the window's own "is Branch still there" check is refused, every few seconds

`public/layout.js:1223` asks `fetch("/api/health", { cache: "no-store" })` and `public/never-break.js:25`
asks `fetch("/gateway/health")`, and neither sends the session key. Both answer **401**. I confirmed it
from inside the owner's own window: `/api/health` with no key → 401, `/gateway/health` → 401, and
`/api/health` with the key → 200. Two things follow. The browser console fills with
"Failed to load resource: the server responded with a status of 401" — eight of them in a one-minute
walk, and they are the only console errors the app produces, so they hide anything real. And the check
cannot do its job: `checkServer` only counts a miss when `fetch` *rejects*, and a 401 resolves, so the
chip says "Connected" whenever the server is reachable at all — including a Branch that is up but
refusing every request, which is exactly the state the chip exists to notice. Repro: open the window,
watch the console, or run `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/api/health`.

### B2 — the Lockdown row says the opposite of what Lockdown is doing

`branch settings permissions` with Lockdown off prints:

```
Lockdown: off	Lockdown is on. Commands are refused; all else asks you.	/lockdown on
```

The title is right and the sentence beside it is the "on" sentence, always.
`src/terminal-settings.ts:69` builds the row with `detail: words.t("lockdown.on", "Lockdown is on. …")`
with no branch on `lock`, which the line above it has already computed. So the one row a person reads
to find out whether commands are being refused tells them commands *are* being refused while they are
not. A fix needs a new `lockdown.off` sentence — there is none anywhere today
(`src/terminal-tui.ts:449` hard-codes "[Lockdown is off]" instead), so this is not a one-word change
and I left it for the integrator. Repro: `BRANCH_DATA_DIR=… node dist/cli.js settings permissions`,
last line.

### B3 — the command list says twelve Settings pages; there are thirteen

`branch help` and `branch settings --help` both say "The twelve Settings pages by name"
(`src/terminal-parity.ts:79` and `src/commands/catalog.ts:87`), while `SETTINGS_PAGES`
(`src/terminal-places.ts:38-52`) holds thirteen: General, Assistant, Appearance, Notifications,
Models, Accounts, Voice, Permissions, Computer & browser, Secrets, Data & usage, Advanced,
Updates & about. `branch places` lists all thirteen. Small, but it is the sentence that tells a
person what to expect. Repro: `node dist/cli.js help | grep settings` against
`node dist/cli.js places | grep -c "^settings:"` (counting Models once).

## What Branch said about itself

(not run yet)
