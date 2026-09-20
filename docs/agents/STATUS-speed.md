# Status: mac7/speed (finish coding tasks in fewer round trips)

Builder: Claude (Legion). Worktree `C:/Users/bishi/Code/wt/speed`, branch `mac7/speed`, cut from trunk
0a5a1245. Not merged into trunk: an integrator reviews after this.

Goal: the same coding work in fewer model round trips, with every feature still there and no safety
rule weakened. On a hosted model wall time is roughly (number of model calls) x (round trip), so the
number of turns is the lever.

## Everything on this branch, and whether it is switched

Read this table first; the sections below are the evidence for each row.

| | what it does | switch | proved by |
|---|---|---|---|
| **E1** | No one toolbox can take every place. A request that opened the code and documents boxes was shown **none** of the code ones | **none — a defect** | 17→14 of 30 working-set places needing a search; test, mutation-checked |
| **E2** | A request that names a file is coding work, whatever box the words opened (the plan's worst task opened only `documents`) | **none — a defect** | the plan's own trace; unit test |
| **E3** | A coding task starts with `files.read/grep/list/glob/edit/write` loaded | `fewer-rounds` | 14→**1** of 30 places needing a search |
| **D** | A tool arriving mid-task no longer pushes another off the list | **none — a defect** | 1→0 rounds losing a tool locally; on the plan, `cli-flag` loaded `code.run` twice |
| **F1** | Running out of rounds gives the best answer it has plus a plain sentence naming what the rounds went on | **none — a defect** | tests incl. a long task, mutation-checked |
| **F2** | The round ceiling is the owner's: `maxModelRounds`, Settings › Advanced, default still 12 | **none — new setting** | test |
| **G1** | A tool you just found comes with its inputs, so the next step is the call, not another round asking | **none — a defect** | the plan spent 27 of 95 rounds finding tools |
| **G2** | `bash`, `shell.execute`, `read_file` and the rest find the Branch tool that does the job | **none** | the plan's model asked for `shell.execute` by name twice and was refused |
| **G3** | A switched-off feature's tools are not offered by a search — which is what the three-way switch already promised | **none — a defect** | `troubleshoot.run` (off) beat `code.run` in all three of one task's shell searches |
| **H1** | A model service that refuses is explained in plain words, not `Provider HTTP 400; check endpoint…` | **none — a defect** | one task lost to it on the plan; tests |
| **H2** | A coding task is told once, up front, that running commands is off | **none — a defect** | 8 of 95 rounds spent discovering it |
| **I** | The ChatGPT route records the cached tokens the service already reports | **none — a defect** | `cachedInput` was null on all 185 plan rounds because nobody read the field |
| **A** | Look-only calls in one turn run together | `fewer-rounds` | 224 ms against a 6,000 ms round — real, small |
| **B** | One line inviting the model to batch | `fewer-rounds` | **not the win**: Branch already batches 24% of rounds |
| **C** | `files.read_many` | `fewer-rounds` | **not the win**, same reason; it does fit what the task will keep |

`fewer-rounds` is one new coding part, off / when needed / on, and it **ships off**. Everything
marked "a defect" is on for everyone, which is how the coordinator decided each one.

Design note (approved by the coordinator, "GO"): `docs/agents/SPEED-DESIGN.md`.

- [x] 0. Where the time actually goes — measured before changing anything (below)
- [x] 0b. A local timing harness so the next session can re-measure in minutes (`experiments/speed/`)
- [x] D. A tool arriving mid-task no longer pushes another off the list — **no switch, a bug fix**
- [x] E. A coding task starts with the tools it needs, and no one toolbox takes every place
- [x] B. The assistant is told it may ask for several independent things at once
- [x] C. `files.read_many` — several files in one call, each through the same checks
- [x] A. Independent read-only calls in one turn run concurrently
- [x] A2. Same-thing calls may share a run when neither would be asked about (coordinator's decision 1)
- [x] F. The round ceiling no longer strands a task on a bare sentence, and the owner can change it
- [x] G. A tool you just found can be called straight away; the names other assistants use find it;
      a switched-off feature's tools are named but never offered
- [x] H. A model service that refuses is explained in plain words; a coding task is told once that
      nothing can be run here
- [x] I. The ChatGPT route records the cached tokens the service already reports
- [x] Measured on a real model (qwen3-14b on taofik-ai): two windows, 18 cells
- [x] Merged latest trunk (`da5ac2c0`), clean `dist/` rebuild, retested, pushed

Everything except D is behind one new coding part, **`fewer-rounds`**, which **ships off**. Its three
states work like `read-first`'s: *off* is today exactly; *when needed* and *on* both switch the
behaviour on, and what they choose between is whether `files.read_many` is described in full from the
first round (*on*) or is a line in the index until the work calls for it (*when needed*). Nothing is
removed, no default moves, and every tool stays reachable in one step in every state.

## 0. Where the time goes — the breakdown, measured

Measured with `experiments/speed/run.mjs` on this branch's `dist/`, no network and no real model: a
scripted provider waits a fixed 200 ms per call (the pretend round trip) and hands back the tool
calls the script says. Timings come from the product's own spans (`run`, `model`, `tool`), so
"Branch" below is wall time that belongs to neither the model nor a tool — catalog building,
`fitContext`, the policy checks and approvals, the journal, the store writes, redaction.

| task / shape | model calls | tool calls | wall | model | tools | Branch's own code |
|---|---|---|---|---|---|---|
| fix-range, one call a round | 6 | 5 | 1339 ms | 1221 ms (91%) | 19 ms (1%) | 99 ms (7%) |
| fix-range, calls packed | 4 | 6 | 899 ms | 812 ms (90%) | 18 ms (2%) | 69 ms (8%) |
| rename, one call a round | 9 | 8 | 1958 ms | 1837 ms (94%) | 28 ms (1%) | 93 ms (5%) |
| rename, calls packed | 4 | 8 | 928 ms | 816 ms (88%) | 36 ms (4%) | 76 ms (8%) |

**Read it:**

1. **Turns are nearly the whole clock.** 88–94% of wall time is waiting for the model. Packing the
   same tool calls into fewer rounds cut `rename` from 9 calls to 4 and the clock from 1958 ms to
   928 ms — **53% less** — with identical work done and the model's own thinking time held equal.
   `fix-range`: 6 -> 4 calls, 33% less. At the plan's real round trip (~4 s a call, from the 50 s /
   12 calls in the brief) the same saving is tens of seconds.
2. **Branch's own code is 5–8%, and that share only falls as the round trip grows** (it is roughly a
   fixed 15–25 ms a round against a 200 ms wait; at a 4 s wait it is under 1%). So the brief's levers
   5, 6 and 7 — trimming catalog building, store writes, policy re-derivation, streaming edits out
   early, connection reuse — are worth at most a few percent between them. **They are not where the
   time is, and this branch does not spend its effort there.** Measured, not guessed.
