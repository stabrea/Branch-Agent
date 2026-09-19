import { AsyncLocalStorage } from "node:async_hooks";

/**
 * household-followups: the task a tool is running for. The registry marks every tool call with its
 * task's id (src/registry.ts), so an owner-only guard inside a tool (src/profiles.ts `requireOwner`
 * and `isOwner`) judges by the person the task was started for, not by whoever the app window is
 * switched to at that moment.
 */
const scope = new AsyncLocalStorage<string>();
/** mac7/walk-rules: the tool running, so a folder walk inside it is judged as that tool (src/walk-rules.ts). */
const tools = new AsyncLocalStorage<string>();

/** Runs `work` as part of the task `runId` (and, when named, as the tool `tool`). */
export function underTask<T>(runId: string, work: () => T, tool?: string): T {
  return scope.run(runId, tool === undefined ? work : () => tools.run(tool, work));
}
/** The task the current tool call is running for, if any. */
export function currentTaskRun(): string | undefined {
  return scope.getStore();
}
/** mac7/walk-rules: the tool the current call is, if any. */
export function currentTool(): string | undefined {
  return tools.getStore();
}
