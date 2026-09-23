import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { WorkspaceFiles } from "./files.js";
import { editPackage, EditOperationSchema, type EditOperation } from "./document-edit.js";
import { buildDocx } from "./document-docx.js";
import { buildXlsx } from "./document-xlsx.js";
import { readDocument } from "./document-readers.js";
import { SheetSchema } from "./document-write.js";

/**
 * FQ-workspace.office: the piece `document-write.ts` and `document-authoring.ts` both say plainly
 * is missing — "two people typing in the same document at the same time". This is that second
 * person. A co-edit session keeps one workspace Word or spreadsheet file's bytes on the server, at
 * a version number both sides can see: the owner, working in the app, and one other person handed a
 * link and a six-character code (the same shape as a conversation share link, `conversation-
 * share.ts`), who needs no account and no bearer key. Either side sends a structured change — the
 * same `EditOperation` the assistant's own `documents.edit` tool sends — and it lands on whatever
 * the *other* side most recently saved, never on a stale copy: two non-conflicting edits both keep
 * their effect, exactly like the merge `workspace.markdown`'s gap asks for, only for office files.
 * A change whose target text was already edited out from under it is not silently dropped or made
 * to clobber the other side's work; `editPackage` already says "nothing matched" when that happens,
 * and that note comes back to whoever sent it, so they can look and send it again.
 *
 * This is deliberately not real-time keystroke-by-keystroke typing (that would need a persistent
 * connection this app's plain request/response server does not keep); it is turn-by-turn structured
 * edits merged on the server, which is the smallest thing that is honestly "editing alongside
 * someone else" rather than "the file was written, then somebody else overwrote it".
 */
export const coeditByteLimit = 20 * 1024 * 1024;
export const coeditKinds = ["docx", "xlsx"] as const;
export type CoeditKind = (typeof coeditKinds)[number];
export const coeditMediaTypes: Record<CoeditKind, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
/** How many wrong codes a co-edit link takes before it stops answering, same shape as a share link. */
export const maxCoeditCodeAttempts = 5;
/** How many log entries a session keeps; older ones are dropped, oldest first. */
const logLimit = 100;

export const StartCoeditSchema = z.object({
  /** A workspace path ending .docx or .xlsx. An existing file is opened; a missing one starts blank. */
  path: z.string().trim().min(1).max(500),
  name: z.string().trim().max(200).default(""),
}).strict();
export const CoeditEditSchema = z.object({ operations: z.array(EditOperationSchema).min(1).max(20) }).strict();
export const CoeditGuestEditSchema = z.object({
  find: z.string().trim().min(1).max(2000), replaceWith: z.string().max(4000), all: z.boolean().default(true),
}).strict();

export interface CoeditLogEntry { participant: "owner" | "guest"; changes: number; notes: string[]; at: string }
export interface CoeditSummary {
  id: string; name: string; path: string; kind: CoeditKind; version: number;
  guestJoined: boolean; createdAt: string; updatedAt: string; log: CoeditLogEntry[];
}
interface CoeditRow {
  id: string; owner: string; name: string; path: string; kind: CoeditKind; version: number; bytes: Buffer;
  salt: string; code_hash: string; guest_joined: number; guest_attempts: number; log: string;
  created_at: string; updated_at: string;
}
const kindOf = (path: string): CoeditKind | null => {
  const lower = path.toLowerCase();
  return lower.endsWith(".docx") ? "docx" : lower.endsWith(".xlsx") ? "xlsx" : null;
};
const hashCode = (code: string, salt: string): string => createHash("sha256").update(`${salt}:${code}`).digest("hex");
const nowIso = (): string => new Date().toISOString();

