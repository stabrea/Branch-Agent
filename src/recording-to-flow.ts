/**
 * Turning a recorded task into a saved workflow (public list, bucket 13, "workflow recording"): the
 * actions a task took that worked become the steps of a workflow, with the same settings they were
 * given, so something the assistant worked out once can be done again the same way without asking
 * the model to work it out a second time.
 *
 * The draft is shown before it is saved. A saved workflow's steps go through the same checks as any
 * other workflow's (asking first, Lockdown, the permission rules), so recording a task never lets a
 * later replay do more than the owner allows at that time. Settings are taken back through the
 * secret remover before they are written down.
 */
import type { Store } from "./store.js";
import type { WorkflowDefinition, WorkflowStep } from "./workflows.js";

/** Actions that only steer the assistant itself; repeating them would do nothing useful. */
const notRepeatable = (name: string): boolean =>
  name.startsWith("tools.") || name === "user.ask" || name === "runs.export" || name.startsWith("workflows.");

export const maximumRecordedSteps = 20;

export interface FlowDraft {
  definition: WorkflowDefinition;
  /** Actions left out, and why, in plain words. */
  leftOut: string[];
}

/** The settings each action was given, read from the conversation the task ran in. */
function argumentsById(store: Store, sessionId: string): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  for (const message of store.messages(sessionId))
    for (const call of message.toolCalls ?? []) {
      try {
        const parsed = JSON.parse(call.arguments) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) found.set(call.id, parsed as Record<string, unknown>);
      } catch { /* an action given broken settings failed anyway, so it is never a step */ }
    }
  return found;
}

/** The draft workflow for one task. Throws in plain words when there is nothing to make one from. */
export function recordingFlowDraft(store: Store, runId: string, name: string, scrub: <T>(value: T) => T): FlowDraft {
  const run = store.run(runId);
  if (!run) throw Object.assign(new Error("There is no task with that number"), { status: 404 });
  const given = argumentsById(store, run.sessionId);
  const steps: WorkflowStep[] = [];
  const leftOut: string[] = [];
  for (const event of store.events(runId)) {
    if (event.kind !== "tool.completed") continue;
    const tool = String(event.data.name ?? "");
    const args = given.get(String(event.data.id ?? ""));
    if (!tool || notRepeatable(tool)) continue;
    if (!args) { leftOut.push(`${tool}: its settings were not kept, so it cannot be repeated exactly`); continue; }
    if (steps.length >= maximumRecordedSteps) { leftOut.push(`${tool}: a workflow holds at most ${maximumRecordedSteps} steps`); continue; }
    steps.push({ name: `${steps.length + 1}. ${tool}`.slice(0, 80), kind: "tool", tool, args: scrub(args), retries: 0, timeoutMs: 120000 });
  }
  if (!steps.length) throw Object.assign(new Error("That task took no actions that can be repeated, so there is nothing to save"), { status: 400 });
  const title = name.trim() || `Again: ${run.prompt.replace(/\s+/g, " ").trim()}`;
  return {
    definition: {
      name: title.slice(0, 80),
      description: `Recorded from a task on ${run.createdAt.slice(0, 10)}. Each step repeats one action it took.`,
      steps,
    },
    leftOut,
  };
}
