# Coding: where Branch stands against Claude Code and Codex

Written on `mac7/coding-gap`, 2026-09-19. Two parts: what each program *has* for coding (read from
the code, with file:line), and what happened when they were given the same twelve coding tasks on
the same local model. The results section is filled from `experiments/coding-bench/`; nothing in it
is estimated.

## 1. Capability table

"Weaker" means Branch has the thing but it failed or would fail where the others succeed. Line
numbers are on `mac/cross-platform` 36ee8abb unless marked *(this branch)*.

| capability | Claude Code | Codex CLI | Branch | evidence |
|---|---|---|---|---|
| Exact-text edit | Edit: exact, must be unique or `replace_all` | via apply_patch | **has** — `files.edit`, `find`/`replace`/`expectedOccurrences` | `src/code-edit.ts:203` |
| Edit tolerant of whitespace slips | no (exact) | apply_patch matches loosely | **was missing → fixed** *(this branch)*: exact first, then trailing-whitespace, then indentation; replacement re-indented | `src/text-replace.ts` |
| Edit refusal says what to do | yes (count, "provide more context") | yes | **was weaker → fixed**: refusal now gives the count and how to fix it, or the closest line | `src/text-replace.ts` |
| Other agents' argument names | — | — | **added**: `old_string`/`new_string`/`file_path`/`replace_all` accepted | `src/code-edit.ts` *(this branch)* |
| Multi-file patch | MultiEdit | apply_patch (many files) | **has** — `files.patch`, `code.patch` (all-or-nothing, undoable), `code.change_set` | `src/code-edit.ts:197`, `src/code-change.ts:173,182` |
| Patch placed by content, not line number | n/a | yes (no line numbers in its grammar) | **was weaker → fixed**: hunks were applied only at the exact line named and with exactly the declared counts; now placed by searching for their lines, counts forgiven, bare `@@` accepted | `src/patch.ts:68-90` (before) |
| `*** Begin Patch` grammar | — | native | **added** (Update File, Add File) | `src/patch.ts` *(this branch)* |
| Read-before-edit / stale-file guard | yes | no | **missing** — `files.write` overwrites a file the model never read | `src/files.ts:266` |
| Syntax check after edit | via hooks/LSP | no | **has** on demand — `files.validate`, `code.diagnostics`; format-on-edit | `src/code-edit.ts:214`, `src/language-server-tools.ts:17`, `src/coding/format-on-edit.ts` |
| Run the tests | Bash (asks) | sandboxed exec, runs by default in workspace-write | **weaker by default**: no shell until the owner configures executable aliases; `code.run` off by default; `code.check` runs only an owner-configured program | `src/integrations/shell.ts:56`, `src/code-run.ts:31`, `src/code-change.ts:151` |
| Background command + watch output | `run_in_background` + monitor | — | **has** — `process.start/read/stop`, kept-open `shell.session.*` | `src/processes.ts:259-278`, `src/shell-session.ts:253` |
| Subagents | Task tool, worktree isolation | — | **has** — delegation; a helper can work in its own worktree | `src/runtime.ts:863`, `src/coding/worktrees.ts` |
| Plan / todo list | plan mode, TodoWrite | plan tool | **has** — `branch run --plan`, `todos.*` | `src/cli-run.ts:59`, `src/todos.ts:100` |
| Instruction files | CLAUDE.md | AGENTS.md | **has** — AGENTS.md, CLAUDE.md and aliases; `/init` | `src/context-files.ts:11`, `src/coding/init.ts` |
| Hooks, skills, MCP | yes | MCP | **has** | `src/hooks.ts`, `src/skill-tools.ts:44`, `src/mcp-*.ts` |
| Checkpoints / rewind | yes | — | **has** — git checkpoint before a change set, rewind | `src/code-change.ts:139`, `src/rewind.ts` |
| Review | `/review` | `/review` | **has** — project review checks | `src/coding/review-checks.ts` |
| Tool selection for a small model | deferred tools | small fixed set | **has** — 18 of 214 tools shown, rest deferred and searchable | `catalog.size` event, `src/runtime.ts:1614` |
| Sandbox / approval modes | permission modes | read-only / workspace-write / full | **has** — seatbelt/bwrap backends, approval rules | `src/sandbox*.ts`, `src/policy.ts:122` |
| Headless | `claude -p`, SDK | `codex exec` | **has** — `branch run`, `branch headless` | `src/cli-run.ts` |
| Run deadline set by caller | yes | yes | **was broken → fixed**: a hard 2-minute ceiling was combined with the caller's signal, so `--timeout` could only shorten a task | `src/runtime.ts:811-815` (before) |
| Reply that is all thinking | — | ends the turn (seen on the bench) | **was weaker → fixed**: the task ended "produced nothing"; now the model is told to act, twice at most | `src/runtime.ts` loop *(this branch)* |
| Local open models | no | `--oss` (Ollama, LM Studio) | **has** — any OpenAI-compatible endpoint | `experiments/scoreboard/FINDINGS.md` §4 |