3. **Tools are 1–4% on file work**, but that is because these files are small. Four `files.grep`
   calls over a 300-file project, run one after another as the loop does today, take **132 ms**
   (~33 ms each) against 75 ms of Branch overhead in the same task. Serialising matters in
   proportion to how slow the tools are — a turn holding two commands that each take two seconds
   costs four seconds today and could cost two.
4. **The tool list sent to the model is not byte-stable.** In `rename` the list changed once mid-run
   (`files.edit` came in, `workspace.redo` was pushed out at the loaded-tools cap), so a provider's
   prompt cache has to re-read the whole prefix from that round on. Instructions were stable in
   every round of every task.

### What the model does per turn, from the owner's own database

> **This section is wrong and is kept only so the correction has something to point at.** The real
> model batches in 24% of its rounds — see *Corrected by real-model data*, below. What follows was
> measured against a scripted stand-in and an old database, and it is the reason items B and C were
> built. They are cheap and tested and they stay; they are not the win.

Every `model.completed` row in the app's database (`state/branch.sqlite`, 16 rounds across 8 tasks)
returned **0 or 1 tool calls — never two**. The provider side is not the cause: the ChatGPT plan's
request already sets `parallel_tool_calls: true` (`src/chatgpt-provider.ts:86`) and the Responses
reader already collects several `function_call` items per reply
(`src/providers/openai-responses.ts:130`). Nothing in the runtime loop caps calls per turn either —
`for (const call of completion.toolCalls)` runs whatever came back. So the model *may* batch and
simply does not: nothing in the instructions invites it to, and there is no read-many shaped tool to
make batching the obvious move. That is item 2, and on the numbers above it is the biggest lever.

### Not measured here
- The effect of any prompt change on how many calls a real model returns per turn. There is no
  Ollama on this machine (`127.0.0.1:11434` answers nothing) and the brief forbids spending benchmark
  windows on the owner's plan, so the turn count before and after an instruction change is **not**
  proven here. What is proven is what each turn removed is worth (table above).
- Prompt-cache hit rates against a real provider. `cachedInput` is recorded on every
  `model.completed`, so the next window on a hosted model can read it straight out of the database;
  the rows in the owner's database predate that field.

## The harness

`experiments/speed/` — `npm run build` first, then:

```
node experiments/speed/run.mjs                 # 200 ms pretend round trip
node experiments/speed/run.mjs --latency 800   # a slower hosted model
node experiments/speed/run.mjs --json out.jsonl
```

- `harness.mjs` — a scripted provider with a fixed pretend round trip, a seeded project to work in,
  and the span arithmetic that splits wall time into model / tools / Branch. `prefixStability`
  reports how many later rounds were sent byte-identical instructions and tool lists.
- `tasks.mjs` — each task written twice, one tool call a round and the same calls packed, so the two
  rows say what a removed turn is worth.

It costs nothing and touches no network, so it can be run as often as you like.

## What each item is worth, measured on this branch

Every number below comes from `experiments/speed/` against this branch's `dist/`, with no network
and no real model. Nothing here is estimated, and nothing is claimed that these runs do not show.

### E — a coding task starts with the tools it needs (`catalog-probe.mjs`)

Over five ordinary coding requests, how many of the six tools a coding task needs before it can
begin (`files.read`, `grep`, `list`, `glob`, `edit`, `write`) were a search away:

| | working-set places needing a search first |
|---|---|
| before this branch | 17 of 30 |
| share-out alone (no switch) | 14 of 30 |
| with `fewer-rounds` on | **1 of 30** |

