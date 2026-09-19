# Findings, recorded as they were measured

## F1 — Branch cannot finish a single task on this rig, and here is why

On the test machine, against `qwen3-4b-64k` (qwen3:4b, 65536-token window) at `http://127.0.0.1:11434/v1`,
Branch `0.17.0` (`mac7/eval-honesty`, b23532d9) fails the very first task with:

```
run.output : "Provider stream ended without a complete response"
usage      : reportedInput 2747, reportedOutput 2048, incompleteCalls 1
```

`reportedOutput` is exactly 2048 because `src/runtime.ts` caps every model reply at that constant:

```ts
const maxTokens = Math.min(2048, Math.max(0, context.budget.remaining() - input));
```

qwen3 is a reasoning model: it spends output tokens on a `<think>` block *before* it writes any
content or any tool call. On the trivial prompt "say ok" it spent 1888 of the 2048; on the first
real task it spent all 2048 and the reply never began. The cap is not reached because the answer was
long — it is reached before the answer starts.

OpenClaw 2026.9.4 and Hermes v2026.9.14 both completed the same smoke prompt against the same model
unmodified, because neither imposes a flat reply ceiling of this size.

This is a defect independent of the scoreboard — pointing Branch at a local reasoning model is an
ordinary thing to do, and the failure is silent and misattributed to the provider.

## F2 — and it cancels every task after two minutes, whatever you ask for

`Runtime.run()` added a hard two-minute deadline to *every* task, on top of whatever the caller
asked for:

```ts
const signal = AbortSignal.any([
  controller.signal,
  options.signal ?? new AbortController().signal,
  AbortSignal.timeout(120000),
]);
```

Because the signals are combined with `any`, the shorter one always wins, so `branch run --timeout`
could shorten a task but never lengthen it — silently. Measured: `script-total` (write a ten-line
script that totals a column of a CSV) came back after 134 s with

```
run status : cancelled
output     : "The operation was aborted due to timeout"
```

against OpenClaw's default deadline of 600 s and Hermes's none. Against a hosted model two minutes
is generous; against a local model at fifty tokens a second it is less than one task.

Both F1 and F2 are the same shape: a constant that was reasonable against a fast hosted model, left
as an absolute limit, failing silently and blaming something else.

## How the board handles F1 and F2

Branch appears **twice**. `branch-trunk` is b23532d9 exactly as it stands, run once over the task
set — a demonstration of what these two constants cost, not a contestant. `branch` is the same tree
with those two constants changed and nothing else. OpenClaw and Hermes ran unmodified. That
asymmetry is stated wherever the board is printed: Branch needed two fixes to enter at all.

**What reached the release.** Neither constant was changed on `mac/cross-platform`: the owner kept the
2,048-token reply ceiling for 0.18.1, and the two-minute floor is as it was. What did land, through
`integrate/empty-completion`, is that Branch now reads a reasoning model's thinking, counts it, lets it
keep the stall watchdog awake, and says in plain words when a reply ran out of room while thinking —
so F1 is no longer silent or blamed on the provider, but the ceiling itself still stands.

## F3 — with a small model, Branch picks a switched-off tool and then asks a question nobody can answer

On `fix-sum` ("run the tests, find the bug, fix the source"), the fixed build does reach the model
and does call tools. What it does with them:

```
model.completed  toolCalls 1
tool.started     troubleshoot.run
tool.failed      "Fixing failed commands is switched off. The owner can turn it on with the
                  troubleshoot setting (GET or POST /api/troubleshoot)."
model.completed  toolCalls 1
tool.started     user.ask
attention.needed "I need to enable the troubleshoot setting to run the test command. Would you
                  like me to do that?"
run.finished     status needs_input
```

Two separate things happen here, and only the second is arguably a defect:

1. The model chose `troubleshoot.run` to run a test command, when Branch also offers
   `shell.execute`, `code.run` and `shell.session.run`. Out of 211 tools, 18 were shown to it that
   round. Choosing badly among them is what a 4B model does; a catalogue that makes it easy to
   choose badly is a design one can argue about, but it is not a bug.
2. Having been refused, Branch's next move was to **ask the owner a question and stop**, rather than
   reach for one of the other three tools that would have worked. In a headless run there is nobody
   to answer, so the task ends at `needs_input` with the work untouched.

Nothing was configured around this. The troubleshoot setting was left off, which is how Branch
ships, and the run is scored as the failure it is. OpenClaw was likewise left on its default tool
surface — `--local-model-lean` exists and was **not** passed, because that would have been tuning
one contestant and not the others.

## F4 — the first window was thrown away, and why

