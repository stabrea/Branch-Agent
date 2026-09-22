import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AttachmentRefSchema, maximumAttachmentsPerTurn, ToolCallSchema } from "./contracts.js";

export const maximumArchiveBytes = 4 * 1024 * 1024;
const StoredMessageSchema = z.object({
  role: z.enum(["user", "assistant", "tool"]), content: z.string(),
  toolCalls: z.array(ToolCallSchema).max(16).optional(),
  toolCallId: z.string().min(1).max(200).optional(),
  /**
   * A message that was given a file carries these, so the key has to be allowed through or one
   * picture is enough to stop a whole conversation ever being exported, imported or copied. They
   * are taken off again just below.
   */
  attachments: z.array(AttachmentRefSchema).max(maximumAttachmentsPerTurn).optional(),
}).strict().superRefine((message, context) => {
  if ((message.toolCalls !== undefined && message.role !== "assistant") ||
      (message.role === "tool") !== (message.toolCallId !== undefined))
    context.addIssue({ code: "custom", message: "Message fields do not match its role" });
});
/**
 * A copy of a conversation carries its words, never a reference to bytes that did not come with
 * it. An attachment's id names a file inside one conversation's own folder: carried into a second
 * conversation it is either a card that cannot open, or — worse, coming from an archive somebody
 * else wrote — a name of this owner's choosing pointing into a folder they did not fill. Deleting
 * the first conversation would take the second one's cards with it. So the references stop here,
 * at the one gate every copy goes through, and what the message was given stays readable in its
 * own words: the runtime already writes "[attached file: one.png (picture)]" into the text.
 */
const MessageSchema = StoredMessageSchema.transform(({ attachments, ...message }) => message);
const ArchiveSchema = z.object({
  format: z.literal("branch-agent-conversation"), version: z.literal(1),
  exportedAt: z.iso.datetime(), messages: z.array(MessageSchema).min(1).max(1000),
}).strict();
export const SessionSearchSchema = z.object({
  query: z.string().trim().max(500).default(""),
  offset: z.number().int().min(0).max(1000000).default(0),
  /** Wave 6: only conversations carrying every one of these labels. */
  labels: z.array(z.string().trim().min(1).max(40)).max(5).default([]),
}).strict();
type Archive = z.infer<typeof ArchiveSchema>;

/** Imported tool messages are historical evidence, never executable requests. */
export function parseConversationArchive(input: unknown): Archive {
  const serialized = JSON.stringify(input);
  if (!serialized || Buffer.byteLength(serialized) > maximumArchiveBytes)
    throw new Error("Conversation archive exceeds 4 MiB");
  const archive = ArchiveSchema.parse(input);
  const pending = new Set<string>();
  for (const message of archive.messages) {
    if (message.role === "tool") {
      if (!pending.delete(message.toolCallId!)) throw new Error("Unmatched or repeated tool result");
    } else {
      if (pending.size) throw new Error("Conversation contains unfinished tool requests");
      for (const call of message.toolCalls ?? []) {
        let args: unknown;
        try { args = JSON.parse(call.arguments) as unknown; }
        catch { throw new Error("Saved tool arguments must be valid JSON objects"); }
        if (!args || typeof args !== "object" || Array.isArray(args))
          throw new Error("Saved tool arguments must be valid JSON objects");
        if (pending.has(call.id)) throw new Error("Repeated tool request identifier");
        pending.add(call.id);
      }
    }
  }
  if (pending.size) throw new Error("Conversation contains unfinished tool requests");
  return archive;
}

/** phase2/rooms: leaves the given conversations out of a list (bound as parameters, never written in). */
const notIn = (hidden: readonly string[]): string => (hidden.length ? `AND s.id NOT IN (${hidden.map(() => "?").join(",")})` : "");