The worst request, "Add a --verbose flag to the command line and document it in the README", opened
the code and the documents toolboxes and was shown **none** of the six: documents tools won all
twelve places. Sharing the places among the guessed boxes lifts that off the floor on its own;
pre-loading the working set fixes it.

Each of those places is at least one whole round trip the task spends finding a tool instead of
working — and a round trip is 88–94% of the clock.

### A — look-only calls in one turn run together (`parallel.mjs`)

One reply asking for eight files, middle of five runs each way, 200 ms pretend round trip:

| | as it ships | `fewer-rounds` on |
|---|---|---|
| tools on the clock | 20 ms | **14 ms** |
| tools added up | 20 ms | 85 ms (higher on purpose — eight reads contend for one disk) |
| Branch's own code | 75 ms | 60 ms |
| the whole turn | 506 ms | 486 ms |
| calls run together | 0 | 8, in one group |

**Said plainly: on local file reads this is worth a few percent of a turn, and no more.** A read is
a millisecond or two, so there is little to overlap. What A really buys is the case the harness
cannot fake cheaply — a turn holding two commands that each take two seconds costs four seconds one
after another and two together. It is a structural change whose payoff is in proportion to how slow
the tools are, and the honest local number is the one above.

### D — nothing is taken off the tool list mid-task (`run.mjs`)

The `rename` task took a tool away in 1 of 8 later rounds before, **0 after**; the count and the
token budget are unchanged. When `files.edit` arrives the list now grows by one instead of trading
`workspace.redo` away, so a provider holding the front of the request keeps it.

### B — the line inviting the model to batch

**Superseded: the real model already batches (24% of rounds). See the correction below.**

**Not measured on a real model here**, and not claimed. What is measured is what a removed turn is
worth (the table in section 0: 33–55% of the clock across three tasks). Pi, which gets 6 rounds out
of the same model where Branch takes 9–10, says **nothing** about batching in its own instructions
(`dist/core/system-prompt.js` on the VM) — its short turn count comes from a tiny tool set that is
always loaded and from `bash`, which does several things in one call. So the evidence for B is
weaker than for E and C, and it is one line of about twenty tokens. The turn count before and after
needs Ollama on taofik-ai; that measurement is queued behind window8.

### F — the round ceiling (no switch; the coordinator called it a bug)

Branch stranded a task at its round ceiling exactly as Hermes did in the plan window:
`BudgetError("Maximum 12 model rounds reached")` and nothing else — no answer, and no hint of why it
had gone round twelve times. Branch used 9–10 rounds on the *simplest* bench task, so the margin was
one or two rounds. **It hid a real fault during this branch's own work:** a catalog change of mine
was wrong, the assistant kept opening the same toolbox and never finding the tool, and two existing
tests reported only that it had run out of rounds.

Now a task that runs out asks the model once more — **with no tools at all** — for the best answer
it can give from the work it did, and ends with that answer followed by one plain sentence: how many
rounds it took, what it spent them on, and where the limit lives. The diagnosis is read from the
task's own record, never guessed: "It asked for files.read 12 times, which is nearly everything it
did — it was most likely stuck on that"; "All 11 of its tool calls failed, so nothing it tried
actually worked". The task is still recorded as having stopped at its limit rather than finished,
because that is what happened.

The ceiling is now the owner's: `maxModelRounds` on the knobs card (Settings › Advanced), 2 to 60,
**default unchanged at 12**, launch setting `reliability.maxModelRounds`. A planned task still gets
four more rounds a step on top, up to 40. Event: `rounds.exhausted`.

### A2 — same-thing calls (the coordinator's decision 1)

Two look-only calls about the *same* thing may now share a run when **both are already allowed
outright** and nothing would be asked — then there is no "just this once" yes for them to spend
between them. If either would raise a question they run one after another, and the second is asked
again, exactly as today. That makes four searches of one allowed folder run together (measured: one
group of four) while two calls waiting on one answer still do not.

### What the switch costs per round (`payload.mjs`)

Turning something on that makes each round a little bigger, to remove rounds, is only a good trade
if the sums work. They do, and here they are rather than as a claim. First round of the bench's
first task:

Re-measured on the final build (the earlier figures, before the defect fixes added their two
sentences, were 2,012 and 2,177):

| | as it ships | `fewer-rounds` on |
|---|---|---|
| tool list | ~1,718 tokens (18 of 214 tools) | ~1,742 tokens (18 of 215) |
| instructions | ~391 tokens | ~456 tokens |
| the request | ~19 tokens | ~19 tokens |
| **the whole round** | **~2,128 tokens** | **~2,217 tokens** |