Summary: on *breadth* Branch is not behind either program — it has nearly every coding feature both
of them have. Where it was behind is *robustness with a small model*: edits and patches refused over
slips a lenient applier accepts, a deadline no caller could lengthen, and a reply of pure thinking
ending the task. Those are what this branch fixes. What it does not fix is the default that Branch
cannot run a command until the owner configures one — see the plan below.

## 2. The bench

Twelve small coding tasks in throwaway repos (`experiments/coding-bench/tasks.mjs`): fix an
off-by-one, add a function with tests, extract a shared helper across files, fix a crash from a
stack trace, add a CLI flag, update stale docs, rename across four files, fix a flaky test, adapt to
a breaking dependency bump, add validation, fix a missing `await`, implement a function from its
spec. Every task is decided by a program — its test suite (pristine tests put back first, some with
hidden cases the prompt states), running the CLI, or reading the README — never by a model.
`selfcheck.mjs` proves each check fails on the untouched seed and passes on a known solution.

Rig: the Tower P40 through the bench forwarder on `taofik-ai`, model **qwen3:14b with a 16384-token
window** (`qwen3-14b-16k`; 64K does not fit the container's 4 GB memory cage — scoreboard F4), one
600-second deadline for everyone, round-robin interleaved (`run-scoreboard.mjs --taskset`), load
average recorded either side of every cell.

Contestants, all on that model:

- **branch-before** — `mac/cross-platform` 36ee8abb, unmodified.
- **branch-after** — this branch before the reply-ceiling fix (patch/edit, deadline, empty-reply
  nudge, `code.check` note).
- **branch-after-scripts** — the same build with the owner's "run scripts" switch turned on (it ships
  off), so `code.check` runs `node --test`. It answers what that one switch is worth.
- **branch-after2 / branch-after2-scripts** — the final build, adding the adaptive reply ceiling
  (window 4).

*Integration review (2026-09-19), after these windows were measured:* the `node --test` stand-in now
runs only when `code.check` is called by name; after `code.patch` / `code.change_set` only a check the
owner set up runs (a files.write tool must not run the files it wrote). Patch placement is stricter: a
part that fits more than one place is refused instead of put on the first, and the empty-reply nudge
fires only for a reply that thought. The rows below predate those changes and were not re-run.
- **codex** — Codex CLI 0.155.1, fresh install, `codex exec --oss --local-provider ollama`,
  sandbox `workspace-write`, its own `CODEX_HOME` under `/workspace/bench`.
- **openclaw** — OpenClaw 2026.9.4, the scoreboard's fresh install and settings.
- **Hermes** — not run: it refuses any window under 64K and 64K does not fit the rig (scoreboard F5).
- **Claude Code** — not run: it cannot use a local model, and the owner's subscription is not for
  bulk benchmarking. Compared qualitatively in the table above only.

Tool surfaces differ and are recorded on every row. In particular Branch ran as it ships: **no shell
configured**, so it could read and edit but never run `node --test`; Codex ran every command it
wanted inside its sandbox.

