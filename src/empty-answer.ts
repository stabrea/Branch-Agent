import type { Event, RunStatus } from "./contracts.js";

/**
 * mac7/empty-completion: a task that finished having produced nothing is not a success.
 *
 * The first real measurement of Branch against a local 4B model
 * (`experiments/scoreboard/results.jsonl`) recorded three runs that ended `completed`, with no
 * error, no file changed and an empty answer. Branch reported success having produced nothing, and
 * a person reading only the status would have believed it.
 *
 * The round underneath looked like this: the model spent its whole reply on thinking, the thinking
 * arrived in a field the stream parser dropped, so the completion came back with empty content and
 * no tool calls; `Runtime.loop` treats "no tool call" as "the task is answered" and returned the
 * empty string; `Runtime.run` had never set a failure status, so `completed` stood.
 *
 * Reading the deltas (src/provider-stream.ts, src/providers/ollama.ts) fixes the cause of *that*
 * round. This is the guard that stands whatever the cause: a finished task with nothing in its
 * answer is a failure with a sentence saying what happened and what the person can do. It reads
 * only what the task itself wrote down, so no caller can hand it a nicer set of facts, and it sits
 * in `settleRun`, which is the one way to `finish` a run.
 */

/** What a task actually produced, read back from its own record. */
export interface Produced {
  /** How many tool calls finished, whether they worked or not. */
  toolCalls: number;
  /** How many of those returned a result: work was done, whatever the model said afterwards. */
  toolResults: number;
  /** How many file changes the task recorded. */
  filesChanged: number;
  /** Characters of thinking the model wrote that were not part of any answer. */
  reasoningChars: number;
  /** The model that answered the last round, for the sentence. Null when none did. */
  model: string | null;
}

/** Reads back what a task produced. Only its own events; nothing a caller could shape. */
export function produced(events: readonly Event[]): Produced {
  const what: Produced = { toolCalls: 0, toolResults: 0, filesChanged: 0, reasoningChars: 0, model: null };
  for (const event of events) {
    if (event.kind === "tool.completed") { what.toolCalls++; what.toolResults++; }
    if (event.kind === "tool.failed" || event.kind === "tool.stalled") what.toolCalls++;
    if (event.kind === "file.changed") what.filesChanged++;
    if (event.kind !== "model.completed") continue;
    const chars = event.data.reasoningChars;
    if (typeof chars === "number") what.reasoningChars += chars;
    const named = event.data.model;
    if (typeof named === "string" && named) what.model = named;
  }
  return what;
}

/**
 * The sentence a task that produced nothing ends with, or null when it produced something. Only a
 * run that claims to have *completed* is judged: one that already failed, was cancelled or is
 * waiting for the person has said what happened in its own words already.
 *
 * integrate/empty-completion: a result is empty only when there is no visible text, no tool that
 * returned a result and no file changed. A task that wrote the file it was asked for and said
 * nothing did the work; calling it a failure would also teach the learning loop the wrong lesson.
 */
export function producedNothing(status: RunStatus, output: string, what: Produced): string | null {
  if (status !== "completed" || String(output ?? "").trim()) return null;
  if (what.toolResults > 0 || what.filesChanged > 0) return null;
  const named = what.model ? ` (${what.model})` : "";
  if (what.toolCalls > 0)
    return `Branch tried ${what.toolCalls === 1 ? "one tool" : `${what.toolCalls} tools`}, none of them worked, and it stopped `
      + `without writing an answer, so nothing was done. Ask again, or try a larger model: this is what a model too small `
      + `for the task usually does.`;
  if (what.reasoningChars > 0)
    return `The model${named} spent its whole reply thinking — ${what.reasoningChars.toLocaleString()} characters of it — `
      + `and never wrote an answer or asked for a tool, so nothing was done. Smaller local models often think `
      + `until they run out of room. Try a larger model, or ask for one step at a time.`;
  return `The model${named} returned an empty reply — no answer, no tool, no change on disk — so nothing was done. `
    + `Ask again, or try a larger model.`;
}

/**
 * integrate/empty-completion: the tokens a reply's thinking is charged as when the provider did not
 * say. The text is never kept, only its length, so it is estimated the way every other output is.
 */
export function thinkingTokens(chars: number | undefined): number {
  return chars && chars > 0 ? Math.ceil(chars / 4) : 0;
}