export class OfficeCoedit {
  constructor(private readonly db: DatabaseSync, private readonly files: WorkspaceFiles) {
    db.exec(`CREATE TABLE IF NOT EXISTS office_coedit_sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      name TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL,
      bytes BLOB NOT NULL, salt TEXT NOT NULL, code_hash TEXT NOT NULL, guest_joined INTEGER NOT NULL DEFAULT 0,
      guest_attempts INTEGER NOT NULL DEFAULT 0, log TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  }

  /** Starts a session: reads the file if it is already there, or starts a blank one if it is not. */
  async start(owner: string, input: unknown): Promise<CoeditSummary & { code: string; link: string }> {
    const value = StartCoeditSchema.parse(input);
    const kind = kindOf(value.path);
    if (!kind) throw new Error("Only Word (.docx) and spreadsheet (.xlsx) files can be edited together");
    const bytes = await this.startingBytes(value.path, kind);
    const id = randomUUID(), salt = randomBytes(8).toString("hex");
    const code = randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
    const at = nowIso(), name = value.name || value.path.split("/").pop()!;
    this.db.prepare(`INSERT INTO office_coedit_sessions(id,owner,name,path,kind,version,bytes,salt,code_hash,
      guest_joined,guest_attempts,log,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?,0,0,'[]',?,?)`)
      .run(id, owner, name, value.path, kind, bytes, salt, hashCode(code, salt), at, at);
    return { ...summaryOf(this.rawRow(id)!), code, link: `/coedit/${id}` };
  }
  private async startingBytes(path: string, kind: CoeditKind): Promise<Buffer> {
    try { return await this.readWorkspace(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
        return kind === "docx" ? buildDocx([], "") : buildXlsx([SheetSchema.parse({ name: "Sheet1" })]);
      throw error;
    }
  }
  private async readWorkspace(path: string): Promise<Buffer> {
    const handle = await open(await this.files.checked(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("That path is not a file");
      if (info.size > coeditByteLimit) throw new Error(`Files up to ${coeditByteLimit / 1048576} MB can be edited together`);
      return await readFile(handle);
    } finally { await handle.close(); }
  }

  /** The owner's own list: every session they started, newest first, without anyone's code in it. */
  list(owner: string): CoeditSummary[] {
    return this.db.prepare(`SELECT * FROM office_coedit_sessions WHERE owner=? ORDER BY updated_at DESC LIMIT 100`)
      .all(owner).map((row) => summaryOf(row as unknown as CoeditRow));
  }
  get(owner: string, id: string): CoeditSummary {
    const row = this.rawRow(id);
    if (!row || row.owner !== owner) throw new Error("That shared edit is not available");
    return summaryOf(row);
  }
  end(owner: string, id: string): { ended: boolean } {
    return { ended: this.db.prepare("DELETE FROM office_coedit_sessions WHERE id=? AND owner=?").run(id, owner).changes > 0 };
  }
  /** The current bytes, for the owner's own download, alongside what to call the file. */
  download(owner: string, id: string): { bytes: Buffer; name: string; kind: CoeditKind } {
    const row = this.rawRow(id);
    if (!row || row.owner !== owner) throw new Error("That shared edit is not available");
    return { bytes: row.bytes, name: row.name, kind: row.kind };
  }

  /** The owner's own change: always allowed, checked only against who owns the session. */
  ownerEdit(owner: string, id: string, input: unknown): { version: number; changes: number; notes: string[] } {
    const row = this.rawRow(id);
    if (!row || row.owner !== owner) throw new Error("That shared edit is not available");
    const value = CoeditEditSchema.parse(input);
    return this.apply(row, "owner", value.operations as EditOperation[]);
  }
  /** The guest's code, checked fresh on every call (this is an ongoing link, not a one-time door). */
  private guestRow(id: string, code: string): CoeditRow {
    const row = this.rawRow(id);
    if (!row) throw new Error("That shared edit is not available");
    if (row.guest_attempts >= maxCoeditCodeAttempts) throw new Error("That shared edit was closed after too many wrong codes");
    const supplied = hashCode(String(code ?? "").trim().toUpperCase(), row.salt);
    if (!timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(row.code_hash, "hex"))) {
      this.db.prepare("UPDATE office_coedit_sessions SET guest_attempts=guest_attempts+1 WHERE id=?").run(id);
      throw new Error("That code is not right");
    }
    if (!row.guest_joined) this.db.prepare("UPDATE office_coedit_sessions SET guest_joined=1 WHERE id=?").run(id);
    return row;
  }
  /** What the guest's page shows: the current words (read back through the same reader the assistant uses), the log, and the file's shape. */
  guestView(id: string, code: string): CoeditSummary & { preview: string } {
    const row = this.guestRow(id, code);
    const read = readDocument(row.bytes, `file.${row.kind}`, { byteLimit: coeditByteLimit });
    return { ...summaryOf(row), preview: read.text.slice(0, 20000) };
  }
  guestDownload(id: string, code: string): { bytes: Buffer; name: string; kind: CoeditKind } {
    const row = this.guestRow(id, code);
    return { bytes: row.bytes, name: row.name, kind: row.kind };
  }
  /** The guest's change: one plain find-and-replace, kept simple because nobody signed in to send it. */
  guestEdit(id: string, code: string, input: unknown): { version: number; changes: number; notes: string[] } {
    const row = this.guestRow(id, code);
    const value = CoeditGuestEditSchema.parse(input);
    return this.apply(row, "guest", [{ op: "replace-text", find: value.find, replaceWith: value.replaceWith, all: value.all }]);
  }

  /**
   * Runs the change against whatever is saved right now, not against what the sender last saw. That
   * is the merge: if the owner already changed a sentence, the guest's own edit to a different
   * sentence still lands, because it is applied to the owner's result, not to a copy from before it.
   */
  private apply(row: CoeditRow, participant: "owner" | "guest", operations: EditOperation[]): { version: number; changes: number; notes: string[] } {
    const latest = this.rawRow(row.id)!; // read again: the other side may have saved since `row` was read
    const done = editPackage(latest.bytes, latest.kind, operations);
    const version = latest.version + (done.changes ? 1 : 0);
    const log = appendLog(latest.log, { participant, changes: done.changes, notes: done.notes, at: nowIso() });
    this.db.prepare("UPDATE office_coedit_sessions SET bytes=?, version=?, log=?, updated_at=? WHERE id=?")
      .run(done.changes ? done.bytes : latest.bytes, version, JSON.stringify(log), nowIso(), row.id);
    return { version, changes: done.changes, notes: done.notes };
  }

  private rawRow(id: string): CoeditRow | null {
    const row = this.db.prepare("SELECT * FROM office_coedit_sessions WHERE id=?").get(id);
    if (!row) return null;
    return {
      id: String(row.id), owner: String(row.owner), name: String(row.name), path: String(row.path),
      kind: String(row.kind) as CoeditKind, version: Number(row.version), bytes: Buffer.from(row.bytes as Uint8Array),
      salt: String(row.salt), code_hash: String(row.code_hash), guest_joined: Number(row.guest_joined),
      guest_attempts: Number(row.guest_attempts), log: String(row.log),
      created_at: String(row.created_at), updated_at: String(row.updated_at),
    };
  }
}
function appendLog(existing: string, entry: CoeditLogEntry): CoeditLogEntry[] {
  let log: CoeditLogEntry[] = [];
  try { log = JSON.parse(existing); } catch { log = []; }
  return [...log, entry].slice(-logLimit);
}
function summaryOf(row: CoeditRow): CoeditSummary {
  let log: CoeditLogEntry[] = [];
  try { log = JSON.parse(row.log); } catch { log = []; }
  return {
    id: row.id, name: row.name, path: row.path, kind: row.kind, version: row.version,
    guestJoined: Boolean(row.guest_joined), createdAt: row.created_at, updatedAt: row.updated_at, log,
  };
}