## 3. Results

### Window 3 — the counted window

Stopped by plan after 40 of 60 cells: all five rows on the first **8 tasks**, round-robin, one pass
each (`experiments/coding-bench/results-window3.jsonl`, edits recounted from each cell's database by
`recount-edits.mjs`). Load average 4.8–11.2 across the window.

| contestant | finished (tests pass) | median wall time | tokens in / out (reported) | edits refused / tried | rescued |
|---|---|---|---|---|---|
| openclaw | **1 / 8** | 184 s | 74475 / 6291 | not reported | 0 |
| codex | **1 / 8** | 234 s | 243108 / 15050 | 0 / 0 | 5 |
| branch-before | **0 / 8** | 126 s | 25497 / 10355 | 0 / 0 | 8 |
| branch-after | **1 / 8** | 208 s | 115253 / 28295 | 0 / 2 | 5 |
| branch-after-scripts | **1 / 8** | 312 s | 76554 / 19490 | 1 / 4 | 6 |

| task | openclaw | codex | branch-before | branch-after | branch-after-scripts |
|---|---|---|---|---|---|
| fix-range | fail 158 s | fail 255 s | fail 128 s | fail 325 s | PASS 316 s |
| add-median | fail 184 s | fail 499 s | fail 128 s | fail 144 s | fail 140 s |
| extract-helper | fail 203 s | fail 170 s | fail 88 s | fail 147 s | fail 308 s |
| stack-trace | fail 184 s | fail 226 s | fail 125 s | fail 524 s | fail 600 s |
| cli-flag | fail 266 s | fail 147 s | fail 125 s | fail 206 s | fail 141 s |
| update-docs | PASS 217 s | fail 171 s | fail 125 s | PASS 230 s | fail 454 s |
| rename | fail 161 s | PASS 243 s | fail 126 s | fail 210 s | fail 126 s |
| flaky | fail 173 s | fail 365 s | fail 126 s | fail 143 s | fail 600 s |

Pairwise, tasks one passed that the other failed (a win needs at least 3):

- codex vs openclaw: 1 only codex (rename), 1 only openclaw (update-docs) — no claim
- branch-before vs openclaw: 0 only branch-before (none), 1 only openclaw (update-docs) — no claim
- branch-before vs codex: 0 only branch-before (none), 1 only codex (rename) — no claim
- branch-after vs openclaw: 0 only branch-after (none), 0 only openclaw (none) — no claim
- branch-after vs codex: 1 only branch-after (update-docs), 1 only codex (rename) — no claim
- branch-after vs branch-before: 1 only branch-after (update-docs), 0 only branch-before (none) — no claim
- branch-after vs branch-after-scripts: 1 only branch-after (update-docs), 1 only branch-after-scripts (fix-range) — no claim
- branch-after-scripts vs openclaw: 1 only branch-after-scripts (fix-range), 1 only openclaw (update-docs) — no claim
- branch-after-scripts vs codex: 1 only branch-after-scripts (fix-range), 1 only codex (rename) — no claim
- branch-after-scripts vs branch-before: 1 only branch-after-scripts (fix-range), 0 only branch-before (none) — no claim

**Reading it honestly:** every row finished at most one task in eight. No row is ahead of any other by
the three tasks the rule asks for, so **no win is claimed** — not Branch over Codex, not the fixes
over trunk. What the window does show, from each cell's own record:

- **branch-before** was cancelled at ~125 s in 7 of 8 tasks — the 2-minute ceiling (F2). It never
  got far enough to edit anything.
- **branch-after** got past that, and then **7 of the 16 after-cells (both after-rows) ended "used its whole
  reply allowance thinking"** — qwen3 thinking past Branch's 2,048-token reply ceiling (F1). That is
  the biggest measured gap left, and the reason for the next fix (window 4).
- **branch-after-scripts** is the only row to pass `fix-range`: it ran `code.check` (now `node --test`),
  edited `src/range.js`, ran the tests again and stopped. That is the loop Codex runs by default.
