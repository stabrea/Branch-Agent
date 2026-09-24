import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/**
 * Comments pinned to a moment in a media file (a video today; any file with a running time later).
 * A comment remembers the file it is about, the second it was left at, who left it and when, so a
 * viewer can reopen it later at the same position instead of scrubbing to find it again.
 *
 * Kept as its own small table, the same way `labels.ts` keeps its own — no new database, just one
 * more table in the store everything else already writes through.
 */
export const MediaCommentSchema = z.object({
  fileId: z.string().trim().min(1).max(500),
  atSeconds: z.number().finite().nonnegative(),
  text: z.string().trim().min(1).max(2000),
}).strict();
export interface MediaCommentRow {
  id: string;
  fileId: string;
  atSeconds: number;
  text: string;
  author: string;
  createdAt: string;
}
const maximumPerFile = 500;

export class MediaComments {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS media_comments(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      file_id TEXT NOT NULL, at_seconds REAL NOT NULL, text TEXT NOT NULL, author TEXT NOT NULL,
      created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS media_comments_file ON media_comments(owner, file_id);`);
  }

  /** Pins one comment to a moment in a file. `atSeconds` must be a real, non-negative number. */
  add(owner: string, author: string, input: unknown): MediaCommentRow {
    const value = MediaCommentSchema.parse(input);
    if (this.list(owner, value.fileId).length >= maximumPerFile)
      throw new Error(`At most ${maximumPerFile} comments on one file`);
    const row: MediaCommentRow = { id: randomUUID(), ...value, author, createdAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO media_comments(id, owner, file_id, at_seconds, text, author, created_at) VALUES(?,?,?,?,?,?,?)")
      .run(row.id, owner, row.fileId, row.atSeconds, row.text, row.author, row.createdAt);
    return row;
  }

  /** Every comment on one file, earliest moment first, so a list reads the way the file plays. */
  list(owner: string, fileId: string): MediaCommentRow[] {
    return this.db.prepare(
      "SELECT id, file_id, at_seconds, text, author, created_at FROM media_comments WHERE owner=? AND file_id=? ORDER BY at_seconds ASC, created_at ASC"
    ).all(owner, fileId).map((row) => ({
      id: String(row.id), fileId: String(row.file_id), atSeconds: Number(row.at_seconds),
      text: String(row.text), author: String(row.author), createdAt: String(row.created_at),
    }));
  }

  remove(owner: string, id: string): { removed: boolean } {
    return { removed: this.db.prepare("DELETE FROM media_comments WHERE owner=? AND id=?").run(owner, id).changes > 0 };
  }
}
