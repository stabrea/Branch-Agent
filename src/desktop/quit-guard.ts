/**
 * Redesign phase 1: quitting while work is going on.
 *
 * Closing the window already keeps Branch in the tray (or the dock), so the moment work can be lost
 * is Quit itself. When a task is running and no background engine will carry on with it, Branch asks
 * in plain words first. An update, a restart the person asked for, and `branch quit` from a terminal
 * never ask: each of those is somebody having already decided.
 *
 * Kept free of Electron so the decision can be tested on its own (tests/quit-guard.test.mjs); the
 * window's own code in src/desktop/main.ts shows the question and does what the answer says.
 */
import type { Store } from "../store.js";
export type QuitReason = "person" | "update" | "restart" | "command";

export interface QuitFacts {
  reason: QuitReason;
  /** Tasks working right now in the engine this window started. */
  runningTasks: number;
  /** True when this window joined an engine that works in the background, which carries on after it quits. */
  engineInBackground: boolean;
}

/** True when quitting now would stop work, so the person is asked first. */
export function asksBeforeQuit(facts: QuitFacts): boolean {
  return facts.reason === "person" && facts.runningTasks > 0 && !facts.engineInBackground;
}

export type QuitChoice = "keep" | "quit" | "cancel";
/** What the three buttons do: keep it working in the tray, quit anyway, or go back to the window. */
export const quitButtons = ["Keep running in the background", "Quit anyway", "Cancel"] as const;
const choices: readonly QuitChoice[] = ["keep", "quit", "cancel"];

/** The question itself, in the words shown to the person. */
export function quitQuestion(runningTasks: number) {
  const tasks = runningTasks === 1 ? "A task is still working" : `${runningTasks} tasks are still working`;
  return {
    type: "question" as const,
    title: "Quit Branch?",
    message: `${tasks}. Quitting now stops ${runningTasks === 1 ? "it" : "them"}.`,
    detail: "Keep running in the background closes the window and leaves Branch working in the tray, so your tasks and chat apps carry on. Quit anyway stops everything until you open Branch again.",
    buttons: [...quitButtons],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
}

/** The answer from the button pressed; closing the question is Cancel. */
export function quitChoice(buttonIndex: number): QuitChoice {
  return choices[buttonIndex] ?? "cancel";
}

/** Tasks working right now, whoever started them. One waiting for an answer is kept and is not counted. */
export function runningTaskCount(store: Pick<Store, "sqlite">): number {
  const row = store.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'").get() as { n?: unknown } | undefined;
  return Number(row?.n ?? 0);
}
