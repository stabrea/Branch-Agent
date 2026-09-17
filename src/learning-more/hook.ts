import type { Message, Run, ToolContext } from "../contracts.js";

/**
 * R17-F: the one call src/runtime.ts makes, as a conversation's opening messages are put together.
 * `createBranch` registers its function against its own store (src/learning-more/index.ts), so two
 * apps in one process never answer for each other, and a closed app's entry goes with its store.
 * Until then, and whenever every part is off, it adds nothing. It never fails a task: a problem
 * here only leaves the extras out.
 */
type Opening = (run: Run, context: ToolContext) => Message[];
const openings = new WeakMap<object, Opening>();

export function setLearningOpening(key: object, next: Opening): void { openings.set(key, next); }

export function learningOpening(key: object, run: Run, context: ToolContext): Message[] {
  try { return openings.get(key)?.(run, context) ?? []; } catch { return []; }
}
