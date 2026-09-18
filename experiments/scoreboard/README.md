# The scoreboard

What this is: a way to find out whether Branch Agent is any good compared with the other agents the
owner could run instead — measured, with ranges, on one machine, against one model, over work a
person would recognise.

What it is not: a benchmark suite. There is no leaderboard to climb and no score to optimise. If a
number here cannot be defended it should not be printed, and the code is arranged to make printing
an indefensible number harder than not printing one.

## The five files

| file | what it holds |
|---|---|
| `tasks.mjs` | the ten pieces of work, and the **program** that decides each one |
| `contestants.mjs` | how each agent is handed a task and how its answer is read back |
| `run-scoreboard.mjs` | the runner: one window, round-robin, a record appended per run |
| `report-scoreboard.mjs` | the page — and the refusal that replaces it when the runs do not match |
| `board-conditions.mjs` | one contestant's conditions, rebuilt from the rows it actually produced |
| `hermes-driver.py` | Hermes has no one-shot CLI; this is the object its own README points at |

`FINDINGS.md` holds what was found out about Branch itself on the way.

## The three rules it is built around

**No model decides a pass.** Every check is a program: it runs a test suite, runs a script the agent
wrote and compares the output, or looks for a literal string. Nothing can be talked into a pass.
`mac7/eval-honesty` built an isolated judge for the cases where a model must grade; this task set is
shaped so that none of them arise.

**A check cannot be reached by the thing it checks.** For every task decided by a test suite, the
pristine tests are copied back over the folder *after* the agent has finished and *before* the check
runs, so deleting or weakening a test gets the original back. Every file is hashed before and after,
so the attempt is recorded rather than merely defeated. The check also runs with `NODE_TEST_CONTEXT`
and `NODE_OPTIONS` stripped, because a verdict must not depend on who asked for it.

**A comparison is refused before it is made.** Every row carries the conditions it was measured
under. Before any two contestants are put beside each other, `comparisonRefusal` from
`src/evaluation-honesty.ts` is asked whether they may be — and if the model, the machine, the
deadline, the task set or the scorers differ, no table is printed at all. What gets printed is what
differed. `tests/scoreboard.test.mjs` holds that behaviour down.

## Running it

The rig is described in `~/Code/branch-coordination/RIG.md`. Everything below assumes it.

```sh
# on taofik-ai, with the loopback forward to the P40 up
export PATH=/workspace/bench/node/bin:$PATH
cd /workspace/bench/branch
node experiments/scoreboard/run-scoreboard.mjs \
  --repeats 3 --timeout 420 \
  --scratch /workspace/bench/board --out /workspace/bench/board/results.jsonl

node experiments/scoreboard/report-scoreboard.mjs \
  --results /workspace/bench/board/results.jsonl --out SCOREBOARD.md
```

`--only`, `--tasks` and `--demo` narrow a window; `--max-repeat` tells the report to leave out a pass
of the board that did not finish, rather than averaging a smaller denominator into everything else.

Keep the model resident while a window runs (`keep-model-warm.sh`): loading 12 GB off the array costs
well over a minute, and whichever agent paid for it would look slow rather than unlucky.

## What the rig had to be changed to

- The board runs at a **65536-token window** because **Hermes refuses any model under 64K** — not
  because 64k was the neutral choice. The model `qwen3-4b-64k` is `qwen3:4b` with `num_ctx 65536`;
  qwen3:4b's own window is 262144, so this is inside what the weights support.
- Three derived models were added to the owner's `branch-ollama` container and should be removed
  when this work is done: `qwen3-4b-16k`, `qwen3-4b-64k`, `qwen3-4b-64k-nothink`. The last is a dead
  end — closing the template's `<think>` block moved the reasoning into the answer, which is worse
  than leaving it alone — and is kept only so nobody tries it twice.

  ```sh
  docker exec branch-ollama ollama rm qwen3-4b-16k qwen3-4b-64k qwen3-4b-64k-nothink
  ```

- Each contestant runs against its own config and state directory under `/workspace/bench`. None of
  them reads or writes the owner's settings, and none starts with the owner's history.

## Claude Code

It is not on the board. It talks only to Anthropic's API and cannot use the P40 at all, so putting
it here would mean one contestant on a frontier hosted model and three on a 4B local one. That is a
different contest, not a closer one, and no amount of rig work fixes it.
