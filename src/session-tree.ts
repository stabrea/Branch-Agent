import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import type { Message } from "./contracts.js";

/**
 * Conversations that come off other conversations. Branching already copies a conversation up to a
 * chosen message (see src/sessions.ts); what was missing was a way to see the shape that makes —
 * which conversation came off which, and where — and a way to bring an answer back.
 *
 * Bringing an answer back never merges anything: the branch's last reply is written into the
 * conversation it came from as one note, marked as coming from the branch, so nothing already said
 * is rewritten and the branch is left exactly as it was.
 */
export interface TreeNode {
  sessionId: string;
  /** The first thing said in it, shortened, so a person can tell one from another. */
  title: string;
  createdAt: string;
  messages: number;
  /** Which message of the parent it came off; null for the conversation at the root. */
  branchPointMessageId: number | null;
  children: TreeNode[];
}

const sessionId = z.string().uuid();
export const MergeNoteSchema = z.object({
  /** The branch whose last answer is to be carried back. */
  sessionId,
}).strict();
const titleLimit = 80;

export class SessionTree {
  constructor(private readonly db: DatabaseSync) {}

  /** The whole shape a conversation belongs to, from its root down through everything below it. */
  tree(owner: string, input: string): TreeNode {
    const id = sessionId.parse(input);
    this.requireOwner(owner, id);
    return this.node(owner, this.rootOf(id));
  }

  /**
   * Writes the branch's last answer into the conversation it came off, as one note. The note says
   * where it came from, so anyone reading the conversation later can see it was carried across.
   */
  mergeNote(owner: string, input: unknown): { sessionId: string; parentSessionId: string; note: string } {
    const { sessionId: id } = MergeNoteSchema.parse(input);
    this.requireOwner(owner, id);
    const branch = this.db.prepare("SELECT parent_session_id FROM session_branches WHERE session_id=?").get(id);
    if (!branch) throw new Error("That conversation did not come off another one");
    const parentSessionId = String(branch.parent_session_id);
    const answer = this.lastAnswer(id);
    if (!answer) throw new Error("That branch has no answer to carry back yet");
    const note = `A note carried back from a branch of this conversation:\n\n${answer}`;
    this.db.prepare("INSERT INTO messages(session_id,body) VALUES(?,?)")
      .run(parentSessionId, JSON.stringify({ role: "user", content: note } satisfies Message));
    return { sessionId: id, parentSessionId, note };
  }

  /** The last thing the assistant actually said in a conversation, without any tool requests. */
  private lastAnswer(id: string): string {
    const rows = this.db.prepare("SELECT body FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 200").all(id);
    for (const row of rows) {
      const message = JSON.parse(String(row.body)) as Message;
      if (message.role === "assistant" && !message.toolCalls?.length && message.content.trim())
        return message.content.trim().slice(0, 4000);
    }
    return "";
  }

  /** Walks up the branch records until it reaches a conversation that came off nothing. */
  private rootOf(id: string): string {
    const seen = new Set<string>([id]);
    let current = id;
    for (;;) {
      const row = this.db.prepare("SELECT parent_session_id FROM session_branches WHERE session_id=?").get(current);
      if (!row) return current;
      const parent = String(row.parent_session_id);
      // A record that pointed back at something already walked would loop; stop rather than hang.
      if (seen.has(parent)) return current;
      seen.add(parent);
      current = parent;
    }
  }

  private node(owner: string, id: string): TreeNode {
    const point = this.db.prepare("SELECT branch_point_message_id FROM session_branches WHERE session_id=?").get(id);
    const created = this.db.prepare("SELECT created_at FROM sessions WHERE id=?").get(id);
    const children = this.db.prepare("SELECT session_id FROM session_branches WHERE parent_session_id=? ORDER BY created_at").all(id);
    return {
      sessionId: id,
      title: this.titleOf(id),
      createdAt: String(created?.created_at ?? ""),
      messages: Number(this.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id=?").get(id)?.count ?? 0),
      branchPointMessageId: point ? Number(point.branch_point_message_id) : null,
      children: children.map((child) => this.node(owner, String(child.session_id))),
    };
  }

  private titleOf(id: string): string {
    const row = this.db.prepare("SELECT body FROM messages WHERE session_id=? ORDER BY id LIMIT 20").all(id)
      .map((r) => JSON.parse(String(r.body)) as Message).find((m) => m.role === "user" && m.content.trim());
    const text = (row?.content ?? "Empty conversation").replace(/\s+/g, " ").trim();
    return text.length > titleLimit ? text.slice(0, titleLimit - 1) + "…" : text;
  }

  private requireOwner(owner: string, id: string): void {
    if (!this.db.prepare("SELECT id FROM sessions WHERE id=? AND owner=?").get(id, owner))
      throw new Error("Conversation not found");
  }
}

/**
 * Only seeing the shape reaches the model. Carrying an answer back writes into a conversation the
 * owner is reading, so — like putting a whole checkpoint back — it is their own choice, made from
 * the rail through the HTTP route, and it costs the model's catalog nothing.
 */
export function registerSessionTree(registry: ToolRegistry, _store: Store, tree: SessionTree): void {
  registry.register({
    name: "sessions.tree", permission: "history.read", group: "memory",
    description: "Conversations branched off this one, as a tree.",
    parameters: z.object({ sessionId }).strict(),
    execute: async (input, context) => tree.tree(context.owner, input.sessionId),
  });
}
