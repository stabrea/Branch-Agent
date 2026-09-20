# Feature matrix

**Build:** `0a5a1245` (trunk `mac/cross-platform`, 2026-09-19), fresh clone + `npm ci` + `npm run build`
on the taofik-ai VM at `/workspace/bench/smoke-0920/app`. Nothing was re-pulled while it ran, so every
cell below is that one commit.

**How to read it.** A cell says WORKS only when I ran it on this build and watched what came back.
"The tests cover it" is **not** WORKS — that is NOT TESTED HERE with a pointer. Anything this machine
cannot reach (a real Android phone, an iPhone through Xcode, the Windows and macOS desktop windows) is
NOT TESTED HERE with the reason, because a hole you can see is worth more than a tick you cannot trust.

**How to run it again.** The three tables below come from scripts kept with this report's working files:

| What | Script | Command |
|---|---|---|
| Table A, the three states | `matrix2.mjs` | `BRANCH_DATA_DIR=... node matrix2.mjs` — writes `matrix-states.json` |
| Table C, who may do what | `who2.mjs` | `BRANCH_DATA_DIR=... node who2.mjs` — writes `matrix-who.json` |
| Tables B and D | the walks in `docs/agents/STATUS-feature-smoke.md` | listed per row there |

The scripts live in `%LOCALAPPDATA%/Temp/claude-session-files/branch/` on the owner's PC and are copied
to `/workspace/bench/smoke-0920/app/` on the VM. They take about four minutes and need no model.

---

## Table A — every switched feature, in all three of its states

A feature the owner has a three-way switch for must behave three ways:

- **off** — its tools are not offered at all (what this table measures)
- **when needed** — its tools are offered, and not loaded until the work calls for them
- **on** — its tools are loaded from the first round

This table is made by writing each switch, **rebuilding the app**, and reading the tool list and the
preload list back. Rebuilding is the point: a feature registers its tools when the app is made, so a
switch flipped on a live app proves nothing about the next start. With every switch off the app offers
214 tools; with every switch on, 312.

