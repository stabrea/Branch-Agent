import type { ApprovalGate } from "../approvals.js";
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

export type TestsVerdict = "run" | "ask" | { refuse: string };

export interface TestsHost {
  store: Store;
  owner: string;
  approvals: Pick<ApprovalGate, "answer" | "takeOnce">;
  /** The conversation this call belongs to, where its answers are remembered. */
  sessionId: string;
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
  return host.approvals.takeOnce(host.sessionId, projectTestsTool, folder) ? "run" : "ask";
}