So the part costs about **89 tokens a round, 4% more** — and the same eighteen tools travel, they
are simply the right eighteen. Across the five probe prompts the catalog is within 2.5% either way,
and on the worst one it is *smaller* with the part on (2,182 against 2,429). A round removed is
worth about 3,300 tokens on the plan (Branch's measured 33,456 over ten rounds), so one round saved
pays for twenty rounds of the extra.

For scale, from the coordinator's plan window on the same task: Pi 6 rounds / 10,282 input tokens,
Codex 1 turn / 91,292, Branch 9–10 rounds / 33,456. Codex buys its single turn with nine times Pi's
input; Pi's small payload comes from a fixed set of six tools always loaded. Branch carries 215
tools and shows the model eighteen of them — that is the whole point of the three tiers, and it is
why its per-round payload sits between the two. **The lever this branch pulls is rounds, not
payload**, and the payload is measured here only so nobody has to guess whether it got worse.

## Which build each number came from — read this before quoting any of them

Two different things are measured in this file and they must not be read as one.

- **Local, scripted stand-in, current build.** Everything with a 30-place or 8-file figure:
  `experiments/speed/`, no network, no real model. Re-runnable in minutes.
- **The real model (qwen3-14b on taofik-ai), commit `d23cde37`.** The window was shipped to the VM
  and built once, at `d23cde37`, and the later commits are **not** in it. So the window measures
  A, A2, B, C, D, E1, E3, F1 and F2 — and **none** of G1 (a found tool carries its inputs), G2 (the
  names other assistants use), G3 (a switched-off tool is not offered), H1 (a plain refusal), H2
  (saying once that nothing can be run), E2 (a request that names a file) or I (cached tokens).
- **The five-way plan window** (`docs/agents/CODING-GAPS-2026-09-20.md`, `mac7/gaps`) is somebody
  else's measurement of trunk, and is what every "27 of 95 rounds" figure comes from.

**So the fixes this branch now calls its headline are reasoned from the plan's own traces and are
not themselves measured on a real model.** They are each defect fixes with a trace behind them and a
mutation-checked test, which is the honest claim; "measured to be faster" is not.

Worth buying next, and cheap: the same three tasks, `branch-speed-off` only, one repeat, on the
**current** build — three cells, twenty to thirty minutes. `rounds.mjs` already reports
`lookingForTools`, so comparing that one column against this window's off row isolates the
tool-finding fixes exactly, on the same model, tasks and machine.

## The measurement on a real model — the protocol, pinned in advance

Staged and ready on taofik-ai; queued behind `bench-rerun`'s window8 (which runs entirely on the
ChatGPT plan, so the card is free — the wait is only so its wall-time cells are not measured against
a busy machine).

**The metric is turn count, not wall time.** qwen3-14b takes 40–110 s a round on that shared card, so
wall time there is dominated by load and cold starts; window4's notes say as much. What can be
measured cleanly is `modelCalls` a task, with the part off and on, which is exactly what B, C and E
claim to move. Wall time is reported only as context, with the load average beside it, as the
existing bench rows do.