**What this table does and does not prove.** It measures whether the tools are offered, not the words
of the refusal. The second half of the rule — *off must refuse in one plain sentence* — I watched on
five features only, and each was well worded: `code.run` ("Running small scripts is switched off. The
owner turns it on in Settings, where they also choose whether a script may reach the internet."),
`code.rename` ("Language servers are switched off. The owner turns them on in Settings, under
Developer."), `debug.start` ("Debugging is switched off. The owner turns it on in Settings, under
Developer."), `process.start` (""branch" is not one of the programs allowed to be left running. The
owner adds those in Settings.") and Trunks over HTTP (409, "Trunks, your named assistants is switched
off. The owner can switch it on in Customize → Specialists, under Trunks."). One was not plain, and is
B9: `troubleshoot.run` answers "Fixing failed commands is switched off. The owner can turn it on with
the troubleshoot setting (GET or POST /a…" — an HTTP method in a sentence a person reads. The other
sixty-three refusal sentences are NOT TESTED HERE.

**69 switched features: 59 WORKS, 0 BROKEN, 10 NOT TESTED HERE.**

| Feature (its settings record) | Group | Tools | off | when needed | on | Verdict |
|---|---|---|---|---|---|---|
| `trunks-messages` | Trunks | 0 | — | — | — | NOT TESTED HERE |
| `add-on-drafts` | add-ons other people wrote | 0 | — | — | — | NOT TESTED HERE |
| `add-on-search` | add-ons other people wrote | 0 | — | — | — | NOT TESTED HERE |
| `desktop-control` | on its own | 0 | — | — | — | NOT TESTED HERE |
| `devices-book` | on its own | 0 | — | — | — | NOT TESTED HERE |
| `media-programs` | on its own | 0 | — | — | — | NOT TESTED HERE |
| `page-notes` | on its own | 0 | — | — | — | NOT TESTED HERE |
| `sdk-kit` | on its own | 0 | — | — | — | NOT TESTED HERE |
| `vault-autofill` | on its own | 0 | — | — | — | NOT TESTED HERE |
| `voice` | on its own | 0 | — | — | — | NOT TESTED HERE |
| `coding-checklist` | coding | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `coding-format-on-edit` | coding | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `coding-init` | coding | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `coding-large-output` | coding | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `coding-notebooks` | coding | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `coding-path-rules` | coding | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `coding-review-checks` | coding | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `personal-chat-files` | files, voice, devices and personal connectors | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `personal-google` | files, voice, devices and personal connectors | 6 | not offered | offered, not preloaded | all 6 preloaded | WORKS |
| `personal-home-control` | files, voice, devices and personal connectors | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `personal-mail-search` | files, voice, devices and personal connectors | 3 | not offered | offered, not preloaded | all 3 preloaded | WORKS |
| `personal-microsoft` | files, voice, devices and personal connectors | 5 | not offered | offered, not preloaded | all 5 preloaded | WORKS |
| `personal-spoken-brief` | files, voice, devices and personal connectors | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `personal-spotify` | files, voice, devices and personal connectors | 3 | not offered | offered, not preloaded | all 3 preloaded | WORKS |
| `personal-x-search` | files, voice, devices and personal connectors | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `flowboards-install-requests` | flows and boards | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `flowboards-kanban` | flows and boards | 4 | not offered | offered, not preloaded | all 4 preloaded | WORKS |
| `flowboards-recipe-checks` | flows and boards | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `flowboards-time-travel` | flows and boards | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `flowboards-widgets` | flows and boards | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `learning-more-blocks` | learning, deeper | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `learning-more-curator` | learning, deeper | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `learning-more-expiry` | learning, deeper | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `learning-more-journey` | learning, deeper | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `learning-more-lessons` | learning, deeper | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `learning-more-meaning-search` | learning, deeper | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `learning-more-providers` | learning, deeper | 3 | not offered | offered, not preloaded | all 3 preloaded | WORKS |
| `troubleshoot` | on its own | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `web-pages` | on its own | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `reach-background-screen` | reach and platform | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `reach-machines` | reach and platform | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `reach-notes` | reach and platform | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `reach-remote-trunks` | reach and platform | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `reach-skill-bundles` | reach and platform | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `reach-usb` | reach and platform | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `reach-video` | reach and platform | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `interop-agent-market` | talking to other agents and tools | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `interop-fleet` | talking to other agents and tools | 3 | not offered | offered, not preloaded | all 3 preloaded | WORKS |
| `interop-flow-search` | talking to other agents and tools | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `interop-handoff` | talking to other agents and tools | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `interop-modes` | talking to other agents and tools | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `interop-project-routing` | talking to other agents and tools | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `safety-tool-scripts` | the safety extras | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `safety-wasm-add-ons` | the safety extras | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `asks-answer-engine` | the smaller asks | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `asks-answer-pages` | the smaller asks | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `asks-app-blocks` | the smaller asks | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `asks-article-writer` | the smaller asks | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `asks-hindsight` | the smaller asks | 3 | not offered | offered, not preloaded | all 3 preloaded | WORKS |
| `asks-intent-pipeline` | the smaller asks | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `asks-nodes` | the smaller asks | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `asks-project-board` | the smaller asks | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `asks-source-sync` | the smaller asks | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `learn` | understanding something | 3 | not offered | offered, not preloaded | all 3 preloaded | WORKS |
| `autonomy-instructions` | work that starts itself | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `autonomy-orders` | work that starts itself | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `autonomy-procedures` | work that starts itself | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |
| `autonomy-readiness` | work that starts itself | 1 | not offered | offered, not preloaded | all 1 preloaded | WORKS |
| `autonomy-suggestions` | work that starts itself | 2 | not offered | offered, not preloaded | all 2 preloaded | WORKS |

**The ten that could not be told apart here, and why.**

- `trunks-messages` — none of its 1 tools (trunk.message) is in the tool list in any state on this build — it may need a key, a connected service or a platform this machine has not got
- `desktop-control` — the feature's tool list is not written down in one place, so the three states cannot be told apart by tools alone
- `voice` — the feature's tool list is not written down in one place, so the three states cannot be told apart by tools alone
- `media-programs` — the feature's tool list is not written down in one place, so the three states cannot be told apart by tools alone
- `page-notes` — the feature's tool list is not written down in one place, so the three states cannot be told apart by tools alone
- `devices-book` — the feature's tool list is not written down in one place, so the three states cannot be told apart by tools alone
- `vault-autofill` — the feature's tool list is not written down in one place, so the three states cannot be told apart by tools alone
- `sdk-kit` — the feature's tool list is not written down in one place, so the three states cannot be told apart by tools alone
- `add-on-drafts` — none of its 1 tools (addon.draft) is in the tool list in any state on this build — it may need a key, a connected service or a platform this machine has not got
- `add-on-search` — none of its 1 tools (addon.search) is in the tool list in any state on this build — it may need a key, a connected service or a platform this machine has not got

Two of those are worth a second look by whoever owns them: `trunks-messages` declares `trunk.message`,
and `add-on-drafts`/`add-on-search` declare `addon.draft` and `addon.search`. None of those three names
is in the tool list in **any** state on this build, including with every switch on. Either the tool is
registered somewhere this check does not reach, or the name in the settings file and the name in the
registry have drifted apart — in which case switching that feature on would advertise nothing. The
other seven are features whose tool list is not written down in one place (`desktop-control`, `voice`,
`media-programs`, `page-notes`, `devices-book`, `vault-autofill`, `sdk-kit`), so this check cannot name
their tools to look for; they need a check of their own.

---

## Table B — surfaces

One row per surface, saying what was actually driven on it.

| Surface | What I drove | Verdict |
|---|---|---|
| Desktop window, Linux | Not the Electron window: the same pages served by `branch start`, driven headless with Playwright at 1440x900 — first-run screen, Settings at all three levels, search, Accounts, the assistant's files, the usage ring and its popover, the 95% question, the six side-panel tabs, dragging the panel, Ctrl+B, right-click then Hide this, pets and achievements on then off | WORKS for the pages; the Electron shell itself is NOT TESTED HERE — the brief forbids opening a window on the owner's machines |
| Desktop window, Windows | — | NOT TESTED HERE: no Windows build was made or run; this smoke ran on a Linux VM |
| Desktop window, macOS | — | NOT TESTED HERE: no Mac was in reach of this run |
| CLI | All 43 commands' `--help`, the four completion scripts, `doctor`, `status`, `demo`, `security audit`, `activity verify`, `report` (plus `--json`, `--without`, `--save`), `backup`, `restore`, `export-agent` (plus `--redact`), `import-agent`, `eval tools`, `token create/list`, `schedule add/list/remove`, `places` and every terminal place, and 27 `branch run` tasks against the real model | WORKS, except what B4 blocks while the app is open |
| Terminal view (TUI) | `branch chat` under a pty at 80x24 and at 120x40, then `/quit` | WORKS at both sizes: the box is drawn to the width, the side frame and the extra key-help line appear only when there is room, and nothing runs past the edge |
| Web at 390x844 | Chat, Settings and Inbox at phone size | WORKS: no sideways scrolling at either place (`scrollWidth` 390 against `clientWidth` 390), and the message box is there |
| Phone app | — | NOT TESTED HERE: `branch phone` shows a code to scan, which needs a real phone and would pair a device; the brief rules that out |
| Android | — | NOT TESTED HERE: no Android device or emulator on this machine |
| iPhone | — | NOT TESTED HERE: needs a Mac with Xcode, which this run had no reach to |
| Browser | the app's own pages in headless Chromium, which is what a person's browser loads | WORKS |
| An approval answerable at phone size | — | NOT TESTED HERE: an approval card needs a task that stops to ask, and the one turn that produced a question was spent on the CLI, not in the window |

---

## Table C — who is asking

The same tool call, made as each kind of caller, through the very gate the app's own "try a tool"
screen uses: the rules, Lockdown, Branch's own files, folder trust, and where the call came from.

| Tool | owner | a chat app (`channel`) | a schedule | a trigger | another computer (`remote`) |
|---|---|---|---|---|---|
| `files.read` | ran | ran | ran | ran | ran |
| `files.write` | ran | **asked first** | **asked first** | **asked first** | **asked first** |
| `code.run` | ran | **asked first** | **asked first** | **asked first** | **asked first** |

**Verdict: WORKS.** Reading is free for everyone. Everything that changes something — writing a file,
running a script — the owner's own task does without asking, and *every* outside caller is stopped and
asked: "Before I go ahead: run files.write on who.txt. Is that all right?" That is exactly what the
shipped "No approvals" preset promises in its own words, and it is the hold an outside-started task
has to keep.

| Who | What was proved | Verdict |
|---|---|---|
| Owner | every run in this report | WORKS |
| A household person | a profile "Sam" with a PIN, switched to; adding somebody, switching Lockdown and taking a backup each answered "This belongs to the owner. Switch back to the owner's profile to use it." | WORKS |
| A short-lived key | a read-only key read `/api/health`; `POST /api/run` answered "That key may only look at things. Make one with --scope run to start a task."; `POST /api/lockdown` answered "A short-lived key cannot switch Lockdown on or off."; a made-up key was refused | WORKS — but see B4: with the app open the key cannot be made at all |
| A chat app | the `channel` column above | WORKS at the gate. A real chat app is NOT TESTED HERE: the brief forbids messaging one |
| An outside-started task | the `schedule`, `trigger` and `remote` columns above | WORKS |
| Lockdown, over all of them | `code.run` refused outright, `files.write` refused, `files.list` still asks | WORKS |

---

## Table D — the feature areas, as `docs/features.md` describes them

Every row of `docs/agents/STATUS-feature-smoke.md` folds in here; that file has the exact command or
screen for each, and a repro paragraph for each BROKEN.

| Area | Verdict |
|---|---|
| First run: the model-choice screen, connecting the ChatGPT plan, the practice run, a first task | WORKS |
| Coding: read, edit, patch, a change set across files, `code.check` | WORKS |
| Coding: the tests question (it asks, and offers Always for this folder) | WORKS |
| Coding: `--allow-tests` | **BROKEN** (B6) |
| Anything that mentions git, on the ChatGPT plan | **BROKEN** (B7) |
| Switching on "search posts on X" | **BROKEN** (B10) — it stops every task, on any model |
| Permission modes: the four presets, the mode shown on the message box, the shipped default | WORKS |
| Permission mode: "show me the plan first" | **BROKEN** (B5) |
| Lockdown, a household profile, a short-lived key's limits, an outside-started task's hold | WORKS |
| Memory: remember, recall | WORKS |
| Documents, and a knowledge base over a folder answering with a citation | WORKS |
| Schedules, triggers | WORKS |
| Trunks, a Trunk's face and handle, a room with two Trunks, an @mention into it | WORKS |
| Settings: three levels, search, Accounts, the assistant's files, the usage ring, the 95% question, glass dropdowns, hide-anything, pets and achievements, the side panel and Ctrl+B | WORKS |
| The terminal view at 80x24 and 120x40; the web at phone size | WORKS |
| Safety: a deny rule through read, list and search; secrets never echoed; the problem report redacts | WORKS |
| Safety: a deny rule through git and through a patch | NOT TESTED HERE — B7 stops any git prompt before the model sees it |
| Never break: `branch doctor`, and an engine killed with `kill -9` coming back with its work intact | WORKS |
| Every terminal command while the app is open | **BROKEN** (B4) |
| The daemon, rewind and undo, "do this again", steering, resume after a restart, memory tidy, a room's Revoke, Full access | NOT TESTED HERE — the reason is on each row of the status file |

---

## Broken, worst first

1. **B10 — switching on "search posts on X" stops every task working.** With
   `personal-x-search` set to on — one switch, in the shipped UI — every `branch run` answers
   "Transforms cannot be represented in JSON Schema" and does nothing. `x.search`'s schema uses a
   `.transform()` (`src/personal/x-search.ts:23`) that cannot be written as JSON Schema, and the
   whole catalog goes down with it: `registry.descriptions()` throws for all 312 tools, so the
   assistant is handed none. Proven both ways on the offline provider, so it costs nothing to repro:
   the same "Say hello." completes with the switch off and fails with it on.
2. **B7 — anything to do with git fails on the ChatGPT plan** before the model is even asked. Two tool
   schemas (`git.log`, `git.commit`) use a negative lookahead the endpoint's validator rejects — the
   only two of the 311 tools that can be written out at all, with every switch on.
3. **B5 — "show me the plan first" showed no plan and changed a file without asking**, even set to
   check before changes.
4. **B4 — every terminal command except `schedule` refuses while Branch is open**, including
   `doctor`, `backup`, `security audit`, `memory`, `token` and `trace`; a short-lived key cannot be
   made at all while the window is open, and no HTTP route makes one.
5. **B6 — `--allow-tests` made the tests less likely to run** than leaving it off.
6. **B8 — a task that runs out of rounds throws away everything it found** and answers only
   "Maximum 12 model rounds reached".
7. **B1 — the window's own health check is sent with no key**, is answered 401 every few seconds, and
   cannot notice a Branch that is up but refusing everything.
8. **B2 — the Lockdown row says the opposite of what Lockdown is doing** in `branch settings permissions`.
9. **B3 — the command list says twelve Settings pages; there are thirteen.**
10. **B9 — a tool given the wrong input answers with raw Zod JSON**, not a sentence.

Each has its repro in `docs/agents/STATUS-feature-smoke.md`.

## Whole surfaces still unproven

The Windows desktop window, the macOS desktop window, the Electron shell on any platform, the phone
app, Android, and iPhone. None was reachable from this run, and none should be marked green by anybody
who has not opened them.
