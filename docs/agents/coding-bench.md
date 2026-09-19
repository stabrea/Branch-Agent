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
- **branch-after** — this branch.
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

RESULTS

## 4. Ranked fix plan

RANKED
