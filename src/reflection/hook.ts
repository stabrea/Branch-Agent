import type { Run, ToolContext } from "../contracts.js";
import type { Runtime } from "../runtime.js";
import type { LearningLoop } from "./loop.js";
import type { Ask } from "./pass.js";

/**
 * The one place the runtime reaches the learning loop. `createBranch` attaches the loop to its
 * runtime; a runtime with nothing attached (a bare test runtime) does nothing here at all.
 */
const attached = new WeakMap<Runtime, LearningLoop>();

export function attachLearningLoop(runtime: Runtime, loop: LearningLoop): void {
  attached.set(runtime, loop);
}

/** After a task of the owner's has settled: maybe look back, maybe draft a skill. Never fails the task. */
export async function learnAfterTask(runtime: Runtime, run: Run, context: ToolContext, ask: Ask): Promise<void> {
  const loop = attached.get(runtime);
  if (!loop || context.dryRun || context.owner !== loop.owner) return;
  try { await loop.afterTask(run, ask); }
  catch (error) { runtime.store.event(run.id, "learning.look_back_failed", { error: error instanceof Error ? error.message : String(error) }); }
}
