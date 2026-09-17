import type { Message, Run, ToolContext } from "../contracts.js";

/**
 * R17-F: the one call src/runtime.ts makes, as a conversation's opening messages are put together.
 * `createBranch` sets the function once (src/learning-more/index.ts); until then, and whenever every
 * part is off, it adds nothing. It never fails a task: a problem here only leaves the extras out.
 */
type Opening = (run: Run, context: ToolContext) => Message[];
let opening: Opening | undefined;

export function setLearningOpening(next: Opening | undefined): void { opening = next; }

export function learningOpening(run: Run, context: ToolContext): Message[] {
  try { return opening?.(run, context) ?? []; } catch { return []; }
}