export class SessionLibrary {
  constructor(private readonly db: DatabaseSync) {
    db.function("branch_fold", { deterministic: true }, value => String(value ?? "").normalize("NFC").toLowerCase());
    db.exec(`CREATE TABLE IF NOT EXISTS session_origins(
      session_id TEXT PRIMARY KEY REFERENCES sessions(id), imported INTEGER NOT NULL,
      duplicated_from TEXT, created_at TEXT NOT NULL)`);
  }
  imported(sessionId: string): boolean {
    return this.db.prepare(`WITH RECURSIVE lineage(id) AS (
      SELECT ? UNION SELECT b.parent_session_id FROM session_branches b JOIN lineage l ON b.session_id=l.id)
      SELECT 1 AS found FROM session_origins o JOIN lineage l ON o.session_id=l.id WHERE o.imported=1 LIMIT 1`)
      .get(sessionId)?.found === 1;
  }
  /**
   * The conversations to show on a small screen: the most recent ones, each with how it started
   * and what was last said, so picking up on a phone what was begun at the desk needs one request.
   * It is the same list the app already shows, served through the same door and the same key.
   */
  /** `hidden`: conversations kept out of every list (phase2/rooms: a Trunk's side of a room). */
  recent(owner: string, limit = 20, hidden: readonly string[] = []) {
    const rows = this.db.prepare(`SELECT s.id, s.created_at,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id) AS message_count,
      (SELECT substr(json_extract(m.body,'$.content'),1,240) FROM messages m
        WHERE m.session_id=s.id AND json_extract(m.body,'$.role') IN ('user','assistant')
        ORDER BY m.id LIMIT 1) AS opening,
      (SELECT substr(json_extract(m.body,'$.content'),1,240) FROM messages m
        WHERE m.session_id=s.id AND json_extract(m.body,'$.role') IN ('user','assistant')
        ORDER BY m.id DESC LIMIT 1) AS latest,
      (SELECT json_extract(m.body,'$.role') FROM messages m
        WHERE m.session_id=s.id AND json_extract(m.body,'$.role') IN ('user','assistant')
        ORDER BY m.id DESC LIMIT 1) AS latest_role
      FROM sessions s WHERE s.owner=? AND s.temporary=0 ${notIn(hidden)}
      ORDER BY s.created_at DESC, s.id DESC LIMIT ?`).all(owner, ...hidden, Math.min(Math.max(limit, 1), 100));
    return {
      sessions: rows.map((row) => ({
        sessionId: String(row.id), createdAt: String(row.created_at), messageCount: Number(row.message_count),
        opening: String(row.opening ?? ""), lastMessage: String(row.latest ?? ""),
        lastSpeaker: row.latest_role === null ? "" : String(row.latest_role),
      })),
    };
  }
  search(owner: string, input: unknown, hidden: readonly string[] = []) {
    const { query, offset, labels } = SessionSearchSchema.parse(input);
    const wanted = labels.map((label) => label.toLocaleLowerCase("en"));
    // Only conversations carrying every wanted label; an empty list means no label filter at all.
    const labelFilter = wanted.length
      ? `AND s.id IN (SELECT target_id FROM labels WHERE owner=? AND target='conversation'
          AND label IN (${wanted.map(() => "?").join(",")}) GROUP BY target_id HAVING COUNT(DISTINCT label)=?)`
      : "";
    const labelArgs = wanted.length ? [owner, ...wanted, wanted.length] : [];
    const rows = this.db.prepare(`SELECT s.id,s.created_at,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id) AS message_count,
      (SELECT substr(json_extract(m.body,'$.content'),1,240) FROM messages m
        WHERE m.session_id=s.id AND json_extract(m.body,'$.role') IN ('user','assistant')
        ORDER BY m.id LIMIT 1) AS preview
      FROM sessions s WHERE s.owner=? AND s.temporary=0 AND EXISTS(SELECT 1 FROM messages m WHERE m.session_id=s.id
        AND json_extract(m.body,'$.role') IN ('user','assistant')
        AND (?='' OR instr(branch_fold(json_extract(m.body,'$.content')),branch_fold(?))>0))
      ${labelFilter} ${notIn(hidden)}
      ORDER BY s.created_at DESC,s.id DESC LIMIT 21 OFFSET ?`).all(owner, query, query, ...labelArgs, ...hidden, offset);
    return {
      sessions: rows.slice(0, 20).map(row => ({ sessionId: String(row.id),
        createdAt: String(row.created_at), preview: String(row.preview ?? ""),
        messageCount: Number(row.message_count) })),
      nextOffset: rows.length > 20 && offset + 20 <= 1000000 ? offset + 20 : null,
    };
  }
  export(owner: string, input: string): Archive {
    const sessionId = z.string().uuid().parse(input);
    this.requireIdleOwner(owner, sessionId);
    const size = this.db.prepare(`SELECT COUNT(*) AS count,
      COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM messages WHERE session_id=?`).get(sessionId)!;
    if (Number(size.count) > 1000 || Number(size.bytes) > maximumArchiveBytes)
      throw new Error("Conversation archive exceeds 1000 messages or 4 MiB");
    const messages = this.db.prepare("SELECT body FROM messages WHERE session_id=? ORDER BY id")
      .all(sessionId).map(row => JSON.parse(String(row.body)) as unknown);
    return parseConversationArchive({ format: "branch-agent-conversation", version: 1,
      exportedAt: new Date().toISOString(), messages });
  }
  /**
   * Batch 26 (wave 8): the conversations a retention rule would sweep up — the ones older than the
   * owner's cut-off, and, when the whole history is bigger than the ceiling they set, the oldest
   * ones until it fits again. Nothing is deleted here: this only says what would be, so the owner
   * can be shown the list before anything happens.
   */
  prunable(owner: string, days: number, megabytes: number, now = Date.now()) {
    const rows = this.db.prepare(`SELECT s.id, s.created_at,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id) AS message_count,
      (SELECT COALESCE(SUM(length(CAST(m.body AS BLOB))),0) FROM messages m WHERE m.session_id=s.id) AS bytes
      FROM sessions s WHERE s.owner=? AND s.temporary=0 ORDER BY s.created_at ASC, s.id ASC`).all(owner);
    const all = rows.map((row) => ({ sessionId: String(row.id), createdAt: String(row.created_at),
      messageCount: Number(row.message_count), bytes: Number(row.bytes), why: "" }));
    const cutoff = days > 0 ? now - days * 86_400_000 : null;
    const wanted = new Map<string, { sessionId: string; createdAt: string; messageCount: number; bytes: number; why: string }>();
    for (const entry of all)
      if (cutoff !== null && Date.parse(entry.createdAt) < cutoff)
        wanted.set(entry.sessionId, { ...entry, why: `older than ${days} day${days === 1 ? "" : "s"}` });
    let total = all.reduce((sum, entry) => sum + entry.bytes, 0);
    const ceiling = megabytes > 0 ? megabytes * 1_048_576 : null;
    for (const entry of wanted.values()) total -= entry.bytes;
    if (ceiling !== null)
      for (const entry of all) {
        if (total <= ceiling) break;
        if (wanted.has(entry.sessionId)) continue;
        wanted.set(entry.sessionId, { ...entry, why: `the whole history is over ${megabytes} MB` });
        total -= entry.bytes;
      }
    return { conversations: [...wanted.values()], bytes: all.reduce((sum, entry) => sum + entry.bytes, 0) };
  }
  import(owner: string, input: unknown) {
    return this.copy(owner, parseConversationArchive(input), true);
  }
  duplicate(owner: string, sessionId: string) {
    return this.copy(owner, this.export(owner, sessionId), this.imported(sessionId), sessionId);
  }
  private requireIdleOwner(owner: string, sessionId: string) {
    const session = this.db.prepare("SELECT temporary FROM sessions WHERE id=? AND owner=?").get(sessionId, owner);
    if (!session) throw new Error("Conversation not found");
    if (Number(session.temporary) === 1) throw new Error("Temporary conversations cannot be exported or copied");
    if (this.db.prepare("SELECT id FROM tasks WHERE session_id=? AND status='running'").get(sessionId))
      throw new Error("Wait for this conversation's active task before exporting or duplicating it");
  }
  private copy(owner: string, archive: Archive, imported: boolean, source?: string) {
    const sessionId = randomUUID(), now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO sessions(id,owner,created_at) VALUES(?,?,?)").run(sessionId, owner, now);
      const insert = this.db.prepare("INSERT INTO messages(session_id,body) VALUES(?,?)");
      for (const message of archive.messages) insert.run(sessionId, JSON.stringify(message));
      this.db.prepare("INSERT INTO session_origins VALUES(?,?,?,?)")
        .run(sessionId, Number(imported), source ?? null, now);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { sessionId, copiedMessages: archive.messages.length };
  }
}
