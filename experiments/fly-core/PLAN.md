# The learning core: what has been measured, and how to measure the rest

The learning core (`src/fly-core/`) copies one well-studied idea from the fruit fly: the mushroom
body. There, a smell is turned into a sparse code over roughly 2,000 Kenyon cells, and dopamine
weakens the synapses between the active cells and the output neurons whenever the smell ends in a
reward or a punishment. Branch does the same thing with a task's starting situation in place of a
smell, and with the tools, skills and memories a task used in place of the fly's approach or avoid
behaviour. Version 1 only gives advice. It does not claim creativity, perfect memory or sentience,
and nothing it does needs a model call.

The whole-brain fly simulations (Shiu et al., Eon `fly-brain`, GPL-2.0) were read for study only.
Their weights are fixed and they do not learn, so none of their code or data is used. The sizes in
`src/fly-core/sizes.ts` come from the published anatomy, cited there: Li et al. 2020, Schlegel et
al. 2024, Caron et al. 2013, Lin et al. 2014, Hige et al. 2015 and Aso & Rubin 2016.

## 1. Measured so far: the synthetic stream

`node experiments/fly-core/stream.mjs` (after `npm run build`). The stream has 1,200 tasks across 12
situations and 16 tools, with the same random draws for every picker, and results are averaged over
seeds 1 to 5. Every picker picks a random tool 10% of the time. At task 600 the tool that works best
changes in every situation. Each cell reads *success rate / how often the best tool was picked*, per
block of 100 tasks. Measured on 2026-09-16 on the Mac; re-measured on 2026-09-17 by the integrator
after one correction: the stream used to put each situation in `project-(situation mod 3)`, and only
the core reads the project, so it was handed a clue about the hidden situation that the other
pickers never got. Every task is now in the same project. That correction took about 10 points off
the core (block 6 was 69.2%). `tests/fly-core-stream.test.mjs` checks margins well below these.

| block | none | frequency | similar-prompts (Branch today) | fly core | told-situation (reference) |
|---|---|---|---|---|---|
| 1 | 22.2% / 5.6% | 31.6% / 10.0% | 31.8% / 16.4% | 33.4% / 11.0% | 37.4% / 23.0% |
| 3 | 23.4% / 6.6% | 27.0% / 8.2% | 44.6% / 31.4% | 47.4% / 40.0% | 58.4% / 58.0% |
| 6 | 22.2% / 6.0% | 27.2% / 8.6% | 39.6% / 28.4% | 59.8% / 60.2% | 78.8% / 84.6% |
| 7 (after the change) | 21.6% / 7.2% | 28.8% / 11.8% | 22.0% / 0.6% | 23.6% / 9.2% | 15.2% / 0.2% |
| 12 | 19.2% / 6.4% | 28.6% / 11.0% | 18.2% / 0.4% | 56.4% / 51.6% | 32.4% / 21.0% |

What the table shows, and what it does not:

- **The core does improve with use.** Its success rate went from 33.4% to 59.8% before the change,
  and it got back from 23.6% to 56.4% after it.
- **The frequency counter plateaus.** It ignores the situation, so it cannot learn "this tool here,
  that one there".
- **Branch's current habit counts only successes.** That is `src/tool-usage.ts` `preload`, which
  weights past successes by how much the requests' words overlap; the stream copies it faithfully.
  It learns something before the change but never unlearns: after the change, the tools that used
  to work keep winning.
- **Most of the core's lead before the change comes from counting failures, not from the fly
  circuit.** An extra check (not in the script): the same word-overlap counter, but subtracting
  failures as well as adding successes, reached 61.2% at block 6 (the core: 59.8%). After the change
  it only got back to 42.0% by block 12 (the core: 56.4%), because its counts never fade. The core's
  own advantage in this stream is relearning when things change.
- **The told-situation reference does better than the core before the change.** It is handed the
  hidden situation number, which no real picker has. Before the change it shows how much the core
  loses by having to recognise situations from their words (about 19 points). After the change it
  does worse only because its counts never fade.
- The numbers move by several points when only a picker's own random draws change, so a gap of a
  few points between two pickers means nothing.
- **This is a synthetic world with one tool per task and a clear right answer.** It shows that the
  mechanism works as intended. It does not show that Branch finishes real work better. Section 2
  covers that.

### 1a. Version 2: the synapse cap (re-measured 2026-09-17 on the Mac)

Version 2 keeps at most 120 learned synapses on each side of an action (`src/fly-core/sizes.ts`),
so storage stays bounded. The same stream, same seeds, with the cap:

| block | fly core, no cap (as above) | fly core, cap of 120 |
|---|---|---|
| 1 | 33.4% / 11.0% | 32.8% / 13.0% |
| 3 | 47.4% / 40.0% | 51.8% / 44.0% |
| 6 | 59.8% / 60.2% | 60.8% / 57.0% |
| 7 (after the change) | 23.6% / 9.2% | 19.8% / 1.4% |
| 12 | 56.4% / 51.6% | 54.2% / 53.6% |

The other pickers are unchanged. With the cap lifted in a scratch copy, the version 2 code gives
the "no cap" column exactly, so the faster code step changed nothing and these differences come from
the cap alone. They are within the few points the stream moves by on its own; block 7 is the
largest (3.8 points lower). This is still the synthetic stream and says nothing about real work.

