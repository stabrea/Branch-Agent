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

- The board runs at a **16384-token window** (`qwen3-4b-16k` = `qwen3:4b` with `num_ctx 16384`).
  Not 64K, which was tried first: a 64K context does not fit the 4 GiB memory cage the rig puts
  round the Ollama container, and the kernel killed `llama-server` seven times before that was
  understood. The cage is what stops a memory squeeze taking one of the owner's virtual machines
  instead, so it stays. See FINDINGS.md, F4.
- **Hermes is not on the board**, because it refuses any model under 64K and 64K does not fit the
  cage. The one setting that would talk it round is a lie about the model's real window, and was not
  used. See FINDINGS.md, F5. The rest of the harness still knows how to drive it, for a machine that
  can hold a 64K model.
- The **loopback forwarder** had a thirty-second timeout that applied to reading the reply, not only
  to connecting, and it severed most model calls under load. It is fixed in place, with the original
  kept beside it as `ollama-forward.py.orig`.
- Three derived models were added to the owner's `branch-ollama` container and should be removed
  when this work is done: `qwen3-4b-16k`, `qwen3-4b-64k`, `qwen3-4b-64k-nothink`. The last is a dead
  end — closing the template's `<think>` block moved the reasoning into the answer, which is worse
  than leaving it alone — and is kept only so nobody tries it twice.

  ```sh
  docker exec branch-ollama ollama rm qwen3-4b-16k qwen3-4b-64k qwen3-4b-64k-nothink
  ```

- Each contestant runs against its own config and state directory under `/workspace/bench`. None of
  them reads or writes the owner's settings, and none starts with the owner's history.

## Everything this left running, so it can be stopped

RIG.md keeps a list of what the rig installed; this is what the board added on top of it.

| what | where | stop or remove it with |
|---|---|---|
| derived models `qwen3-4b-16k`, `qwen3-4b-64k`, `qwen3-4b-64k-nothink` | the owner's `branch-ollama` container | `docker exec branch-ollama ollama rm qwen3-4b-16k qwen3-4b-64k qwen3-4b-64k-nothink` |
| the window itself | `taofik-ai`, systemd **user** unit | `systemctl --user stop bench-scoreboard` |
| the keep-warm pinger (it holds ~12 GB of the P40 on a 24-hour keep-alive, and two copies were started) | `taofik-ai` | `pkill -f keep-model-warm.sh` then `docker exec branch-ollama ollama stop qwen3-4b-64k` |
| the second Branch checkout, unmodified b23532d9 | `/workspace/bench/branch-trunk` on `taofik-ai` | `rm -rf` |
| the Hermes virtualenv and its home | `/workspace/bench/hermes-venv`, `/workspace/bench/hermes-home` | `rm -rf` |
| every run's workspace and state | `/workspace/bench/board/{work,state}` | `rm -rf` |

Nothing was installed on the Mac, no system package was added to the VM, and the owner's own
Hermes, OpenClaw and Codex installations were not run, configured or read. `~/.claude`,
`~/.openclaw` and `~/.hermes` are checked before and after every window; the check and its result
are in the board's own write-up.

## A gap in the fingerprint, stated rather than hidden

`scorerDigest` is given each task's id, whether it is read-only and whether its tests are restored —
**not the source of the check function itself**. So rewriting a check to be kinder, while leaving
the task's words alone, would produce the same digest, and `comparisonRefusal` would certify a
comparison between a board marked the old way and a board marked the new way.

That is precisely the failure `scorerDigest` was written to prevent for rubrics, and it is open here
for programs. Nothing in this branch exploits it — no check was changed after a result was seen, and
the two that were changed (`node --test`, and the environment a check runs in) were changed before
any real window and are in the git history with their reasons. But a reader should know the
fingerprint does not cover it. Closing it means hashing each `check` function's source into the
digest, which invalidates every board recorded before the change — which is why it was not done in
the middle of the window that produced this one.

## Claude Code

It is not on the board. It talks only to Anthropic's API and cannot use the P40 at all, so putting
it here would mean one contestant on a frontier hosted model and three on a 4B local one. That is a
different contest, not a closer one, and no amount of rig work fixes it.
