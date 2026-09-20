# Why Branch takes more rounds than Codex and Pi on the same coding task

Written on `mac7/gaps`, 2026-09-20, from the five-way benchmark that finished that morning
(`/workspace/bench/cg/window8` on the taofik-ai VM: `results.jsonl`, `logs/*.out`), from the
competitors' own source on the Mac (`~/Code/agent-refs`), and from Branch's source on this branch.
Every number below is counted from those files. Where something is estimated it says so and shows
the arithmetic.

This is research. Nothing here was built. `mac7/speed` is already building fixes for part of it;
each item says whether it overlaps and what window8 says about whether that fix will work.

---

## 0. First, an honest correction to the premise

The brief says "Codex 12/12, 1 turn". That `1` is Codex's own count of **user turns**, not model
round trips. One `codex exec` run emits one `turn.started` / `turn.completed` pair no matter how
much happens inside it. Inside its single turn on `fix-range`, Codex ran four shell commands and one
file change:

```
cmd  node --test
cmd  rg --files && node --test --test-reporter=spec
cmd  sed -n '1,240p' test/range.test.mjs && sed -n '1,240p' src/range.js && cat package.json && node test/range.test.mjs
edit update range.js
cmd  node --test && git diff --check && git diff
```
— `logs/codex-sub__fix-range__r1.a1.out`

Across the twelve tasks Codex made **37 shell commands and 13 file changes — 50 tool calls**. Each
tool call needs at least one model reply, and each task ends with a final message, so Codex made
**at least 62 model replies**, against Branch's 95 and Pi's 63. Codex's usage line for `fix-range`
(`input_tokens: 91292`) is also far more than one reply's worth of prompt.

So the real gap is not 8 against 1. It is:

| | tasks passed | model rounds (12 tasks) | tool calls | total wall | seconds per round |
|---|---|---|---|---|---|
| Branch, shipped defaults | 12/12 | **95** | 130 | 573 s | 6.0 |
| Branch, matched permissions | 11/12 | 91 | 117 | 570 s | 6.3 |
| Pi 0.86.0 | 12/12 | **63** | 78 | 291 s | 4.6 |
| Codex CLI 0.155.1 | 12/12 | **≥62** (floor) | 50 | 406 s | ≤6.5 |
| Hermes Agent | 8/12 | 113 | — | 2661 s | 23.5 |

Branch rounds are counted from `model.started` events in its own journal; Pi's from `turn_start`;
Codex's floor from its item stream.

The wall-time gap against Pi factors almost exactly into two parts:

```
573 s / 291 s = 1.97x  =  (95 rounds / 63 rounds = 1.51x)  x  (6.0 s / 4.6 s = 1.31x)
```

1.51 × 1.31 = 1.98. Splitting the excess, 0.51 / (0.51 + 0.31) = **62%** of the gap is round count
and **38%** is the cost of a round. (By log share, log 1.51 / log 1.97 = 61% — the same answer.) So
about **three fifths round count, two fifths per-round cost**.

**Branch's per-round cost is 1.31× Pi's and at worst level with Codex's.** The Codex figure is an
upper bound: ≤6.5 s comes from dividing 406 s by a *floor* of 62 rounds, so if Codex really ran 80
rounds its true cost is 5.1 s and Branch is the slower of the two. Per-round cost is the smaller of
the two factors, but it is real and §3c says where it probably lives. The larger factor is the 32
extra rounds, and the rest of this document is mostly about those.

---

## 1. The census: what each of Branch's 95 rounds was spent on

Counted by the first tool call in each round, from `tool.started` events. "Find a tool" means the
round's only work was `tools.search`, `tools.describe` or `tools.expand`. "Blocked" means the round
ran `code.check` and got back `"ran": false` because tests were not permitted. Branch column is
shipped defaults (the 12/12 row). Codex's column is shell commands + file changes, which is a floor
on its rounds, not a round count.

