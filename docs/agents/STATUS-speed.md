# Status: mac7/speed (finish coding tasks in fewer round trips)

Builder: Claude (Legion). Worktree `C:/Users/bishi/Code/wt/speed`, branch `mac7/speed`, cut from trunk
0a5a1245. Not merged into trunk: an integrator reviews after this.

Goal: the same coding work in fewer model round trips, with every feature still there and no safety
rule weakened. On a hosted model wall time is roughly (number of model calls) x (round trip), so the
number of turns is the lever.

Design note (approved by the coordinator, "GO"): `docs/agents/SPEED-DESIGN.md`.

- [x] 0. Where the time actually goes — measured before changing anything (below)
- [x] 0b. A local timing harness so the next session can re-measure in minutes (`experiments/speed/`)
- [x] D. A tool arriving mid-task no longer pushes another off the list — **no switch, a bug fix**
- [x] E. A coding task starts with the tools it needs, and no one toolbox takes every place
- [x] B. The assistant is told it may ask for several independent things at once
- [x] C. `files.read_many` — several files in one call, each through the same checks
- [ ] A. Independent read-only calls in one turn run concurrently
- [ ] Measure B on a real model (Ollama on taofik-ai, after window8 finishes ~03:00-03:30 UTC)
- [ ] Merge latest trunk, rebuild, retest, push

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