At the cap (5,000 actions, each side full) the `fly_*` tables take 9.97 MB after `VACUUM`. A task
start (`tests/fly-core-2.test.mjs` F15) reads per-cell lists kept in memory: on the Mac the ranking
took a median of 0.33 ms of the thread's own processor time and the whole start hook 0.80 ms; the
first one after launch, which builds the index, about 115 ms, done in the background at launch when
the switch is on. An earlier version that walked every action measured 2.7 to 4.0 ms on the Mac and
8.0 ms (11.4 ms for the whole hook) on the 2-processor Linux test machine; the list version was not
run on Linux (the owner stopped Linux runs for this wave).

## 2. Plan: before and after on Branch's own suites (harness built, not yet run on a real model)

`experiments/fly-core/real-eval.mjs` implements this section. It needs two running copies of Branch
with separate data folders (`BRANCH_EVAL_URL_OFF`/`BRANCH_EVAL_KEY_OFF` and
`BRANCH_EVAL_URL_ON`/`BRANCH_EVAL_KEY_ON`, plus `BRANCH_EVAL_WORKSPACE_OFF|ON` for the harness's own
file checks), sets the switch through `/api/learning-core`, forgets what was learned before each
repeat, runs `/api/evaluation/run` for each suite, and reads each task's "Look inside" record for
tool calls and the advice it used. It reports, per repeat and pass, the pass rate (Branch's grader
and the plain checks), tool calls, tokens, cost and time per task, and compares the last pass with
the last pass with the spread over repeats. `--dry-run` runs it against two throwaway copies with
the offline demo provider; that tests the harness only. `data/tool-evaluations/*` and the published
benchmarks are not in it yet.


Goal: find out whether the core's advice makes real tasks go better, and whether it costs anything.

1. **Put the advice to use behind a switch.** Add a setting, off by default. When it is on, the
   core's `tools` suggestions are added to the tool loader's `preload` list, and its `memories`
   suggestions go to the front of the memory snapshot through `MemoryReview.orderFacts`. Both
   mechanisms already exist; only the source of their ordering changes. The `avoid` list is never
   used to hide a tool, only to leave it out of the preload.
2. **Suites.** `data/evaluation/everyday.json`, `tool-use.json`, `reliability.json` and `cost.json`,
   plus `data/tool-evaluations/*`, plus the published benchmarks `src/benchmarks.ts` can read from
   files already on the computer.
3. **Warm-up, then measure.** Every suite runs three times in a row against one data folder, so the
   core has something to learn from. A second, fresh data folder runs the same three passes with
   the switch off. Compare pass 3 against pass 3.
4. **What gets counted.** Tasks passed; tool rounds per task; tokens per task, using the paired,
   complete ledger in `experiments/accounting.py` (reported usage only, never estimated from prompt
   length); wall time; and how often a preloaded tool went unused.
5. **Stopping rule.** Use the same provider and model, and the same seeds where the provider allows
   it. At least three repeats of the whole comparison. Report the mean and the spread. A difference
   smaller than the spread counts as no difference.
6. **Failure check.** Also run `safety.json` with the switch on. The core must not change any
   refusal or approval outcome, and a difference there is a bug.

## 3. Plan: head-to-head against Hermes (hook built, not yet run)

`real-eval.mjs --target hermes` puts the same suite tasks to Hermes Agent's OpenAI-compatible API
(`HERMES_EVAL_URL`, `HERMES_EVAL_KEY`, `HERMES_EVAL_MODEL`, `HERMES_EVAL_WORKSPACE`) and grades the
answers with the same plain checks it applies to Branch. Tasks that need a model to judge them, or
Branch's own interrupt and resume, are left ungraded for both. The near-duplicate task set below is
not written yet.


Hermes Agent (NousResearch, MIT) learns through model-written reviews after a task, and so does
Letta's reflection loop, which `letta-code` starts on a step-count trigger. Both spend model calls
to decide what to keep. The core spends none. The comparison should show whether that matters.

1. **Same tasks, same model.** Draw 30 to 50 tasks from `everyday.json` and `tool-use.json`,
   rewritten into three near-duplicates each, so that learning has a chance to pay off. Both agents
   use the same provider and model.
2. **Each agent at its best.** Hermes runs with its background review on. Branch runs with the core
   switched on (section 2, step 1) and its existing model review off, then again with it on.
3. **Measure three things.** Task pass rate on the third near-duplicate. Total tokens, including
   every learning call, from each agent's own usage reports. And learning cost: tokens spent on
   learning divided by the tasks improved.
4. **Fairness notes to publish with the result.** Pinned versions of both agents (Hermes at the
   commit named in `agent-refs/INDEX.md`), the full task list, raw ledgers, and every task either
   agent could not run, with the reason.
5. **What would count as a win.** Branch passes at least as many tasks on the third repeat with
   fewer learning tokens, across three repeats. Anything less is reported as it stands.

## 4. Known limits

- Version 2 applies the advice when the switch is "on" (see `docs/configuration.md`), but no real
  task has been measured with it yet; the only numbers are the synthetic stream's.
- Credit goes to every tool a task used, and earlier steps get less of it. A task with many tools
  therefore teaches each one a little. A failed call is always marked down on its own.
- The memory boost applies when a conversation's snapshot is first taken; `memory.search` results
  are not reordered.
- Accepting a skill idea opens a draft in the skill editor; installing it is still the owner's step.