| task | Branch rounds | find a tool | look around | read | change | run tests | blocked | final | Pi rounds | Codex calls |
|---|---|---|---|---|---|---|---|---|---|---|
| fix-range | 10 | **5** | 1 | 1 | 1 | 0 | 1 | 1 | 6 | 4+1 |
| cli-flag | 12 | **5** | 2 | 1 | 1 | 1 | 1 | 1 | 5 | 3+1 |
| rename | 11 | 2 | 3 | 1 | **4** | 0 | 0 | 1 | 6 | 2+1 |
| extract-helper | 9 | **4** | 0 | 2 | 1 | 0 | 1 | 1 | 7 | 3+1 |
| missing-await | 4 | 0 | 1 | 1 | 1 | 0 | 0 | 1 | 5 | 3+1 |
| add-median | 7 | 2 | 1 | 1 | 1 | 0 | 1 | 1 | 5 | 2+1 |
| dep-bump | 7 | 2 | 1 | 1 | 1 | 0 | 1 | 1 | 5 | 3+1 |
| flaky | 8 | 2 | 2 | 1 | 2 | 0 | 0 | 1 | 5 | 4+1 |
| stack-trace | 9 | 1 | 2 | 2 | 2 | 0 | 1 | 1 | 6 | 4+1 |
| update-docs | 6 | 2 | 1 | 1 | 1 | 0 | 0 | 1 | 3 | 3+1 |
| validate-config | 8 | 2 | 1 | 1 | 2 | 0 | 1 | 1 | 6 | 3+1 |
| word-wrap | 4 | 0 | 1 | 0 | 1 | 0 | 1 | 1 | 4 | 3+2 |
| **total** | **95** | **27** | **16** | **13** | **18** | **1** | **8** | **12** | **63** | **50** |

**27 of 95 rounds — 28% — did no work on the task at all. They looked for a tool.**
Pi spent **zero**: it has four tools and they are always there. Codex spent zero.

The other counts the brief asked for:

- **Rounds spent asking the owner: 0.** `user.ask` was never called, in either Branch
  configuration, in any of the 24 runs.
- **Rounds spent recovering from a refused edit: 0.** `failedEdits` is `0` on every row of
  `results.jsonl` for both Branch rows.
- **Rounds spent re-reading a file already read: 1**, in all 24 runs — `branch-sub` read
  `README.md` twice on `update-docs`. Not a cause of anything.
- **Rounds spent thinking without acting: 0.** `reasoningChars` is 0 on all 185 `model.completed`
  rows; every round except the last carried a tool call.

**So the brief's hypothesis — that safety is paid for in rounds — is measurably wrong here.**
Branch with the owner's switches at their shipped defaults took **95** rounds. The same build with
scripts on and `--allow-tests` took **91**. Four rounds across twelve tasks, and it lost a task to
an unrelated provider error. Approvals cost nothing because nothing was ever asked.

