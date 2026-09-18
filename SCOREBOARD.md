# The scoreboard

Built 2026-09-18 17:27 UTC from `experiments/scoreboard/results.jsonl`.

Read **What this is not**, at the bottom, before quoting any number from here.

## The board

Only one contestant has results here, so there is no comparison and nothing for the evaluation suite to certify. What follows is one agent's figures, not a ranking.

| agent | tasks passed, per pass of the board | median run | model calls | tokens in/out | had to be rescued |
|---|---|---|---|---|---|
| Branch Agent 0.17.0 (+ the reply-ceiling fix) | **0%** (0%–0% over 1) | 65s (65s–65s) | 1.0 | 2745 / 1536 | 1 of 1 |

### Task by task

How many of that agent's attempts at that one task passed.

| task | what it is | Branch Agent 0.17.0 |
|---|---|---|
| `fix-sum` | fix a failing test in a small repository | 0/1 |

### What each task does and does not prove

**`fix-sum`** — fix a failing test in a small repository. A pass proves that the agent read a failing test, found a one-character bug in a loop and changed the source rather than the test. It does not prove anything about larger repositories: this is six lines in one file, and the pristine tests are put back before marking, so a pass here is a real fix and nothing more.

### Where the ranges actually separate

Two agents are only called apart here when the range of one does not touch the range of the other over the repeats. Everything else is a tie as far as this board can tell.



> **branch** — 29 of 30 piece(s) of this run produced no result (branch__fix-slug__r1, branch__find-retry__r1, branch__explain-limit__r1, branch__script-total__r1, branch__script-report__r1, and more), so every figure below is over the 1 that did. Run it again to fill them in before quoting any of these numbers.

> **branch-trunk** — 9 of 10 piece(s) of this run produced no result (branch-trunk__fix-slug__r1, branch-trunk__find-retry__r1, branch-trunk__explain-limit__r1, branch-trunk__script-total__r1, branch-trunk__script-report__r1, and more), so every figure below is over the 1 that did. Run it again to fill them in before quoting any of these numbers.

## Shown, not scored

**Branch Agent 0.17.0 (as on mac7/eval-honesty, b23532d9)** — unmodified. Run once over the task set to show what the fix above is a fix for — a demonstration, not a contestant with a spread.

One pass over 1 task: **0 passed**. This is a single pass, so it has no spread and supports no claim that anything beats anything. It is here to show what those changes were worth.

- run status failed

## Did anyone touch the marking?

No. On every one of the 2 runs, the files that decide a task were exactly as they started. The check does not rely on that — the pristine copies are restored before marking regardless — but nothing had to be restored.

## The load it ran under

This machine runs the owner's own work and cannot be quietened. The contestants were therefore interleaved — one task at a time, each agent in turn, then round again — so that a quiet stretch could not be handed to whichever agent happened to be running in it. Load average over the whole window: **14.5 to 14.8** on 5 processors.

## What this is not

- **Cost is not compared.** There is no price on file for a model running on the owner's own card, so no money figure is printed at all; were one printed it would be from the tokens the provider reported. The token counts above are what each program reported, and the three programs do not count the same things: one reports what the provider said, one adds its own estimate when the provider says nothing, and they disagree about whether a reasoning block is output. The columns are printed so the difference in prompt size is visible, not so the totals can be divided into money.
- **Claude Code is not on this board and cannot be.** It talks only to Anthropic's API, so it cannot use the P40 at all. Putting it here would mean one contestant on a frontier hosted model and three on a 4B local one, which is a different contest, not a closer one.
- **The tool surfaces are not the same**, and nothing can make them the same. Each agent's is recorded with its rows; a task can be won by having the right built-in tool rather than by judging well.
- **These timings do not transfer.** They were measured on one oversubscribed VM inside one window. Only the differences measured inside that window mean anything, and only where the ranges separate.
