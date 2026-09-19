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
 * outside: the one that began the conversation (or the conversation it was branched from), or else
 * the latest one when it stopped part way — waiting for an answer, or cut off. Null means the new
 * message is simply the owner's own.
 */
export function conversationCarrier(store: Reader, sessionId: string | undefined): string | null {
  const seen = new Set<string>();
  for (let id = sessionId; id && !seen.has(id) && seen.size < 10; id = branchedFrom(store, id)) {
    seen.add(id);
    const tasks = store.sqlite.prepare("SELECT id, status FROM tasks WHERE session_id=? ORDER BY created_at, rowid")
      .all(id) as { id: string; status: string }[];
    if (!tasks.length) continue;
    const first = tasks[0]!, last = tasks.at(-1)!;
    if (outsideSourceOf(store, first.id)) return first.id;
    const stopped = last.status === "needs_input" || last.status === "interrupted";
    return stopped && outsideSourceOf(store, last.id) ? last.id : null;
  }
  return null;
}

/** The conversation this one was branched off, when it was (src/sessions.ts). */
function branchedFrom(store: Reader, sessionId: string): string | undefined {
  try {
    const row = store.sqlite.prepare("SELECT parent_session_id FROM session_branches WHERE session_id=?").get(sessionId) as
      { parent_session_id?: string } | undefined;
    return row?.parent_session_id ? String(row.parent_session_id) : undefined;
  } catch { return undefined; }
}

/**
 * Who work a tool call sets going (a flow, a workflow) is held as: the calling task's own source, or
 * the outside source its record carries when its context was built without one.
 */
export function heldSource(context: { source?: string | undefined; runId?: string | undefined }, store: EventReader): OutsideSource | "owner" {
  if (context.source && outside.includes(context.source)) return context.source as OutsideSource;
  return outsideSourceOf(store, context.runId) ?? "owner";
}