- **Rows** (VM only, in this branch's own copy — `before/` and the window8 files are untouched):
  `branch-speed-off` and `branch-speed-on`, the same build at `/workspace/bench/speed/build`, the
  second with `prepScript: experiments/coding-bench/fewer-rounds-on.mjs`. Verified without touching
  the card: the prep script writes `coding-fewer-rounds {"mode":"on"}` into a fresh data folder.
- **Tasks**: `rename`, `update-docs`, `extract-helper` — all three are read-and-edit work across
  several files, which is what E, B and C actually change. `fix-range` is deliberately **not** in the
  set: with `code.run` off, as it ships, window 6 recorded a Branch row ending that task after *two*
  model calls by telling the owner to switch scripts on. A task that gives up in two rounds measures
  nothing about rounds.
- **Shape**: 2 rows × 3 tasks × 2 repeats = 12 cells, round robin, 600 s deadline.
  `/workspace/bench/speed/run.sh speed1 branch-speed-off,branch-speed-on "rename,update-docs,extract-helper" 2`
- **Before starting**: warm the model (a cold load is ~105 s and would trip the watchdog), and note
  the load average either side, as every other window does.
- **What would falsify B**: if the model still returns one tool call a turn with the part on. That is
  a real result and will be reported as one. C (`files.read_many`) cuts rounds whether or not the
  model batches, and E cuts them whether or not either works, so the three are separable in the rows.

### Second window: the current build, and what the unswitched fixes are worth

The first window's build predates every unswitched tool-finding fix, so it could not measure them.
The second window is the **current** build, same three tasks, same model, same machine, one repeat
(`/workspace/bench/speed/speed2`, load 5.7–8.2 — the first window ran at 6.9–8.3).

**The shipped row across the two builds. Nothing is switched on in either; the only difference is
the fixes that are on for everybody:**

| task | `d23cde37`, as it ships | current build, as it ships |
|---|---|---|
| extract-helper | fail, **600 s** (stopped at the deadline) | fail, **228 s** |
| update-docs | fail, 409 s | fail, **253 s** |
| rename | fail, 514 s | fail, **472 s** |
| median of the three | **514 s** | **253 s** |

Faster on all three, and the deadline hit disappears. Neither row finishes a task — the shipped
path still cannot run the project's tests, which is what these tasks mostly need — but it reaches
the end of what it can do in half the time.

**And the same window's on/off pair, on the current build:** 2 of 3 finished with the part on
against 0 of 3 as it ships (update-docs PASS 218 s against fail 253 s; rename PASS 584 s against
fail 472 s; extract-helper stopped at the deadline with the part on, against 228 s without —
the one cell in twelve that goes the wrong way, and it is one cell). Tool calls a round 0.90 → 1.50;
one switched-on cell asked for more than one thing in six of its seven rounds.

**How far to trust this one.** Three cells a side, one repeat. It is a sighting, not a rate. What
makes the shipped-row comparison worth reporting anyway is that it is the *same row* on the *same
tasks* with only the unswitched fixes between them, and all three moved the same way.

## For the release notes (drafted here; `release-019` owns the file)

Written to the template's rules (`docs/release-notes-template.md`): what is now possible, in the
words the screens use, with the limits said in the same sentence.

> **Coding tasks that get to the point.** A coding task used to spend whole exchanges with the model
> just finding a tool: over five ordinary coding requests, 17 of the 30 times it needed one of
> `files.read`, `files.grep`, `files.list`, `files.glob`, `files.edit` or `files.write`, that tool was
> not in front of it and had to be searched for first. One request — "add a --verbose flag and
> document it in the README" — was shown none of the six, because the documents toolbox had taken
> every place. Two changes: no single toolbox can take every place any more, which happens for
> everyone; and a new switch, **Doing more in one go**, puts the tools a coding task always needs in
> front of it from the start, lets it ask for several independent things at once, adds a way to read
> several files in one step, and runs the look-only ones at the same time. With it on, 1 of those 30
> places needs a search. It ships off, and it has been measured against a stand-in for the model
> rather than on a live one, so the number to trust is how much work each exchange saves, not a
> promise about any particular task.
>
> **Fixed.** A task that ran out of rounds used to end on nothing but "Maximum 12 model rounds
> reached" — no answer, and no clue why it had gone round twelve times. It now gives the best answer
> it can from the work it did, and says in plain words what it spent the rounds on. How many rounds a
> task may take is yours to change, in Settings under Advanced. A tool arriving part-way through a
> task no longer pushes another tool off the list.

## Corrected by real-model data (`docs/agents/CODING-GAPS-2026-09-20.md`, `mac7/gaps`)

The five-way window on the owner's plan measured 95 Branch rounds across 12 tasks. Three things in
this file's earlier sections were wrong, and they are corrected here rather than quietly edited,
because the wrong version was used to justify work.

1. **"The model sends one tool call a turn — never two" was wrong.** That was measured against a
   scripted provider and an old database. On the real model **23 of Branch's 95 rounds carried more
   than one call (24%) — more often than Pi (12 of 63, 19%)**. Branch already batches.
   **So B (the line inviting it to batch) and C (`files.read_many`) are not the win.** They aim at
   behaviour that already happens a quarter of the time unprompted. Both are cheap, both are tested,
   both stay; neither should be described as the reason this branch exists.
2. **A is small on real rounds.** From the timestamps of one round's three reads: 316 ms one after
   another against about 92 ms together — **224 ms saved against a 6,000 ms round**. Keep it, off,
   and do not sell it. It pays when the tools in a group are slow, not on file reads.
3. **E and D are the big ones, and both are confirmed on the real model.** E: **27 of 95 rounds —
   28% — did no work on the task at all; they looked for a tool.** Pi spent zero of 63, Codex zero.
   D: on `cli-flag`, round 9 re-loaded `code.run` that round 2 had already loaded, because it had
   been pushed off the list in between — this branch's item D, one wasted round, measured on a real
   model.

**The headline of this branch is E, then the round ceiling. Not A, not B, not C.**

### The window, finished: qwen3-14b, 3 tasks x 2 repeats x 2 rows, build `d23cde37`

Same build both rows; the only difference is whether the `fewer-rounds` part is on. 600 s deadline,
load 5.8–8.3 throughout, `/workspace/bench/speed/speed1`.

| | finished the task | median wall | cells stopped at the deadline | model calls, all cells |
|---|---|---|---|---|
| as it ships | **0 of 6** | 600 s | **4 of 6** | 13 |
| `fewer-rounds` on | **3 of 6** | **346 s** | **1 of 6** | 33 |

Cell by cell — **the switched-on row is faster in every pair**:

| task | as it ships | `fewer-rounds` on |
|---|---|---|
| update-docs r1 | fail, 409 s | **PASS, 298 s** |
| update-docs r2 | fail, 600 s (deadline) | **PASS, 225 s** |
| rename r1 | fail, 514 s | fail, 346 s |
| rename r2 | fail, 600 s (deadline) | **PASS, 520 s** |
| extract-helper r1 | fail, 600 s (deadline) | fail, 600 s (deadline) |
| extract-helper r2 | fail, 600 s (deadline) | fail, 342 s |

And what the model did inside those rounds, read from each cell's own database
(`experiments/speed/rounds.mjs`):

| | tool calls a round | rounds that asked for more than one thing | calls that really ran together |
|---|---|---|---|
| as it ships | 0.92 | **1** | 0 |
| `fewer-rounds` on | **1.15** | **12** | **10** |

**Does the model still send one call a turn with the part on? No.** Twelve of the switched-on
rounds asked for more than one thing, against one for the shipped row, and ten calls actually ran
at the same time. On this model the batching line and `files.read_many` do change what the model
asks for — which does **not** contradict the plan data saying the bigger model already batches
unprompted; it says a smaller model needs telling and the larger one does not.

**How far to trust this.** Six cells a side is small, and four of the six shipped-row cells were
stopped at the deadline, so their round counts are "as many as fit", not "as many as needed" —
which is itself the finding, since only one switched-on cell was stopped that way. The pass
difference (0 of 6 against 3 of 6) is the strongest thing here and it is six cells, not sixty. What
it does not measure at all is the unswitched tool-finding fixes, which are not in this build.

## From the research's ranked list, deliberately not built here

`docs/agents/CODING-GAPS-2026-09-20.md` ranks eleven changes. This branch has #1, #2, #4, #5, #7,
#9, #10, the sentence half of #8, and #3 (which turned out to be a measurement bug, not a request
one). Two are left, on purpose, and one must not be built at all.