One guard on that: this benchmark's runs are headless with a broad permission set already granted
(`run.started` lists 50 permissions, and the harness prints *"this task may run the project's tests
without asking"*). What is proved is that **in a normal headless coding run, approvals are not the
round cost**. A fresh interactive install, where every first-of-a-kind action raises a question, is
not covered by this data and should be measured separately.

Where safety does cost is the **blocked** column: 8 rounds spent running the project's check and
being told it could not run. That is one round each, and it is not the real damage — see §3.

---

## 2. Four tasks side by side

### 2a. fix-range — five rounds hunting a shell, and the tool was in the first answer

Branch, shipped defaults, 10 rounds (`logs/branch-sub-defaults__fix-range__r1.a1.out`):

```
r1 +0.3s  tools.search "run a shell command in workspace"
          -> troubleshoot.run, code.run, research.run, remote.run, workflows.run
r2 +2.8s  tools.search "shell.execute command workspace"
          -> troubleshoot.run, workspace.snapshot, workspace.map, workspace.redo, workspace.undo
r3 +5.8s  tools.describe  loaded files.read/list/search/patch, unknown: "shell.execute"
r4 +7.8s  tools.search "execute terminal command node test"
          -> troubleshoot.run, code.check, procedures.verify, procedures.replay, skills.read
r5 +12.0s tools.describe  loaded code.check, troubleshoot.run
r6 +14.7s code.check   -> "ran": false, tests not permitted here
r7 +16.7s workspace.map
r8 +19.2s files.read x3 (src/range.js, test/range.test.mjs, package.json)
r9 +23.4s files.patch  (n < end -> n <= end)
r10 +27.5s final answer
```

Round 1 **already found `code.run`**. The model still spent rounds 2–5 hunting, then gave up on
running anything. Three things went wrong at once and all three are in the source:

1. **A found tool cannot be used in the round that found it.** `src/tool-loading.ts:207` returns
   `Call ${name}; its inputs are in the tool list from your next step.` So the cheapest possible
   path to a new tool is *search, then call* — two rounds — and only if the first search wins.
2. **The ranking puts the wrong thing first.** `troubleshoot.run` came first in all three
   shell-shaped searches. `code.run` — the actual shell — came second once and never again.
3. **The model's vocabulary is not Branch's.** It asked for `shell.execute` by name twice. Pi and
   Codex both call their shell `bash`. Branch calls it `code.run`, and nothing bridges that.

Pi, 6 rounds, zero tool-finding:

```
r1 bash "node --test"
r2 bash "ls -la && find . -maxdepth 3 -type f -not -path './node_modules/*'"
r3 read src/range.js + read package.json + read test/range.test.mjs   (three calls, one round)
r4 edit src/range.js
r5 bash "node --test"
r6 final answer
```

Codex, five tool calls, one of them doing four things:
`sed -n '1,240p' test/range.test.mjs && sed -n '1,240p' src/range.js && cat package.json && node test/range.test.mjs`.

### 2b. cli-flag — the worst task, and the toolbox guess is why

Branch 12 rounds, five of them finding tools. The cause is visible in the first event of the run:

```
catalog.preselected  guessed: ["documents"]
```

The request was *"Add a `--shout` flag to cli.mjs … Document the flag in README.md."* The word
"Document" opened the **documents** toolbox and the code toolbox lost every place. `loaded=9` tools
against the 14 every other coding task got. The model then had to buy back `files.read`,
`files.write`, `code.run` and `code.check` one search at a time.

Worse, it bought `code.run` **twice**:

```
r2  tools.describe -> loaded code.map, code.patch, code.check, code.run
...
r9  tools.describe -> loaded code.run          <- the same tool again
```

Between r2 and r9 `code.run` was pushed off the list by tools that arrived later. This is exactly
the defect `mac7/speed` calls item D, seen here on a real model: **one wasted round, measured.**

Pi, 5 rounds, nothing spent on finding anything:

```
r1 read cli.mjs + read README.md          (two calls, one round)
r2 bash "ls -la && find . -maxdepth 2 -type f | sort"
r3 edit cli.mjs
r4 edit README.md
r5 bash "node cli.mjs --name Ada --shout && node cli.mjs --shout --name Ada && node cli.mjs --shout"
```

Codex, 3 commands + 1 apply:

```
cmd  ls -la && rg -n "name|Hello|cli" cli.mjs README.md
cmd  sed -n '1,120p' cli.mjs && sed -n '1,120p' README.md && git status --short
edit update README.md, update cli.mjs          (both files, one change)
cmd  node cli.mjs --name Ada --shout && node cli.mjs --shout --name Ada && node cli.mjs --name Ada && node cli.mjs --shout
```

**Branch 12 rounds against Pi's 5, and the five tool-finding rounds are the whole difference.**
Both others verified the flag by running the program in every order; Branch was refused and said so.

### 2c. rename — four rounds to change four files

Branch, 11 rounds. Rounds 6, 7, 8 and 9 are four separate `files.edit` calls, one file each:

```
r5  files.read x4 + files.search "getUsr"        (five calls in one round — Branch does batch)
r6  files.edit  src/users.js
r7  files.edit  src/admin.js
r8  files.edit  src/profile.js
r9  files.edit  test/users.test.mjs
r10 files.search x2 + code.check
```

Branch **has** a multi-file change tool — `files.patch`, `code.patch`, `code.change_set` — and it
used `files.patch` on other tasks. It did not use it here because it never saw it. The search that
chose the edit tool was:

```
query: "read and edit plain text project files; search text across workspace"
found: files.edit, scratch.text.search, files.search, projects.notes, files.read,
       knowledge.search, memory.block_edit, documents.edit, history.read, files.grep
```

`files.patch` is not in that list. The model got the one-file-at-a-time tool and paid three extra
rounds for it.

Pi: one round, four `edit` calls. Codex: one `file_change` naming four files.

### 2d. extract-helper — where Branch actually failed, and it was not reasoning

`branch-sub` (matched permissions) is the 11/12 row. The one failure:

```
r1  files.glob "src/cart.js" + tools.expand ["git"]
run.finished  status: failed
output: "Provider HTTP 400; check endpoint, model, credential, and quota"
```

Two faults, neither about coding:

- **Branch gave up on the first HTTP 400.** `src/provider-retry.ts` retries only quota and
  rate-limit codes; a 400 ends the run. Codex and Pi finished the same task on the same endpoint
  minutes apart.
- **The sentence the person is left with is developer jargon** —
  `src/provider-retry.ts:38` builds `Provider HTTP ${status}…; check endpoint, model, credential,
  and quota` and that string is the run's whole output. The intent list says a refusal is a plain
  sentence. This is not one.

With defaults, the same task took 9 rounds and passed:

```
r1 tools.search "read workspace file contents" + tools.search "run shell command in workspace"
r2 tools.describe -> loaded files.read/write/edit, unknown: "shell.execute"
r3 tools.search "execute node --test workspace command"
r4 tools.describe -> loaded code.check, workspace.map
r5 files.read src/cart.js + files.read src/invoice.js + workspace.map
r6 files.read package.json
r7 files.write src/format.js + files.edit src/cart.js + files.edit src/invoice.js
r8 code.check -> "ran": false
r9 final answer, ending "I could not execute `node --test`: test execution is not permitted"
```

Pi, 7 rounds:

```
r1 bash "ls src && rg -n -C 3 'formatPrice' src && find . -maxdepth 2 -type f | sort"
r2 read src/cart.js + read src/invoice.js + read package.json
r3 write src/format.js
r4 edit src/cart.js
r5 edit src/invoice.js
r6 bash "node --test"
r7 "Verified with `node --test` — all tests pass."
```

Codex, 2 commands + 1 apply + a check — and the apply carried all three files at once, including
the new one:

```
cmd  pwd && rg -n -C 3 "formatPrice|module\.exports|export" src test package.json
cmd  rg --files | rg '(^|/)(cart|invoice|format|package|.*test.*)\.(js|json)$' && sed -n '1,120p' package.json && sed -n '1,80p' src/cart.js && …
edit update cart.js, add format.js, update invoice.js
cmd  node --test && git diff --check && git diff -- src
```

Branch's r7 did the same three-file change in one round, so **on the change itself Branch matched
Codex.** The four rounds it lost were r1–r4, all tool-finding.

### 2e. The control — missing-await, where Branch wins

```
r1 code.map + code.check          (two calls, one round)
r2 files.read x2 + files.list     (three calls, one round)
r3 files.write src/store.js
r4 final answer
```

Four rounds against Pi's five. `catalog.preselected` guessed `["code"]`, the right tools were
already there, nothing was searched, and the machinery batched happily. **The loop is not the
problem.** When the right tools happen to be loaded, Branch is already the best of the three.
`word-wrap` is the same story: 4 rounds against Pi's 4.

---

## 3. Structural differences, checked against the source

### 3a. Branch already batches. It just does not run the batch in parallel.

`docs/agents/STATUS-speed.md` says every `model.completed` row returned "0 or 1 tool calls — never
two". That was measured on a scripted provider against an older database. On the real model in
window8 the opposite is true: **23 of Branch's 95 rounds carried more than one call** (24%), against
Pi's 12 of 63 (19%). Branch batches *more often than Pi already*.

That changes what `mac7/speed`'s items are worth:

- **B** (tell the model it may batch) is aimed at behaviour that already happens a quarter of the
  time unprompted. Still probably worth a line, but it is not the lever.
- **C** (`files.read_many`) — the model already issues three and four parallel `files.read` calls.
  The tool shape is not what was stopping it.
- **A** (run the group concurrently) is real but small on file work. Measured from the timestamps
  of fix-range round 8:

  ```
  00:21:31.112 start  files.read     .172 done
  00:21:31.222 start  files.read     .281 done
  00:21:31.336 start  files.read     .428 done
  ```

  Strictly sequential, 316 ms wall. Run together it would be about 92 ms — **224 ms saved against a
  6000 ms round.** Item A pays only when the tools in a group are slow (two test runs in one round),
  not on reads.

### 3b. The tool catalog is the round sink — and it is a Branch-only cost

| | tools the model can call in round 1 | rounds spent finding tools |
|---|---|---|
| Pi | 4 (`read`, `bash`, `edit`, `write`) | 0 of 63 |
| Codex | shell + apply_patch | 0 of ≥62 |
| Branch | 9–14 shown, of 214 available, 160 deferred | **27 of 95** |

Pi's whole tool section, quoted from its own system prompt in the transcript:

```
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files
```

Branch's catalog costs roughly 2000–2450 estimated tokens a round (`catalog.size` events) to say
less. Its deferral machinery is the right idea for a 294-tool product — but for a coding task it is
charging 28% of the rounds to rediscover six tools it could have had for free.

### 3c. No prompt cache, on any round

`cachedInput` is **null on all 185 Branch rounds** in window8 — not zero, absent: the endpoint
reported no cached tokens at all. `reported.input` is present on the same rows, so usage was parsed;
the cached count simply was not there.

On the same endpoint, the same morning:

- Codex, `fix-range`: `"cached_input_tokens": 77312` of `"input_tokens": 91292` — **85% cached**.
- Pi: `"cacheRead": 1536` on most rounds.

Two candidate causes, and they need different fixes:

1. **Request shape.** `src/chatgpt-provider.ts:79` sends `store: false` and no `prompt_cache_key`.
2. **Prefix churn.** The tool list is rebuilt each round: fix-range's `catalog.size` characters run
   9391 → 9482 → 8602 → 8187 → 7979 over the first five rounds.

The data separates them. In fix-range rounds 6–10 the character count sits unchanged at 7979 — the
prefix is stable — and `cachedInput` is still null. **So churn alone does not explain it; the
request shape is implicated.** Fixing churn (speed's item D) is right on its own merits but will not
by itself buy the cache.

This is the only item on the list that is pure win: it costs nothing to the intent list, changes no
behaviour a person can see, and it is where the 1.31× per-round gap against Pi most likely lives.
Sizing: 1.4 s per round × 95 rounds ≈ 130 s over the set if the whole per-round gap were cache —
**an upper bound, estimated, not measured**, since prompt size also differs (Branch 2.0–4.6k input
tokens a round, Pi 1.1–2.5k).

### 3d. How each one applies an edit

- **Pi**: one `edit` tool, "including multiple disjoint edits in one call", and the rules tell it to
  merge: *"When changing multiple separate locations in one file, use one edit call with multiple
  entries in edits[] instead of multiple edit calls."* Result: rename in one round.
- **Codex**: one `apply_patch` that carries several files, including new ones. `extract-helper` was
  `update cart.js, add format.js, update invoice.js` in a single change.
- **Branch**: has all of it — `files.edit`, `files.patch`, `code.patch`, `code.change_set` — and got
  the single-file one four times in a row on `rename` because the multi-file one did not surface in
  the search. **The capability is not missing. The routing to it is.**

### 3e. How each one verifies

- **Pi** ran the project's test suite on 10 of 12 tasks, as the last thing before answering. On
  `cli-flag` it ran the program itself three ways instead
  (`node cli.mjs --name Ada --shout && node cli.mjs --shout --name Ada && node cli.mjs --shout`);
  on `update-docs`, a documentation-only change, it ran nothing.
- **Codex** ran it on all 12, and usually with `git diff --check && git diff` chained after it, so
  it reads back the change in the same call. On `flaky` it ran the test **20 times in one command**
  (`for i in $(seq 1 20); do …; done`) and then 50 times against one test name — a loop Branch has
  no shape for in a single call.
- **Branch, shipped defaults**, was refused on 8 of 12 tasks. Its answers then hedge:
  *"I couldn't run `node --test` because test execution isn't permitted for this workspace"*
  (fix-range), *"I also attempted to run CLI checks, but script/test execution is not permitted"*
  (cli-flag). All 12 still passed the scorer, so the code was right — but the person is handed an
  unverified answer.

The refusal text itself is good and does its job (`src/coding/project-tests.ts`); it tells the
person exactly how to allow it. The cost is one round plus a weaker answer, on two thirds of tasks.

### 3f. How each one presents files and finds them

Branch has a repo map and it works: `workspace.map`/`code.map` returned the whole three-file project
with symbols in 115 ms. It was used on 9 of 12 tasks and is at least as good as anything the others
have — Codex reaches the same place with `rg --files` and Pi with `ls -la && find .`. **This is not
a gap.** The gap is that on 4 tasks the map round came *after* two or three tool-finding rounds.

### 3g. Can Branch have both? The shapes worth evaluating

The finding that matters for this question: **the rounds are not being spent on safety.** Zero on
asking, zero on refused edits. So the shapes that collapse rounds mostly do not have to trade
against the intent list at all.

| shape | rounds it removes | what it costs the intent list |
|---|---|---|
| **A coding task starts with its six tools** (speed's item E) | up to 27 of 95 | nothing — no permission changes, every tool still goes through the same gate. It is a *presentation* change, not a policy one. |
| **A search result is callable in the same round** | ~8 of 27 (the search→describe→use chain) | nothing — the tool was already allowed or it would not be in the index (`src/tool-loading.ts:195-196`) |
| **Name the shell what the model calls it** (an alias `bash`/`shell` → `code.run`) | ~4 (fix-range r2–r5, extract-helper r1/r3) | nothing; an alias is not a permission |
| **When a capability is switched off, say so once in the instructions** instead of letting the model discover it | ~8 blocked rounds | nothing — it tells the truth earlier, which is the intent, not against it |
| **One approval covering a declared batch of file changes** | ~0 here | real risk, and **no measured benefit in this data** — nothing was ever asked. Do not build this on this evidence. |
| **Plan-then-apply: the model proposes a change set, one yes applies it** | ~3 (rename) | small — it is what `code.change_set` already is. The win is routing to it, not a new approval shape. |
| **A sandboxed scratch area where reads and dry runs need no yes** | ~0 here | reads already needed no yes. No measured benefit. |
| **A repo map so files are found without a round** | ~0 | Branch already has one and it is good |

The two shapes the brief offered that look most like "trading safety for speed" — batch approval and
a no-approval scratch area — are the two with **no measured benefit at all** in this data. That is
the most useful single result in this document: *Branch does not have to give anything up.*

---

## 4. What Branch lacks outright for coding work

Cross-checked against `~/Code/agent-refs/rescans/closed-audit-2026-09-18.md`,
`re-audit-2026-09-18.md`, the competitors' source, and `src/` on this branch. Features Branch has
but ships off are **not** listed — they are choices, not gaps.

| missing | seen in | affects | evidence |
|---|---|---|---|
| A call that chains several commands and reports them together | Codex (34 of its 37 commands were chained with `&&`, `;` or a `for` loop) | **speed** | `logs/codex-sub__*.out` |
| Retry, or a plain sentence, on a provider 4xx | Pi and Codex both finished `extract-helper`; Branch ended on `Provider HTTP 400…` | **finishing the work** | `src/provider-retry.ts:5-21`, `logs/branch-sub__extract-helper__r1.a1.out` |
| A search result usable in the round that found it | Pi and Codex have no search at all | **speed** | `src/tool-loading.ts:207` |
| Shell output saying which files a command changed behind Branch's back | Claude Code 2.1.27x | neither (nice to have) | closed audit line 107; `src/coding/format-on-edit.ts` only sees Branch's own edits |
| Reading a project's declared container so the agent gets the project's real toolchain | VS Code 1.138 | **finishing the work**, on real projects | closed audit line 136 |
| A goal that outlives the conversation (standing project, parallel threads, one shared memory) | Claude Projects, Cursor Projects | **finishing the work**, on large jobs | closed audit "Bucket 1" — the audit calls it "the one genuine feature-shaped hole" |
| A global shortcut / "send the agent what I'm looking at" | Codex desktop, Gemini | neither, for coding | closed audit line 93 |

Everything else in the coding column of `docs/agents/coding-bench.md` is present. The honest summary
is the one that audit already reached: **Branch is not behind on coding features. It is behind on
how many rounds it takes to reach them, and on what happens when something goes wrong.**

---

## 5. Ranked

Rounds removed are out of Branch's 95 in window8. **Measured** means counted from the census;
**estimated** shows its assumption. Risk is to the intent list in COMMON-RULES.

| # | change | rounds removed | how that number was reached | risk | size | overlaps `mac7/speed` |
|---|---|---|---|---|---|---|
| 1 | A coding task starts with `files.read`, `grep`, `list`, `glob`, `edit`/`patch`, `run` already loaded — and no one toolbox takes every place | **up to 27 (28%)** | measured: all 27 find-a-tool rounds; `missing-await` and `word-wrap` had 0 because the guess was right | none — presentation, not policy; every call still gates | medium — a starting set plus a fix to how places are shared out | **yes, item E** — window8 confirms both halves: `cli-flag` guessed `["documents"]` and was the worst task  |
| 2 | A tool the product puts on the list mid-task is never pushed off again | **1 measured, more likely** | measured: `cli-flag` r9 re-loaded `code.run` after r2 already had it | none — a bug fix | small — a one-line ordering fix | **yes, item D**  |
| 3 | Ask the provider for its prompt cache (`prompt_cache_key`, review `store: false`) | 0 rounds; **~0.5–1.4 s a round, estimated** | estimated: Branch 6.0 s vs Pi 4.6 s a round, Codex 85% cached and Branch 0% on the same endpoint; upper bound 1.4 s × 95 ≈ 130 s | none — invisible to the person | small — one field in `responsesBody`, then re-measure | no  |
| 4 | Say once, in the instructions, that tests/scripts are not allowed here — instead of letting the model find out | **8 measured** | measured: 8 `blocked` rounds. The answer stays honest either way — it is still unverified — but it becomes a plain statement instead of a report of a failed attempt | none — it tells the truth sooner | small — one sentence, built from what the run already knows | no  |
| 5 | A search result is callable in the round that found it | **~8, estimated** | estimated: 8 of the 27 finding-rounds were a `tools.describe` that only turned a search hit into a callable tool | none — the index only holds tools this task may already use | medium — search would have to return a usable tool, not a pointer | no  |
| 6 | Route a several-file change to `files.patch`/`code.change_set` instead of `files.edit` | **~3 measured** | measured: `rename` r6–r9, four one-file edits where one patch would do | none — same permission, same gate | small — ranking and wording, no new tool | no  |
| 7 | Alias the shell to the names models actually reach for (`bash`, `shell`) | **~4, estimated** | estimated: fix-range r2–r5 and extract-helper's `unknown: ["shell.execute"]` | none | small — alias names in the index | no  |
| 8 | Retry a provider 4xx once, and end on a plain sentence if it fails | **0 rounds, 1 task finished** | measured: 1 of 12 `branch-sub` tasks | none — it is the intent list, not against it | small — one rule in `provider-retry.ts` and one sentence | no  |
| 9 | Run an independent read-only group concurrently | **0 rounds; 224 ms measured on reads** | measured from fix-range r8 timestamps | this is where "never break" is easiest to lose | medium — already built on `mac7/speed`, behind a switch | **yes, item A**  |
| 10 | A `files.read_many` tool | **0** | measured: the model already sends 3–4 parallel `files.read` | none | small — already built on `mac7/speed` | **yes, item C** — window8 says the tool shape was not the blocker  |
| 11 | One approval covering a batch of changes; a no-yes scratch area | **0** | measured: `user.ask` called 0 times; `failedEdits` 0 on every row | real | large — and not justified by this data | no — **do not build on this evidence**  |

### The three I would do next

1. **Give a coding task its tools before round one** (#1, with #2 as part of it). It is the only
   item worth more than a couple of rounds — up to 27 of 95, and `missing-await` and `word-wrap`
   prove the rest of the machine is already faster than Pi once the tools are there. `mac7/speed` is
   building it; window8 says it is aimed correctly and that the toolbox share-out half matters as
   much as the coding starter set (`cli-flag`: `guessed: ["documents"]`, 12 rounds, worst of the
   twelve).
2. **Ask for the prompt cache** (#3). Zero risk, invisible, and it is the only thing that touches
   the *other* two fifths of the gap — the 1.31× per-round cost. Branch is the only one of the three
   getting no cache on the same endpoint. One line in `responsesBody`, then re-measure `cachedInput`
   in the next window.
3. **Tell the model what is switched off, and don't let a 4xx end a task** (#4 and #8). Together
   they remove 8 rounds and recover one lost task, and they fix two places where Branch breaks its own
   rules: an answer that reports a failed attempt rather than stating plainly what was not allowed, and `Provider HTTP 400; check endpoint, model,
   credential, and quota` shown as a finished task's whole output.

### What is not worth copying

- **Codex's chained shell.** It is why Codex finishes in few calls, and it is also why Codex's
  per-round cost is at best no better than Branch's (406 s over at least 62 rounds is ≤6.5 s, against Branch's 6.0 and Pi's 4.6), and why its
  `fix-range` run ended on a 129-line `git diff` usage dump it had to read. More importantly a
  chained command is one approval for many effects — the exact thing Branch's gate exists to
  prevent. Branch should collapse rounds by *loading the right tools*, not by handing the model a
  chain it can hide a change inside.
- **A batch approval, and a scratch area where changes need no yes.** Both were offered by the
  brief; both have **zero** measured benefit in this data, because approvals cost zero rounds. They
  would spend the intent list for nothing.
- **Pi's tiny fixed tool set as a design.** Four tools is right for Pi, which does one thing. Branch
  has 294 tools because it does many. The lesson to take is the *starting set for a coding task*,
  not the deletion of the catalog.
- **Hermes's shape**, whatever it is: 8/12, 113 rounds, 2661 s. Nothing here to copy.
- **The desktop companion and global shortcut** from the closed audit: real gaps, but they do not
  touch coding rounds. Not this list.

---

## Licences

Everything read for this document is open: **Pi is MIT** (`~/Code/agent-refs/pi/LICENSE`,
"Copyright (c) 2025 Mario Zechner"), **Codex is Apache 2.0**
(`~/Code/agent-refs/codex/LICENSE`).

**Nothing here proposes porting code.** Every item above is a shape re-described in Branch's own
words against Branch's own source — a starting tool set, a cache key, a sentence in the
instructions, a retry rule. No notice is required for any of it.

If anyone later did copy source: MIT (Pi) needs the copyright line and the permission notice kept
with the copied part; Apache 2.0 (Codex) needs the licence, the NOTICE file if one is carried, and a
statement of what was changed. Both would also break the rule that Branch takes no new dependency,
so in practice neither should be copied at all.

## How to re-run the counts

The parsers used here are throwaway; the raw evidence is not. On the VM:
`/workspace/bench/cg/window8/results.jsonl` (one row per cell) and `logs/*.a1.out` — Branch's rows
are its own event journal as JSON, Pi's are JSONL with one `turn_start` per model round, Codex's are
its item stream. Counting Branch's rounds is `model.started`; counting what a round did is the first
`tool.started` after it.
