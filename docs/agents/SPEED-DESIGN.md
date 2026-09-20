# Fewer rounds: the design (mac7/speed)

## What was measured first

`experiments/speed/` — a scripted provider with a fixed pretend round trip, timings from the
product's own spans. Full table in `docs/agents/STATUS-speed.md`. The three numbers that decide this
design:

1. **88–94% of a coding task's wall time is waiting for the model.** Tools 1–4%. Branch's own code
   (catalog, policy, journal, store writes, context fitting) **5–8%, and falling as the round trip
   grows** — about 15–25 ms a round. So micro-optimising Branch's own hot path is worth a few
   percent at most. This branch does not spend effort there.
2. **Packing the same tool calls into fewer rounds is worth 33–53%.** `rename`: 9 rounds -> 4,
   1958 ms -> 928 ms, identical work, model thinking time held equal.
3. **The model sends one tool call a turn.** Every `model.completed` row in the owner's database
   returned 0 or 1 calls, never two. It is not the provider: `parallel_tool_calls: true` is already
   sent and the reader already collects several. Nothing in the loop caps calls per turn either.
   The model simply is not invited to batch, and there is no read-many shaped tool to make batching
   the obvious move.

So the gap against Codex's one-turn runs is not speed of execution. It is **how much one turn
carries**.

## The change

One new coding part, `fewer-rounds` (`settings/coding-fewer-rounds`), three states like every other:
**off** (today, exactly), **when needed** (coding tasks only), **on** (every task). Ships **off**.
Nothing is removed, no default moves, no tool is un-registered, and "when needed" still means
loaded-and-findable, never held in context.

With it on, four things:

**A. Independent read-only calls in one turn run concurrently.**
Consecutive calls in `completion.toolCalls` are grouped while *all* of these hold: the permission is
in `isReadOnlyPermission` (anything unknown, including every MCP tool, counts as a change and runs
alone), the call is not one of the catalog tools (`tools.search`/`expand`/`describe`/`note`, which
change what the next round sees and must stay ordered), and its `policyTarget` is not already in the
group. Anything else runs alone, in its original place, so a read and a later write never swap.

**B. The model is told it may ask for several independent things at once.** One line in the
instructions, present only while the switch is on.

**C. `files.read_many`** — several files in one call, registered only while the switch is on,
permission `files.read`, each file going through the very same `files.read` path (`checked()`, the
32 KiB cap, the read-before-edit note, the leak guard). It is what lets a model that still sends one
call a turn do a turn's worth of reading in that call.

**D. A tool list that stays byte-stable.** A tool that has travelled in full in this task is not
evicted from the loaded set later (today `files.edit` coming in pushed `workspace.redo` out
mid-task, which throws away a provider's cached prefix from that round on). The cap and the token
budget still hold — a tool stays *in addition to* nothing; it takes its own slot back first, and the
ceiling trims the weakest *unused* tool as it does today.

## Why it wins

A: turns whose tools are slow stop costing the sum of their tools. Measured today: four
`files.grep` calls over a 300-file project cost 132 ms one after another.
B + C: fewer turns, and the measurement above says a removed turn is worth ~200 ms per 200 ms of
round trip — at the plan's ~4 s round trip, ~4 s each.
D: one fewer full prefill per task on any provider with a prompt cache.

## What could break, and what holds it

- **A check used once and applied twice.** Nothing is hoisted. Every call in a group still runs its
  own `journal.around` -> `guards.call` -> `callTool`, so its own `prepareCall`, `pace`, `gate`
  (policy, hooks, Lockdown, household, outside-task hold, multi-target and folder-walk rules,
  read-before-edit), its own wall and its own span. The only thing shared is the clock.
- **A "Once" pass stolen by the wrong call.** `ApprovalGate` keys a pass by session + tool +
  target; a group may not hold two calls with the same target, so two members can never race for
  one pass.
- **The rate limit overshooting.** `pace` reads then records, so concurrent callers could both see
  room. A small queue makes the read-and-record one step; the per-minute limit stays exact.
- **A call asking for a yes.** It pauses the task exactly as today. The difference: members that
  would have come *after* it have already run. They are read-only by construction, so nothing was
  changed; their results are dropped and the round is asked again after the answer.
- **Transcript order.** Results are written back in the order the model asked for them, so the
  conversation and the journal read exactly as they do today.
- **A runaway reply.** A group is capped (8), so one reply cannot open fifty things at once.
- **Never break.** Every call in a group is waited for before anything unwinds (`Promise.allSettled`),
  so a task that stops to ask a question leaves nothing of its own still running. The results are
  then written down in order, stopping at the first that threw — exactly where the loop stopped when
  calls ran one at a time. A cancelled task still cancels all of them through the shared signal.

## Proof

Before/after from `experiments/speed/run.mjs` on this branch's `dist/`: turns, wall, the model /
tools / Branch split, and the byte-stability of the tool list. Plus unit tests that a group still
asks, still refuses under Lockdown, still honours read-before-edit, and that every tool is reachable
in all three tiers with nothing dropped from the index.

## Open question for the coordinator

The rule says a noticeable change ships off. That makes Branch no faster for anyone until the owner
turns this on. If the owner wants the speed by default, **D** (a stable tool list) and **A**
(concurrent read-only calls) are the two whose observable difference is smallest, and either could
default on without touching what any feature does. Say which, if any.