- **#6, routing a several-file change to `files.patch` / `code.change_set`** — measured worth ~3
  rounds. On `rename`, Branch made four one-file `files.edit` calls in four rounds because the
  search that chose the edit tool returned `files.edit` and not `files.patch`; it has the multi-file
  tool and used it on other tasks. This is a ranking and wording change, not a new tool, and it is
  the obvious next thing. I did not take it because it is a change to search ranking on top of four
  others I have already made there, and it wants its own measurement rather than being folded in.
- **#8's other half, retrying a provider 4xx once** — the plain sentence is built; the retry is not.
  A 400 is usually the same answer twice, and `src/provider-retry.ts` deliberately retries only
  quota and rate-limit codes. The research's case (Pi and Codex finished the same task minutes
  apart) suggests that one was transient, but one cell is not enough to widen what a 4xx means. It
  needs its own decision by the owner, not a quiet widening here.
- **#11, one approval covering a batch of changes, and a scratch area where changes need no yes** —
  **must not be built on this evidence.** The research measured `user.ask` called zero times and
  `failedEdits` zero on every row: approvals cost no rounds at all. Both shapes carry real risk for
  a benefit this data measures at zero.

## Not done, and not proven

- **Nothing on this branch has been measured on a real model yet.** Every number above comes from a
  scripted stand-in on this computer. That is said in the release-notes draft too. The Ollama window
  is the next thing (protocol above).
- **B is a guess, not a finding.** Pi, which takes 6 rounds where Branch takes 9–10 on the same task
  and the same model, says nothing about batching in its own instructions. Its short turn count comes
  from a small tool set that is always loaded and from `bash` doing several things in one call — which
  is evidence for E and C, not for B. B is one line of about twenty tokens and stays on that basis.
- **A is a structural change, not a measured speed-up.** On local file reads it is worth a few
  percent of a turn (20 ms → 14 ms of tool time, 506 ms → 486 ms of turn). The payoff is in
  proportion to how slow the tools are, and the harness cannot cheaply fake a two-second command.
  Read the numbers in that spirit; the honest headline of this branch is E, then F.
- **The live row shows one call while several run.** `runActivity` keys steps by call id, so all of
  them are listed in the feed, but the one line at the top of a running task is the last one that
  started. Nothing is wrong or missing; it is simply not a sentence about eight things. Worth a look
  by whoever owns that row, not fixed here.
- **`code.run` and a shell stay off**, so a coding task still cannot run the project's tests without
  the owner's yes. That is the biggest single difference from Codex and Pi, it is the owner's
  decision (coding-bench plan item 1), and nothing here changes it.
- **Not tried in the desktop app.** Everything here is engine-side and tested through `createBranch`;
  the Coding card's new row and the knobs field are wired the way the existing ones are but were not
  clicked in a real window.

## Integration

Reviewed and merged by the integrator (Claude, Legion, 2026-09-20) on `mac7/speed` itself — the
branch was already merged with trunk at `da5ac2c0`, so no separate integrate branch was cut.
**Nothing has been pushed to trunk**: trunk is frozen while `ci-flakes-4` banks two green runs.

Verdict: **MERGE WITH FIXES** — seven fixes applied here, with tests, listed below.

### What was fixed at integration

| | what was wrong | where |
|---|---|---|
| **1** | `files.read_many` named no target, so `policyTarget` judged the whole call with an **empty** one and `targetsOf` returned nothing. A rule refusing `files.*` under a folder refused `files.read` of a file there and let `files.read_many` of the very same file straight through. Proved with a scripted run before the fix. | `src/coding/read-many.ts` — `target` and `targets` added; the rules now judge every path and the refusal names which one. **The trade:** a path a *rule* refuses now refuses the whole call, rather than coming back named beside the others. A path that simply cannot be read — missing, a folder, outside the workspace, secret-looking — still comes back named with the rest, which is the case the builder's own test covers. Whether the owner would rather have per-path partial results under a refusing rule is their call, not one to make quietly here. |
| **2** | The working line, the catalog's "just used" and the record of what a task reached for were written for **every call in a reply before any of it ran** — and with `fewer-rounds` **off**. A task stopped by the first call showed the *last* call as what it was doing, and tools that never ran were remembered as used. | `src/runtime.ts` — moved back beside each call |
| **3** | Two calls in one group that both need a yes each registered their own question. Only one could stop the task; the other was left waiting to be answered for a call that was no longer running — answerable from a phone or a chat channel, and counting against the small number a conversation may have waiting, so it could push a real question out. | `src/coding/fewer-rounds.ts` — a call that would be **asked** about runs alone; `allowedOutright` became `decisionOf` |
| **4** | `pace` queued every rate check on **one** chain for the whole computer, and the wait happens inside it, so one conversation that had reached its limit held up every other conversation's calls for as long as it waited. (Both limits ship at 0, so this bit only an owner who had set one.) | `src/runtime.ts` — one queue per limit |
| **5** | The always-on "nothing can be run here" sentence said this project's tests were off too. They are a separate yes (`code.check`, `src/coding/project-tests.ts`) and work with scripts switched off, so on a computer where the owner had allowed the tests it told the assistant not to try something it was allowed to do. | `src/coding/fewer-rounds.ts` — it now speaks only for the switch it reads |
| **6** | Lockdown switches the same features off that the owner's switch does, so their tools landed in the hidden set and a search named them with "tell the person they can be switched on" — the wrong advice, and something Lockdown is there not to say. | `src/tool-loading.ts`, `src/runtime.ts` — `nameHidden`; under Lockdown they read as absent |
| **7** | One file bigger than a whole answer was handed back and then cut by the 12,000-character ceiling, while the tool's own words said "nothing is cut short". | `src/coding/read-many.ts` — the answer now says the end was left out |

