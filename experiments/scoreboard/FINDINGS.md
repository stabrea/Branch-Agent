# Findings, recorded as they were measured

## F1 — Branch cannot finish a single task on this rig, and here is why

On `taofik-ai`, against `qwen3-4b-64k` (qwen3:4b, 65536-token window) at `http://127.0.0.1:11434/v1`,
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
