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
| 0.1 | Build from a clean clone at a pinned commit | NOT TESTED | |
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
| 7.1 | Settings levels: Regular / Advanced / Technical | NOT TESTED | |
| 7.2 | Search finds settings | NOT TESTED | |
| 7.3 | Accounts page | NOT TESTED | |
| 7.4 | Agent-files editor | NOT TESTED | |
| 7.5 | Usage ring and popover | NOT TESTED | |
| 7.6 | The 95% prompt | NOT TESTED | |
| 7.7 | Suggestion bars | NOT TESTED | |
| 7.8 | Glass dropdowns | NOT TESTED | |
| 7.9 | Hide anything | NOT TESTED | |
| 7.10 | Achievements / pets / background on, then off | NOT TESTED | |
| 7.11 | Panels: Browser and Terminal tabs, resize, Ctrl+B | NOT TESTED | |
| 8.1 | TUI at 80x24 | NOT TESTED | |
| 8.2 | TUI at 120x40 | NOT TESTED | |
| 8.3 | Web UI at 390x844, approvals answerable | NOT TESTED | |
| 8.4 | `branch run` | NOT TESTED | |
| 8.5 | `branch chat --plain` | NOT TESTED | |
| 9.1 | Deny rule refused through read | NOT TESTED | |
| 9.2 | Deny rule refused through grep | NOT TESTED | |
| 9.3 | Deny rule refused through list | NOT TESTED | |
| 9.4 | Deny rule refused through patch | NOT TESTED | |
| 9.5 | Deny rule refused through git | NOT TESTED | |
| 9.6 | Secrets never echoed | NOT TESTED | |
| 9.7 | The problem report redacts | NOT TESTED | |
| 10.1 | `branch doctor` | NOT TESTED | |
| 10.2 | A killed engine recovering | NOT TESTED | |
| 10.3 | The daemon | NOT TESTED | |
| 11.1 | Branch checks itself and reports (its claims) | NOT TESTED | |
| 11.2 | Its claims checked against what I found | NOT TESTED | |

## Broken, worst first

(nothing recorded yet)

## What Branch said about itself

(not run yet)