- **codex** ran commands freely, read the right files and often reasoned to the right fix — but in 5
  of 8 tasks its final message was empty, and in `fix-range` it explained the right fix without making it. Its edits are made through shell
  commands, so "edits refused / tried" is not measurable for it (0 / 0 is not "no failures").
- **openclaw**'s calls went through its `tool_call` bridge; it passed `update-docs`.
- Edits Branch tried and had refused: 1 of 6 across both after-rows (in `stack-trace`). Too few edits happened on this model for the patch/edit fixes to show in the numbers;
  they rest on their unit tests.
- Tokens: Branch sends a far smaller prompt per round (~2.7K tokens in, 18 of 214 tools shown) than
  Codex (~15K); over 8 tasks Codex used 243K input tokens to Branch-after's 115K.

### Window 4 — the build with the adaptive reply ceiling

The two after2 rows alone (not interleaved with the others — compare with window 3 only loosely),
first 4 tasks, stopped by plan after 8 cells (`results-window4.jsonl`).

| contestant | finished (tests pass) | median wall time | tokens in / out (reported) | edits refused / tried | rescued |
|---|---|---|---|---|---|
| branch-after2 | **0 / 4** | 600 s | 8172 / 0 | 3 / 3 | 4 |
| branch-after2-scripts | **0 / 4** | 600 s | 13620 / 5883 | 12 / 12 | 3 |

| task | branch-after2 | branch-after2-scripts |
|---|---|---|
| fix-range | fail 187 s | fail 600 s |
| add-median | fail 600 s | fail 566 s |

**No task passed.** What changed is *how* Branch fails: in window 3 the after-rows ended early, cut
off mid-thought; here the ceiling rose when needed (`model.ceiling_raised` in 3 cells) and 6 of 8
cells worked until the 600-second deadline — reading, editing, running the check — on a model that
takes 40–110 s per round on this shared card. One cell died to the stall watchdog while the model
was cold-loading (F6, a first-token wait of over 60 s after the card had gone idle).

The window also measured the next gap directly: **all 15 edits Branch tried were refused.** The
refusals show why — the model never read the files and invented the text for `find` (e.g.
`function formatPrice(price) { return \`$${price.toFixed(2)}\`; }` for a file that says
`(cents / 100).toFixed(2)`), then sent the same invented text again four times despite the
closest-line hint; twice it sent an empty `find` meaning "add this". Two fixes followed, with unit
tests but **not re-measured**: a refused edit now quotes the file's real lines around the closest
match (up to 1,500 characters) so the next try can copy them, and an empty `find` appends to the
file, or creates it. The read-before-write guard (plan item 7) is the stronger fix for the same
behaviour and is next.

### What the stopped windows showed (mechanisms, not scores)

Windows 0–2 were each stopped after a few cells because a cell exposed a defect worth fixing first;
their rows are not reported as scores. What they showed, all on `fix-range` (change `<` to `<=`),
which **every contestant failed in every window**:

| who | what happened | evidence |
|---|---|---|
| branch-before | two model rounds of ~60 s each, then **cancelled at 124–127 s** — the hard 2-minute ceiling, with `--timeout 600000` given | `model.cancelled "The operation was aborted due to timeout"` |
| branch-after (patch/edit/deadline fixes only) | first reply was **2,292 characters of thinking and nothing else**; the task ended "produced nothing" after 47 s | `run.produced_nothing` |
| branch-after (+ nudge) | called `code.check`, was told "No check is set up for this project", and **answered that it could not proceed** ("we need to configure a test runner") — 177 s | `run.finished` output |
| codex | ran `node --test` twice, read the test and the source, reasoned to the right fix in its thinking — and **the turn ended without applying it** (a reasoning-only final item) | `--json` events: `reasoning` then `turn.completed` |
| openclaw | **21 of 21 tool calls failed** (`tool_call` wrapper missing an `id`), then told the user to run the tests themselves | its JSON envelope `toolSummary` |