Fixes 1, 2 and 3 are the ones that mattered. 2 changed behaviour **with the part switched off**.

### What was tried and held

- **Concurrency.** Nothing is hoisted: every call in a group still goes through its own
  `journal.around` then `guards.call` then `prepareCall`, `pace` and `gate`, so its own policy,
  hooks, Lockdown, household, outside-task hold, multi-target, folder-walk and read-before-edit
  checks, its own wall and its own span. The builder's claim that a group shares only the clock is
  **true of the code**; what was not true was the claim that only one call in a group can stop the
  task (fix 3) and that the rate limit stayed exact without cost to other conversations (fix 4).
  Lockdown holds on both new paths (existing tests, re-run). **A cancelled task really does leave
  no call of its own still running** — tested here with two deliberately slow look-only calls in
  one group, cancelled in flight: both received the abort and both had settled before the task
  unwound, which is `Promise.allSettled` doing what it is there for.
- **"Off" is off — with one correction.** It cannot be byte-identical to trunk *by construction*,
  because D, E1, G1, G2, G3, H1, H2 and I ship on for everyone; that is the coordinator's decision,
  not a defect. What is true with the switch off: nothing runs together, `files.read_many` is not
  registered, and the batching line is absent (three existing tests). The one place where the **loop
  itself** had changed with the switch off was fix 2, and it is fixed.
- **The working-set changes, which ship on.** A task cannot be shown a tool it should not have: the
  index is built from `registry.descriptions(context.permissions)`, so a narrowed task, a household
  person's task and a Lockdown task only ever see what they are already permitted; `shareOut` only
  reorders tools that have already passed that filter, and `hidden` removes tools rather than adding
  any. "Named but not offered" therefore cannot name a tool the person is not permitted — and after
  fix 6 it names nothing at all under Lockdown.
- **The alias mapping never widens permission.** `describe` tries the real name first
  (`this.index.entry(asked) ? asked : nameUsedElsewhere(asked)`), the index holds only permitted
  tools, and loading a tool is not calling it — every call still goes through the whole of `gate`.
  `bash` to `code.run` hands a model that asked for a shell Branch's shell, which is the point.
- **The ceiling.** The last question really is asked with **no tools** (`permissions: new Set()`, so
  `toolsFor` returns nothing — asserted in the existing test), goes through the same leak guard as
  every other request, and its digest is that run's own conversation sent to the model the run was
  already using, so nothing reaches anywhere it was not already going.

### The numbers, re-run here

Re-run on this build by the integrator, not taken on trust:

| claim in this file | re-run |
|---|---|
| before this branch, 17 of 30 working-set places needed a search | **not verified** — that is a trunk figure and no trunk build was made. What *was* measured is share-out's own contribution on **this** build: **17** with `shareOut` neutered in `dist/`, **14** with it in, so the 17 → 14 step is real |
| share-out alone, 14 of 30 | **14**, as claimed |

| with `fewer-rounds` on, 1 of 30 | **1**, as claimed |
| first round ~1,718 tokens off / ~1,742 on; worst prompt 2,429 off / 2,182 on | **1,718 / 1,742 / 2,429 / 2,182**, as claimed |
| `fix-range` 6 to 4 calls, 33% less wall; `rename` 9 to 4, 53% less | **6 to 4, 33%; 9 to 4, 53%**, as claimed |
| D: a tool taken away in 0 rounds | **0** in all six rows of `run.mjs`, as claimed |

**One claim does not reproduce.** Section E says of the worst request — "Add a --verbose flag to the
command line and document it in the README" — that *"sharing the places among the guessed boxes
lifts that off the floor on its own"*. It does not: on this build, with `fewer-rounds` off, that
request is still shown **0 of the 6** working-set tools. The reason is that the six live in the
`files` toolbox while the guesser opened `code` and `documents`, so `files` tools were never
candidates and there was nothing for share-out to share. Share-out's real 17 to 14 comes from the
other prompts. The **1 of 30** headline is entirely E3, the switched preload. That sentence should
be corrected before the release notes quote it; the release-notes draft in this file leans on it too.

### Audit ids, one line each (VERIFIED needs a source file *and* a test that asserts the behaviour)