A full pass of the board was run at a 65536-token context and **discarded**. The raw records are kept
as `results-discarded-64k.jsonl` so the reasoning can be checked rather than taken on trust. Two
things, both the rig rather than any agent, made roughly half of it meaningless.

**The loopback forwarder severed every model call over thirty seconds.** `/workspace/bench/bin/ollama-forward.py`
connected upstream with

```py
upstream = socket.create_connection(TARGET, timeout=30)
```

Python leaves that timeout on the socket after connecting, so it bounded every *read of the reply*
as well. On an idle card nothing notices; under load, most calls take longer than half a minute and
were cut mid-answer. The agents reported it in their own words — Branch as `fetch failed` and
`No response for 60 seconds`, OpenClaw as `LLM request failed: network connection error` — and the
harness scored it as the agent losing. In the discarded pass that was **5 of Branch's 10 runs and 4
of OpenClaw's 10**. Fixed by giving the connection its thirty seconds and then clearing the socket's
clock (`settimeout(None)`); the original is kept beside it as `ollama-forward.py.orig`.

**A 64K context does not fit the rig's own safety cage.** The `branch-ollama` container runs with
`--memory=4g`, which RIG.md is explicit about: the host has about 5 GB free and no swap, and that cap
exists so that Ollama is the casualty of a memory squeeze rather than one of the owner's 25 GB VMs.
A 65536-token qwen3:4b does not fit inside it:

```
memory.events: oom 1, oom_kill 1, max 130852
dmesg: Memory cgroup out of memory: Killed process (llama-server)
       constraint=CONSTRAINT_MEMCG  anon-rss:3385004kB
ollama: "llama-server process no longer running" string="signal: killed"   (x7)
```

The cage did exactly what it was put there to do. **It must not be raised** — the alternative
casualty is the owner's virtual machine. So the board runs at **16384 tokens**, where the same
container sits at 1.9 GiB of its 4 GiB and three long calls in a row come back 200.

## F5 — and therefore Hermes cannot be measured on this rig at all

Hermes Agent refuses to start against any model whose window is under 64K:

```
ValueError: Model qwen3-4b-16k has a context window of 16,384 tokens, which is below the
minimum 64,000 required by Hermes Agent.
```

There is a setting that would let it believe otherwise — `model.context_length` in its config — and
it was **not** used, because telling Hermes a 16K model has a 64K window is a lie that would break
somewhere later and produce numbers with no meaning.

So: 64K is the only window Hermes will accept, and 64K is more than this rig's memory cage allows.
Hermes is therefore **not on the board**, and the reason is the rig, not the agent. What was learned
about it before that point is worth recording anyway: in the discarded 64K pass it finished 0 of 10
tasks and was stopped by the five-minute deadline on 7 of them. That is not a result about Hermes's
quality — the window it ran in was the one being killed by the OOM cage — and no claim is made from it.

## F6 — Branch's stall watchdog counts words, and a reasoning model is silent while it thinks

Three of Branch's ten runs in the recorded pass failed with

```
run status failed: No response for 60 seconds
```

This is not the network. It is `withStallWatchdog` in `src/reliability.ts`, wired up in
`runtime.ts`, which aborts a model call when nothing has been *streamed as text* for
`modelStallMs`. The clock is reset by `onTextDelta` — that is, by words of the answer.

A reasoning model produces no words of the answer while it is thinking. On a shared card, qwen3's
think block regularly runs past a minute before the first character of content appears, and Branch
calls that a stalled provider and gives up on a call that was working perfectly.

Unlike F1 and F2, **this one is already a setting**: `modelStallMs` is part of
`ReliabilityOptionsSchema`, adjustable from 5 s to 600 s, and merely defaults to 60 s. So it is not
a bug to be fixed here — it is a default chosen for fast hosted models, and it was deliberately left
alone rather than raised for the board, because raising it would be tuning one contestant. The three
runs are counted as Branch failures, which is what they are.

What would be worth changing is the *shape* of the check rather than its number: the watchdog could
be reset by a reasoning delta as well as a text delta, so that a model which is visibly working is
not mistaken for one that has died.

## F7 — a bias in the harness, in Branch's favour, named rather than removed

The runner gives a cell one more go when the **model server** fails, so that a bad minute on a
shared machine is not scored as an agent losing. The pattern that decides "the model server failed"
was widened to include `No response for \d+ seconds` — and, per F6, that string is Branch's own
watchdog, not the server. The effect: Branch was given a second attempt on three cells that OpenClaw
would not have been given for comparable slowness, since OpenClaw's equivalent is simply running into
the deadline.

It changed no verdict — all three failed again on the second attempt, and they are recorded as
failures — but it is a thumb on the scale in Branch's favour and it is named here rather than
quietly corrected after the fact. Correcting it means removing that one alternative from the pattern
and running the window again.
