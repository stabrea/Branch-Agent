# The scoreboard

Built 2026-09-18 21:00 UTC from `experiments/scoreboard/results.jsonl`.

Read **What this is not**, at the bottom, before quoting any number from here.

## The board

The evaluation suite was asked whether these contestants may be put beside each other at all, and raised no objection: every row below was measured on one machine, against one model, with one deadline, over one unchanged task set, marked by one unchanged set of programs.

| agent | tasks passed, per pass of the board | median run | stopped by the clock | model calls | tokens in/out | had to be rescued |
|---|---|---|---|---|---|---|
| Branch Agent 0.17.0 (+ the reply-ceiling fix) | **20%** (20%–20% over 1) | 182s (74s–300s) | 1 of 10 | 2.8 | 55171 / 14154 | 7 of 10 |
| OpenClaw 2026.9.4 (3a9d69d) | **10%** (10%–10% over 1) | 301s (144s–301s) | 5 of 10 | 3.2 | 78969 / 21597 | 5 of 10 |

### Task by task

How many of that agent's attempts at that one task passed.

| task | what it is | Branch Agent 0.17.0 | OpenClaw 2026.9.4 |
|---|---|---|---|
| `fix-sum` | fix a failing test in a small repository | 0/1 | 0/1 |
| `fix-slug` | fix a failing test in a small repository | 0/1 | 0/1 |
| `find-retry` | find where something is implemented | 1/1 | 0/1 |
| `explain-limit` | find something and explain it | 1/1 | 1/1 |
| `script-total` | write a short script that runs | 0/1 | 0/1 |
| `script-report` | write a short script that runs | 0/1 | 0/1 |
| `count-todos` | read a folder and answer a question about it | 0/1 | 0/1 |
| `summarise-docs` | summarise a folder of documents | 0/1 | 0/1 |
| `rename-fee` | make the same change across several files | 0/1 | 0/1 |
| `staged` | follow a two-step instruction with a hold in the middle | 0/1 | 0/1 |

### What each task does and does not prove

**`fix-sum`** — fix a failing test in a small repository. A pass proves that the agent read a failing test, found a one-character bug in a loop and changed the source rather than the test. It does not prove anything about larger repositories: this is six lines in one file, and the pristine tests are put back before marking, so a pass here is a real fix and nothing more.

**`fix-slug`** — fix a failing test in a small repository. A pass proves the same, on a bug whose fix is a regular expression rather than an index. It does not prove that an agent good at this is good at debugging: both bugs are visible in one file that the failing test names.

**`find-retry`** — find where something is implemented. A pass proves that the agent searched three files and named the right file and the right function. It does not prove that it understood the retry policy — it was asked to point, not to explain, and a grep would pass this too.

**`explain-limit`** — find something and explain it. A pass proves that the agent found the right file and knew the usual name of the algorithm in it. It does not prove depth of understanding: the words 'token bucket' are in a comment in that file, so reading it is enough.

**`script-total`** — write a short script that runs. A pass proves that the agent wrote a program that runs, reads a file it was not shown the contents of, and gets the arithmetic right (a hard-coded total is failed on purpose). It does not prove that it can write a program of any size: this is about ten lines.

**`script-report`** — write a short script that runs. A pass proves the same, plus getting an exact output shape right — a JSON object with two named keys and nothing else printed. It does not prove that it handles real data: six records, one boolean field.

**`count-todos`** — read a folder and answer a question about it. A pass proves that the agent read every file in a folder and counted correctly, including a block comment, while not counting a FIXME. It does not prove reading comprehension in general: it is one counting question, and a wrong count by one fails exactly like a wrong count by five.

**`summarise-docs`** — summarise a folder of documents. A pass proves that the agent opened four documents and wrote a file naming what each one decided. It does not prove summary quality: the check looks for four literals, so a summary that is correct but bloodless passes and a graceful one that drops a figure fails.

**`rename-fee`** — make the same change across several files. A pass proves that the agent made the same change in three files, not just the one the test imports, and left no old name behind. It does not prove that it can refactor: this is a rename with three call sites and no ambiguity.

