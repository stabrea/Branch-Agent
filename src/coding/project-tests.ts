import type { ApprovalGate } from "../approvals.js";
import type { ToolContext } from "../contracts.js";
import { runOrigin, startedWithShortLivedKey } from "../key-context.js";
import { lockdownActive, lockdownToolRefusalText } from "../lockdown.js";
import { readPolicy } from "../policy.js";
import type { Store } from "../store.js";

/**
 * mac7/coding-next: "Let Branch run this project's tests?" Running a project's own tests runs its
 * code on this computer, so it stays off until the person says yes — once per workspace folder.
 *
 * The question goes through the ordinary approval path (src/approvals.ts, `Runtime.askApproval`),
 * so it appears wherever other questions do, under the name `code.tests` and the folder as what it
 * is about. The answers are the ordinary ones, read here:
 *
 *   Always for this folder  a standing rule `code.tests` on exactly this folder (owner only)
 *   Once                    one pass, used by the next run of the tests in this conversation
 *   No                      remembered for the conversation; the task is told and not asked again
 *
 * Only an exact rule for this folder counts: a broad "allow everything" rule does not stand in for the
 * person's yes. Lockdown refuses without asking. A yes for the rest of a conversation (from a chat
 * app, where "always" is never offered) is honoured for that conversation.
 */
export const projectTestsTool = "code.tests";
export const projectTestsLabel = "Run this project's tests (node --test)";
export const projectTestsQuestion = (folder: string): string =>
  `Let Branch run this project's tests? It would run node --test in ${folder}.`;
export const testsDeclinedNote = "The person chose not to let Branch run this project's tests. Do not ask again: "
  + "read the test files and the source with files.read, work out what the tests expect, and make the change.";

/**
 * mac7/tests-unattended: what `code.check` says when the question would have been put but nobody is
 * there to answer it. The task carries on; the sentence says why the tests did not run and how to
 * let them.
 */
export const testsSkippedNote = (folder: string): string =>
  `This project's tests were not run: running them has not been allowed for ${folder}. `
  + `To allow it, answer "Always for this folder" when Branch asks in the app, or start the task with branch run --allow-tests. `
  + "That does not block the task: read the test files and the source with files.read, work out what the tests expect, and make the change.";

/**
 * mac7/tests-unattended: whether nobody can answer the tests question right now. A script's
 * `branch run` with no terminal (`unattended`), and work nobody is watching when it runs: a
 * schedule, a trigger, another AI tool over MCP or A2A. A chat app is skipped too (decided for this
 * question: running tests is never needed to finish the work). An editor over ACP asks its own
 * person and answers, so it is still asked. Changes from outside still wait for the owner.
 */
export function nobodyToAsk(context: Pick<ToolContext, "unattended" | "source">): boolean {
  if (context.unattended) return true;
  return ["schedule", "trigger", "mcp", "a2a", "channel"].includes(context.source ?? "owner");
}

/**
 * mac7/tests-unattended: why `--allow-tests` cannot be used now, or null when it can. The owner's
 * alone: never under Lockdown, never while the app is switched to somebody else's profile, never
 * for work asked for with a short-lived key.
 */
export function allowTestsRefusal(store: Store, owner: string): string | null {
  if (lockdownActive(store, owner)) return "--allow-tests cannot be used while Lockdown is on.";
  if (!store.profiles.isOwner() || startedWithShortLivedKey())
    return "--allow-tests is the owner's alone. Switch back to the owner's profile to use it.";
  return null;
}

/** mac7/tests-unattended: whether this task was started with `--allow-tests` by the owner, and may still use it. */
export function allowedForThisRun(store: Store, owner: string, context: ToolContext): boolean {
  if (context.allowProjectTests !== true || (context.source ?? "owner") !== "owner") return false;
  // What the task wrote down when it started: a short-lived key, a household person or a chat
  // anywhere along its chain takes the flag away, whatever the context says.
  const origin = context.runId ? runOrigin(store, context.runId) : null;
  if (origin && (origin.shortLivedKey || origin.source !== "owner" || origin.personProfileId || origin.lentTo)) return false;
  if (context.runId && store.profiles.taskPerson?.(context.runId)) return false;
  return allowTestsRefusal(store, owner) === null;
}

export type TestsVerdict = "run" | "ask" | { refuse: string };

export interface TestsHost {
  store: Store;
  owner: string;
  approvals: Pick<ApprovalGate, "answer" | "takeOnce">;
  /** The conversation this call belongs to, where its answers are remembered. */
  sessionId: string;
  /** mac7/tests-unattended: the owner started this task with `--allow-tests` (see allowedForThisRun). */
  allowedForThisRun?: boolean;
}

/** Whether the tests in `folder` may run now, must be asked about, or are refused (and why). */
export function projectTestsVerdict(host: TestsHost, folder: string): TestsVerdict {
  if (lockdownActive(host.store, host.owner)) return { refuse: lockdownToolRefusalText };
  const rule = readPolicy(host.store, host.owner).rules
    .find((each) => each.tool === projectTestsTool && each.match === folder && !each.resource);
  if (rule?.decision === "allow") return "run";
  if (rule?.decision === "deny") return { refuse: testsDeclinedNote };
  const answered = host.approvals.answer(host.sessionId, projectTestsTool, folder);
  if (answered === "allow") return "run";
  if (answered === "deny") return { refuse: testsDeclinedNote };
  // After every No, so the flag never overrides a refusal; before Once, so it does not use that up.
  if (host.allowedForThisRun) return "run";
  return host.approvals.takeOnce(host.sessionId, projectTestsTool, folder) ? "run" : "ask";
}
