# Mac handoff notes

## mac7/empty-completion — why Branch reported success having done nothing

Cut from `mac7/scoreboard` (64902838), because that branch holds the measurement that found this and
its `experiments/scoreboard/results.jsonl` is the evidence. Nothing under `experiments/scoreboard/`
is touched by this branch: the measurement and the scorer stay exactly as they were.

### The defect

Against `qwen3-4b-16k` on the rig, three of Branch's twenty attempts ended `completed`, with no
error, no file changed and an empty answer. One of them (`fix-slug`, repeat 2) made a single model
call that the provider reported at 1,407 output tokens and came back with nothing at all.

The chain, followed through a recorded run:

1. `OpenAIStream` in `src/provider-stream.ts` read `choice.delta.content` and nothing else. Its zod
   schema listed `content` and `tool_calls`, so every `reasoning_content` / `reasoning` delta — which
   is where an OpenAI-shaped local server (Ollama, llama.cpp, vLLM) puts a reasoning model's
   thinking — was parsed away without trace. The same gap existed in the non-streaming branch and in
   the native adapter, `src/providers/ollama.ts`, under Ollama's own name for it, `thinking`.
2. So a reply that was all thinking arrived as `{ content: "", toolCalls: [] }`.
3. `Runtime.loop` treats "no tool call" as "the task has answered" and returned `""`.
4. `Runtime.run` had never set a failure status, so `completed` stood, and `settleRun` wrote it down.

The seven runs that failed with `No response for 60 seconds` are consistent with the same gap, by
construction: `onTextDelta` was the only thing that reset `withStallWatchdog`'s clock, a model that
is thinking streams no text, and so no text delta could arrive during a think block however long it
ran. That is an inference from the mechanism rather than a per-run observation — the raw records
keep no delta timeline — but it is the only reading that fits a reasoning model timing out at
exactly sixty seconds. F6 in the scoreboard's `FINDINGS.md` reached for the watchdog's shape; the
cause is one layer below it. On that reading ten of Branch's twenty attempts failed for one reason.

Ruled out with evidence rather than guessed at: the reply ceiling (1,407 / 1,754 / 2,409 reported
output tokens against the 8,192 of the build that was measured); a refused tool call going unnoticed
(`callTool` hands the model `{ok:false,error}` and writes a `tool.failed` event); malformed tool
arguments (`Invalid JSON tool arguments`, same path).

### What changed

- The two adapters read the thinking. It never reaches the page and is never kept — only counted, as
  `Completion.reasoningChars`, so an empty answer can say what the model spent its reply on.
- Thinking resets the stall watchdog as text does. This changes the *shape* of the check, not its
  number: `modelStallMs` still defaults to 60 s and was deliberately not raised.
- `settleRun` now refuses to call an empty result a success. It is the only place the runtime
  finishes a run — an owner's task, a delegated child and a manual tool action all settle there —
  so the check cannot be walked around from another entry point. (Other subsystems, the scheduler
  and flows among them, call `store.finish` directly for bookkeeping runs that never went through
  the model loop; those are not tasks and are untouched.) A run that claims `completed` having
  produced nothing (see below for exactly what counts) becomes `failed` with a plain sentence (`src/empty-answer.ts`), worked out
  from the task's own recorded events, so no caller can hand it a friendlier set of facts.

### The file-changing tasks: what is a defect and what is the model

Fourteen attempts across the seven tasks that required writing or changing a file, zero finished:

| what happened | attempts | verdict |
| --- | --- | --- |
| thinking dropped → stall or empty completion | 8 | defect, fixed here |
| stopped to ask the owner a question, headless | 3 | model weakness; F3 argues the second half |
| ran past the 300 s deadline | 1 | rig and model speed |
| **wrote the file**; the code in it exited 1 | 2 | the model being weak, plainly |

In the only two attempts that got as far as a file tool (`script-report`, both repeats) the tool was
not refused and the write applied — `changedOnDisk: ["report.mjs"]`. There is no defect in the
file-changing path itself. The zero is eight rounds that never produced a usable reply, three that
asked a question nobody was there to answer, one that ran out of clock, and two where a 4B model
wrote code that did not run.

### How it reached `mac/cross-platform`

The two code commits above landed through `integrate/empty-completion`, not through this branch,
and that route went further: an empty result now follows the owner's rule exactly — a task is empty
only when it has no visible text, no tool that returned a result and no file change
(`producedNothing` in `src/empty-answer.ts`). A task that wrote the file it was asked for and said
nothing did the work. Anthropic's extended thinking is read too, and a reply that ran out of room
while thinking says so.

The reply ceiling on `mac/cross-platform` stays at 2,048 tokens, so the thinking budget is still
1,792 and `tests/models.test.mjs` is unchanged. The 8,192 above is the ceiling of the build that was
measured, not of the release.