So on this model the binding constraint is the model driving a tool loop at all; the agents differ in
how they fail. The Branch fixes below are each justified by a mechanism seen above or by a unit
test, not by a pass-rate difference.

## 4. Ranked fix plan

Ranked by what was measured to stop a coding task, biggest first. **Done** items are on this branch
with tests (`tests/coding-gap-edits.test.mjs`, plus updated `tests/empty-answer.test.mjs`).

1. **Branch cannot run the tests out of the box.** No shell until the owner configures executable
   aliases, `code.run` off, `code.check` only runs an owner-configured program. Seen: the model
   concluded the task was impossible and stopped. *Done (partly):* `code.check` now says the task is
   not blocked and what to do instead; with the owner's run-scripts switch on, a Node project's own
   `node --test` stands in for a missing check. *Owner decision:* whether a coding workspace should
   be able to run its own tests by default (Codex runs commands in a workspace-write sandbox by
   default; Claude Code asks). The `branch-after-scripts` row measures what that switch is worth.
2. **A run's deadline could only be shortened (F2).** Every before-cell was cancelled at ~2 min.
   *Done:* `RunOptions.timeoutMs`, passed by `branch run --timeout`; default unchanged (2 min).
3. **A reply of pure thinking ended the task.** *Done:* the model is told to act on what it worked
   out, at most twice; a model that stays empty is still a failure with the same sentence.
4. **Patches applied only at the exact line number and declared counts.** Models get both wrong; Codex's
   grammar has no line numbers at all. *Done:* hunks placed by their lines (exact, then trailing,
   then leading whitespace), counts forgiven, bare `@@`, and the `*** Begin Patch` form.
5. **Exact-text edits refused on whitespace slips, with an unhelpful refusal.** *Done:* tolerant
   whole-line matching with re-indentation, used only when it finds exactly the expected number of
   places; refusals give the count and the fix, or the closest line; `old_string`/`new_string`/
   `file_path`/`replace_all` accepted.
6. **2,048-token reply ceiling (F1) — measured as the biggest gap left once 2 and 3 were fixed**:
   7 of 16 after-cells in window 3 ended cut off mid-thought. *Done:* the constant stays the
   starting point (the owner kept it for 0.18.1); a run whose reply is cut off while thinking retries
   that round at 4,096 and then 8,192 tokens, for that run only.
7. **Edits written blind — measured in window 4: 15 of 15 edits refused**, because the model invented
   `find` text for files it never read. *Done:* the refusal quotes the file's real lines; an empty
   `find` appends or creates. *Next:* a read-before-edit guard, as Claude Code has — refuse an edit
   or whole-file write to an existing file not read (or changed since it was read) in this run, with
   a sentence saying to read it first. This touches every task that writes files, so it wants its own
   review. Note for review: a refused edit now returns up to 1,500 characters of the file (it was one
   line) from a `files.write` tool; the path has already passed the workspace and secret-name checks.
8. **Strict tool schemas reject a small model's extra keys.** Every call parsed, but several were
   refused over an unexpected key (`workspace.checkpoint` called with `path`/`query`, `documents.write`
   with `format: "js"`). *Next:* say which keys a tool takes in the refusal, or drop unknown keys on
   read-only tools.
9. **The stall watchdog kills a cold-loading local model** (window 4, one cell: no first token within
   60 s while the model loaded after the card went idle). *Next:* a longer first-token wait for local
   connections than for hosted ones.

*Follow-up on `mac7/coding-next` (2026-09-19, unit-tested, not measured on the bench):* item 7's
read-before-edit guard is built as the coding part `read-first` (ships off); item 8 — unknown keys are
dropped before the permission check and the model is told which; item 9 — a local connection's first
reply may take 300 s (setting `localFirstReplySeconds`) with a "may be loading into memory" status line;
item 1 — with the script switch off, `code.check` asks "Let Branch run this project's tests?" once per
folder. See `docs/agents/STATUS-coding-next.md`.