**`staged`** — follow a two-step instruction with a hold in the middle. A pass proves that the agent did the first step, stopped, and asked before the second — plain instruction-following with a hold in it. It does not prove anything about any agent's own approvals feature. It is deliberately written so none of the three can use its own, because a task built on Branch's approvals would measure Branch's user interface.

### Where the ranges actually separate

Two agents are only called apart here when the range of one does not touch the range of the other over the repeats. Everything else is a tie as far as this board can tell.

- Tasks passed: **no claim between Branch Agent 0.17.0 and OpenClaw 2026.9.4** — the board was run through once (20% against 10%), and one pass has no range at all. A difference this size may be real or may be the afternoon. Run it again to find out.
- Time: **Branch Agent 0.17.0 and OpenClaw 2026.9.4 overlap** (74s–300s against 144s–301s); no claim either way.


## Shown, not scored

**Branch Agent 0.17.0 (as on mac7/eval-honesty, b23532d9)** — unmodified. Run once over the task set to show what the fix above is a fix for — a demonstration, not a contestant with a spread.

One pass over 10 tasks: **2 passed**. This is a single pass, so it has no spread and supports no claim that anything beats anything. It is here to show what those changes were worth.

- run status failed: Provider stream ended without a complete response
- named src/backoff.js and nextDelay
- named src/limiter.js and the token bucket
- run status needs_input: Where is the function calcFee defined in this repository?

### How much of this is the clock

6 of 30 runs were stopped by the harness at the deadline rather than finishing. Where that number is large for an agent, its score is **not** a statement about what it would eventually have produced — only that it did not produce it inside the deadline every contestant was given. A longer deadline was not affordable: the contestants have to be interleaved inside one window for the comparison to mean anything, and the window is already hours long. This board cannot tell slow apart from never-finishing.

Separately, some runs ended with the program reporting no error at all and returning an empty answer — which reads to a person as "it finished" when nothing was produced:

- **Branch Agent 0.17.0 (+ the reply-ceiling fix)**: 2 of 10 runs

## Did anyone touch the marking?

No. On every one of the 30 runs, the files that decide a task were exactly as they started. The check does not rely on that — the pristine copies are restored before marking regardless — but nothing had to be restored.

## The load it ran under

This machine runs the owner's own work and cannot be quietened. The contestants were therefore interleaved — one task at a time, each agent in turn, then round again — so that a quiet stretch could not be handed to whichever agent happened to be running in it. Load average over the whole window: **5.7 to 16.6** on 5 processors.

> 1 result(s) from pass 2 and later were left out of everything above: that pass of the board did not finish, and a half-finished pass has a smaller denominator that would flatter whichever agent happened to be in it. They are still in the results file.

## What this is not

- **Cost is not compared.** There is no price on file for a model running on the owner's own card, so no money figure is printed at all; were one printed it would be part measured, part estimated — do not read this as a bill. The token counts above are what each program reported, and the three programs do not count the same things: one reports what the provider said, one adds its own estimate when the provider says nothing, and they disagree about whether a reasoning block is output. The columns are printed so the difference in prompt size is visible, not so the totals can be divided into money.
- **Claude Code is not on this board and cannot be.** It talks only to Anthropic's API, so it cannot use the P40 at all. Putting it here would mean one contestant on a frontier hosted model and three on a 4B local one, which is a different contest, not a closer one.
- **The tool surfaces are not the same**, and nothing can make them the same. Each agent's is recorded with its rows; a task can be won by having the right built-in tool rather than by judging well.
- **The harness was kinder to some rows than others.** 4 run(s) were given a second attempt because their error looked like the model server failing rather than the agent (Branch Agent 0.17.0: 4). At least some of those were the agent's own timeout rather than the server's — see FINDINGS.md, F6 and F7. No verdict changed, because every retried run failed again, but it is a thumb on the scale and it is named here rather than quietly removed.
- **These timings do not transfer.** They were measured on one oversubscribed VM inside one window. Only the differences measured inside that window mean anything, and only where the ranges separate.
