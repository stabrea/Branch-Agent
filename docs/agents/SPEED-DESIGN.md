# Fewer rounds: the design (mac7/speed)

*Approved by the coordinator ("GO"), then changed twice on their instruction — both changes are in
the text below, marked. What is written here is what is built; `docs/agents/STATUS-speed.md` has the
measurements and the checkboxes.*

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
Consecutive calls in `completion.toolCalls` are grouped while the permission is in
`isReadOnlyPermission` (anything unknown, including every MCP tool, counts as a change and runs
alone) and the call is not one of the catalog tools (`tools.search`/`expand`/`describe`/`note`,
which change what the next round sees) or `user.ask`. Anything else runs alone, in its original
place, so a read and a later write never swap.

*Changed on the coordinator's instruction (decision 1):* two calls about the **same** thing may
share a group **when both are already allowed outright** and nothing would be asked — there is then
no "just this once" yes for them to spend between them. If either would raise a question they run
one after another and the second is asked again, exactly as today. The original rule refused every
repeat of a target; the measured cost of that was that four searches of one folder never ran
together, while the race it guarded against already fails closed.

**B. The model is told it may ask for several independent things at once.** One line in the
instructions, present only while the switch is on.

**C. `files.read_many`** — several files in one call, registered only while the switch is on,
permission `files.read`, each file going through the very same `files.read` path (`checked()`, the
32 KiB cap, the read-before-edit note, the leak guard). It is what lets a model that still sends one
call a turn do a turn's worth of reading in that call.

**D. A tool list that stays byte-stable.** *Changed on the coordinator's instruction (decision 2):
this is a bug fix, not part of the switch, and it is always on.* Which tools win a place is still
decided on merit exactly as before; a tool that has already been sent and does not win one is now
put back on the end instead of dropped, where the token budget takes it first if the section really
is too heavy. *Corrected at integration: the **budget** is unchanged; the count is not. The loaded
list can be longer than `maxLoaded`, and on a long enough task the token ceiling does the trimming
instead — kept tools first, and in order, but it does trim.*

**E. A coding task starts with the tools it needs** — added after the probe found the largest defect
on the branch. Two halves. The first is **not switched** and is also a bug fix: the places were won
outright by whichever toolbox the words of the request favoured, so a request that opened both the
code and the documents boxes was shown **none** of the code ones. The count is now shared among the
boxes the product *guessed*; a box the assistant opened for itself, and a tool it asked for by name,
are requests rather than guesses and still fill places in score order. The second half is switched:
with `fewer-rounds` on, a coding task is given `files.read`, `grep`, `list`, `glob`, `edit` and
`write` before its first round.

**F. The round ceiling** — reported to the coordinator, who asked for it on this branch. Not part of
the switch. A task that used every round it may take ended on "Maximum 12 model rounds reached" and
nothing else. It now asks the model once more, with no tools, for the best answer it can give from
the work it did, and ends with that plus one plain sentence naming what the rounds went on. The
limit itself is the owner's: `maxModelRounds`, Settings › Advanced, default unchanged at 12.

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
  target. Two calls about one target may share a group only when **neither would be asked about at
  all**, so there is no pass in play for them to race for; if either would raise a question they run
  one at a time and the second is asked again.
- **The rate limit overshooting.** `pace` reads then records, so concurrent callers could both see
  room. A small queue makes the read-and-record one step; the per-minute limit stays exact.
- **A call asking for a yes.** It pauses the task exactly as today. The difference: members that
  would have come *after* it have already run and are waited for before anything unwinds. They are
  read-only by construction, so nothing was changed; their results are dropped and the round is
  asked again after the answer.
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

## How it was settled

The rule says a noticeable change ships off, which would make Branch no faster for anyone until the
owner turns this on. The coordinator settled it: **A, B and C ship off** behind `fewer-rounds` for
0.19.0 — parallel execution is where "never break" is most easily lost and it has never run against
a real model — to be proved on real models and defaulted on in the next release, with numbers in the
notes. **D, E's first half and F are bug fixes and are always on**: a tool being pushed off a list,
a toolbox contributing nothing to a task that opened it, and a task ending on a limit with no answer
are all faults, not preferences.