- **E1** no toolbox takes every place — **PARTIAL**: code and test are real (`shareOut`, and the
  test that every toolbox a task opens puts at least one tool into its list), and the 17 to 14 step
  reproduces on this build; the claim that it fixes the worst request does not, and the 17 itself is
  a trunk figure nobody here re-measured. Tick E1 for the mechanism, not for the headline.
- **E2** a request naming a file is coding work — **VERIFIED** (`looksLikeCodingWork`, two tests).
- **E3** the coding working set preloaded — **VERIFIED** (`codingPreload`; 14 to 1 reproduced).
- **D** no tool evicted mid-task — **PARTIAL**: behaviour verified in code, in a test and in
  `run.mjs`, but both this file and `SPEED-DESIGN.md` say "the count and the token budget are
  unchanged" and only the **budget** is: `wanted = [...inUse, ...onMerit, ...kept]` can exceed
  `maxLoaded`, and `sent` only grows, so on a long task the ceiling in `fit` does the trimming
  instead. That trimming is at least orderly — `fit` cuts from the end of the list and the kept
  tools are last, so they go first and deterministically — but it means a long enough task whose
  tool section reaches the 2,500-token ceiling will still see the front of its request change,
  later than before rather than never. **Not measured**: no scripted task here runs long enough to
  reach that ceiling, so how late "later" is remains unknown. Correct the wording.
- **F1** best answer plus a plain sentence — **VERIFIED** (`outOfRounds` and `lastWord`; the test
  asserts the last question carries zero tools).
- **F2** `maxModelRounds`, default 12 — **VERIFIED** (knobs, `reliability`, `docs/configuration.md`, test).
- **G1** a found tool comes with its inputs — **VERIFIED** (`ToolLoader.found`, two tests).
- **G2** the names other assistants use — **VERIFIED** (`otherNames`; a test proves a real tool of
  that name is never shadowed).
- **G3** a switched-off feature's tools named but not offered — **VERIFIED**, and narrowed at
  integration: under Lockdown they are not named either (fix 6, new test).
- **H1** a provider refusal in plain words — **VERIFIED** (`providerRefusal`, three tests).
- **H2** told once that nothing can be run — **VERIFIED after fix 5**; as shipped it was PARTIAL,
  because the sentence was untrue about the project's tests.
- **I** cached tokens on the ChatGPT route — **VERIFIED** (`input_tokens_details.cached_tokens`; the
  test also keeps "absent" distinct from "zero").
- **A** look-only calls run together — **VERIFIED as built**, and this file is already honest that it
  is worth 224 ms against a 6,000 ms round. Three of the seven integration fixes are here.
- **B** the batching line — **VERIFIED** as one line behind the switch; this file already says it is
  not the win.
- **C** `files.read_many` — **VERIFIED after fix 1**; as shipped it was a real hole in the owner's
  rules and should not have been ticked.

### Left alone, on purpose

- **#6, routing a several-file change to `files.patch`**, and **#8's other half, retrying a provider
  4xx once** — both deliberately not built by the builder, and not built here either. Both are
  ranking or policy decisions that want their own measurement and the owner's say.
- **The live row still names one call while several run.** Unchanged; it belongs to whoever owns
  that row.
- **`cannotRunInstructions` is called without the open toolboxes**, so a coding request that names
  no file (for example "fix the crash in the parser") is not told that nothing can be run, even
  though the toolboxes say it is work on the project's files. It costs a round; it does not mislead.

### Tests run at integration

`npm run build` and `npx tsc --noEmit` clean. Then, on this build:

- `tests/speed.test.mjs` — **49 pass, 0 fail** (44 the builder's, 5 added here: the rules judging
  every path in a many-file read, a file longer than one answer, a call that never ran not being
  written down as work, Lockdown naming nothing, and a cancelled task leaving no call running).
- `tests/tool-loading.test.mjs tests/tool-loading-quality.test.mjs tests/catalog-diet.test.mjs
  tests/runtime.test.mjs tests/lockdown-fix-integrator.test.mjs tests/lockdown-modes.test.mjs
  tests/household-profile.test.mjs tests/owner-tool-guards.test.mjs tests/tool-safety.test.mjs
  tests/multi-target.test.mjs tests/approvals.test.mjs tests/policy-outside-hold.test.mjs` —
  **146 pass, 0 fail**.
- `tests/server.test.mjs tests/ui.test.mjs tests/shell-ui.test.mjs tests/static-assets.test.mjs
  tests/index-structure.test.mjs tests/handbook.test.mjs tests/coding-next.test.mjs
  tests/coding-polish.test.mjs tests/coding-polish-holes.test.mjs tests/code-tools.test.mjs
  tests/files-paths.test.mjs tests/chatgpt.test.mjs tests/hidden-knobs.test.mjs
  tests/safety-extras-progress.test.mjs` — **160 pass, 0 fail** (3 skipped).
- `tests/automation.test.mjs` alone — **5 pass, 0 fail**.

Each of the four fix tests was checked against the code before its fix and failed there; the fifth
(cancellation) tests a claim that already held.

**Not proved here.** Fix 4 (one rate queue per limit) has no test: both per-minute limits ship at 0,
and a test of it would be a timing test on a shared machine. It is a small, readable change and the
existing rate tests still pass.
