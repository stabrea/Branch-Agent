import { runOrigin } from "./key-context.js";

/**
 * mac7/outside-resume: a task started from outside — a trigger, a schedule, a chat app, another AI
 * tool over MCP, A2A or ACP — stays that, however it is carried on. Resuming it after a restart,
 * continuing it after a question was answered, "Do this again", a follow-up in its conversation:
 * none of these may turn it into the owner's own work because the owner pressed the button.
 * docs/agents/STATUS-outside-resume.md lists every path and how each one carries the origin.
 */
export type OutsideSource = "trigger" | "schedule" | "mcp" | "a2a" | "acp" | "channel";
const outside: readonly string[] = ["trigger", "schedule", "mcp", "a2a", "acp", "channel"];

type EventReader = Parameters<typeof runOrigin>[0];
type Rows = { prepare(sql: string): { all(...values: unknown[]): unknown[]; get(...values: unknown[]): unknown } };
type Reader = EventReader & { sqlite: Rows };

/**
 * The outside source a task's own record carries, along its parents, the tasks it continued and the
 * task it carries on for; null for the owner's own work. Anything else written there (Branch's own
 * "knowledge" or "learning" work) is not from outside and reads as null too.
 */
export function outsideSourceOf(store: EventReader, runId: string | undefined): OutsideSource | null {
  if (!runId) return null;
  const source = runOrigin(store, runId).source;
  return outside.includes(source) ? (source as OutsideSource) : null;
}

/**
 * The earlier task a new message in this conversation carries on for, when that task came from
 * outside: the one that began the conversation (or the one it was branched off or copied from), or else
 * the latest one when it stopped part way — waiting for an answer, or cut off (interrupted, or out of
 * its allowance). Null means the new message is simply the owner's own.
 */
export function conversationCarrier(store: Reader, sessionId: string | undefined): string | null {
  const seen = new Set<string>();
  for (let id = sessionId; id && !seen.has(id) && seen.size < 10; id = earlierConversation(store, id)) {
    seen.add(id);
    const tasks = store.sqlite.prepare("SELECT id, status FROM tasks WHERE session_id=? ORDER BY created_at, rowid")
      .all(id) as { id: string; status: string }[];
    if (!tasks.length) continue;
    const first = tasks[0]!, last = tasks.at(-1)!;
    if (outsideSourceOf(store, first.id)) return first.id;
    // mac7/outside-review: running out of its step or token allowance is being cut off as well.
    const stopped = ["needs_input", "interrupted", "budget_exceeded"].includes(last.status);
    return stopped && outsideSourceOf(store, last.id) ? last.id : null;
  }
  return null;
}

/** The conversation this one was branched off (src/sessions.ts) or copied from (src/session-library.ts), if any. */
function earlierConversation(store: Reader, sessionId: string): string | undefined {
  const read = (sql: string): string | undefined => {
    try {
      const row = store.sqlite.prepare(sql).get(sessionId) as { earlier?: unknown } | undefined;
      return typeof row?.earlier === "string" && row.earlier ? row.earlier : undefined;
    } catch { return undefined; }
  };
  return read("SELECT parent_session_id AS earlier FROM session_branches WHERE session_id=?")
    ?? read("SELECT duplicated_from AS earlier FROM session_origins WHERE session_id=?");
}

/**
 * Who work a tool call sets going (a flow, a workflow) is held as: the calling task's own source, or
 * the outside source its record carries when its context was built without one.
 */
export function heldSource(context: { source?: string | undefined; runId?: string | undefined }, store: EventReader): OutsideSource | "owner" {
  if (context.source && outside.includes(context.source)) return context.source as OutsideSource;
  return outsideSourceOf(store, context.runId) ?? "owner";
}

/**
 * mac7/residuals: who began a conversation — the source its first task recorded ("a2a", "acp", ...),
 * "owner" for the owner's own, or null when it has no task. Another program may carry on only a
 * conversation it began itself: one that learns an id of the owner's cannot park work there.
 */
export function conversationBegunBy(store: Reader, sessionId: string): string | null {
  const first = store.sqlite.prepare("SELECT id, source FROM tasks WHERE session_id=? ORDER BY created_at, rowid LIMIT 1")
    .get(sessionId) as { id: string; source: string | null } | undefined;
  if (!first) return null;
  // A conversation a program opens with no task yet (ACP, the app-server) writes its source on the row itself.
  if (first.source && first.source !== "web") return first.source;
  return runOrigin(store, first.id).source;
}

/** The plain refusal when another program names a conversation it did not begin. */
export const notYourConversation =
  "Another program can only carry on a conversation it started itself. Leave out the conversation to start a new one.";
