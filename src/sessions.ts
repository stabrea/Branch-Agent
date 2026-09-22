import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Message } from "./contracts.js";
import { reconcileTranscript } from "./transcript.js";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";

export const BranchSessionSchema = z.object({
  sessionId: z.string().uuid(), messageId: z.number().int().positive(),
}).strict();
type BranchInput = z.input<typeof BranchSessionSchema>;
const sessionIdSchema = z.string().uuid();
const maximumMessages = 1000, maximumBytes = 4 * 1024 * 1024;

/** A message as a copy of it may keep it: everything except the references to files that stay behind. */
function withoutFiles(message: Message): Message {
  if (!message.attachments) return message;
  const { attachments, ...rest } = message;
  return rest;
}

/** Conversation copies use new source IDs; workspace state is shared. */
export class SessionBranches {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_branches(
      session_id TEXT PRIMARY KEY REFERENCES sessions(id),
      parent_session_id TEXT NOT NULL REFERENCES sessions(id),
      branch_point_message_id INTEGER NOT NULL, created_at TEXT NOT NULL)`);
  }
  branch(owner: string, input: BranchInput) {
    const { sessionId: parentSessionId, messageId } = BranchSessionSchema.parse(input);
    this.requireOwner(owner, parentSessionId);
    const point = this.db.prepare("SELECT id,body FROM messages WHERE session_id=? AND source_id=?")
      .get(parentSessionId, messageId);
    if (!point) throw new Error("Branch message not found");
    if (Number(this.db.prepare("SELECT temporary FROM sessions WHERE id=?").get(parentSessionId)?.temporary) === 1)
      throw new Error("Temporary conversations cannot be branched");
    const selected = JSON.parse(String(point.body)) as Message;
    if (!["user", "assistant"].includes(selected.role) || selected.toolCalls?.length)
      throw new Error("Choose a user message or an assistant reply without tool requests");
    const rows = this.rows(parentSessionId, Number(point.id));
    if (reconcileTranscript(rows.map(row => JSON.parse(String(row.body)) as Message), "branch check").added)
      throw new Error("The selected conversation contains unfinished tool requests");
    const sessionId = randomUUID(), createdAt = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO sessions(id,owner,created_at) VALUES(?,?,?)").run(sessionId, owner, createdAt);
      const insert = this.db.prepare("INSERT INTO messages(session_id,body) VALUES(?,?)");
      // Same rule as an export: a copy carries the words, not the files. An attachment's id names a
      // file inside the parent's own folder, which this conversation does not have and never will,
      // so copying the reference across would put a card here that cannot be opened — and would tie
      // this conversation's cards to the lifetime of the one it came off. What was attached stays
      // readable in the message's own text, where the runtime wrote it.
      for (const row of rows) insert.run(sessionId, JSON.stringify(withoutFiles(JSON.parse(String(row.body)) as Message)));
      this.db.prepare("INSERT INTO session_branches VALUES(?,?,?,?)")
        .run(sessionId, parentSessionId, messageId, createdAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { sessionId, parentSessionId, branchPointMessageId: messageId, copiedMessages: rows.length };
  }
  view(owner: string, input: string) {
    const sessionId = sessionIdSchema.parse(input);
    this.requireOwner(owner, sessionId);
    const branch = this.db.prepare("SELECT * FROM session_branches WHERE session_id=?").get(sessionId);
    return {
      sessionId,
      branch: branch ? { parentSessionId: String(branch.parent_session_id),
        branchPointMessageId: Number(branch.branch_point_message_id), createdAt: String(branch.created_at) } : null,
      messages: this.rows(sessionId).map(row => ({
        ...JSON.parse(String(row.body)) as Message, messageId: Number(row.source_id),
      })),
    };
  }
  private requireOwner(owner: string, sessionId: string): void {
    if (!this.db.prepare("SELECT id FROM sessions WHERE id=? AND owner=?").get(sessionId, owner))
      throw new Error("Conversation not found");
  }
  private rows(sessionId: string, through = Number.MAX_SAFE_INTEGER) {
    const size = this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes
      FROM messages WHERE session_id=? AND id<=?`).get(sessionId, through)!;
    if (Number(size.count) > maximumMessages || Number(size.bytes) > maximumBytes)
      throw new Error("Conversation exceeds 1000 messages or 4 MiB; choose an earlier branch point");
    return this.db.prepare("SELECT id,source_id,body FROM messages WHERE session_id=? AND id<=? ORDER BY id")
      .all(sessionId, through);
  }
}

export function registerSessions(registry: ToolRegistry, store: Store): void {
  registry.register({
    name: "sessions.branch", permission: "sessions.branch", parameters: BranchSessionSchema,
    description: "Start a separate conversation from an earlier message. Needs history.read as well; the original is kept.",
    execute: async (input, context) => {
      if (!context.permissions.has("history.read")) throw new Error("Permission denied: history.read");
      return store.branchSession(context.owner, input);
    },
  });
}
