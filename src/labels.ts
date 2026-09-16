import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ToolRegistry } from "./registry.js";

/**
 * Labels and project notes. A label is one short word the owner sticks on a conversation, a saved
 * procedure or a document so they can find it again; the rail search and the command palette filter
 * by them. Project notes are the owner's own remarks about a project, kept with the time they were
 * written. Both travel with the backup.
 */
export const labelTargets = ["conversation", "procedure", "document"] as const;
export type LabelTarget = (typeof labelTargets)[number];
/** A label is a word or two. However it is typed, it is kept and matched in lower case. */
const labelName = z.string().trim().min(1).max(40)
  .regex(/^[^\s,]+(?: [^\s,]+)*$/, "A label is a word or two, without commas");
const fold = (label: string): string => label.trim().toLocaleLowerCase("en");
export const LabelSchema = z.object({
  target: z.enum(labelTargets),
  targetId: z.string().min(1).max(200),
  label: labelName,
}).strict();
export const CommentSchema = z.object({
  project: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Project ids use lowercase letters, digits and dashes"),
  body: z.string().trim().min(1).max(2000),
}).strict();
export interface LabelRow { target: LabelTarget; targetId: string; label: string; createdAt: string }
export interface CommentRow { id: string; project: string; body: string; createdAt: string }
const maximumPerTarget = 20;

export class Labels {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS labels(owner TEXT NOT NULL, target TEXT NOT NULL,
      target_id TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(owner,target,target_id,label));
      CREATE TABLE IF NOT EXISTS project_notes(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      project TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }
  /** Sticks a label on one thing. Sticking the same one twice changes nothing. */
  add(owner: string, input: unknown): LabelRow {
    const parsed = LabelSchema.parse(input);
    const value = { ...parsed, label: fold(parsed.label) };
    if (this.forTarget(owner, value.target, value.targetId).length >= maximumPerTarget)
      throw new Error(`At most ${maximumPerTarget} labels on one thing`);
    const createdAt = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO labels VALUES(?,?,?,?,?)")
      .run(owner, value.target, value.targetId, value.label, createdAt);
    return { ...value, createdAt };
  }
  remove(owner: string, input: unknown): { removed: boolean } {
    const value = LabelSchema.parse(input);
    return { removed: this.db.prepare("DELETE FROM labels WHERE owner=? AND target=? AND target_id=? AND label=?")
      .run(owner, value.target, value.targetId, fold(value.label)).changes > 0 };
  }
  /** The labels on one thing, in alphabetical order. */
  forTarget(owner: string, target: LabelTarget, targetId: string): string[] {
    return this.db.prepare("SELECT label FROM labels WHERE owner=? AND target=? AND target_id=? ORDER BY label")
      .all(owner, target, targetId).map((row) => String(row.label));
  }
  /** Every label in use, with how many things carry it, most used first. */
  catalog(owner: string, target?: LabelTarget): { label: string; count: number }[] {
    const rows = target
      ? this.db.prepare("SELECT label, COUNT(*) AS n FROM labels WHERE owner=? AND target=? GROUP BY label ORDER BY n DESC, label").all(owner, target)
      : this.db.prepare("SELECT label, COUNT(*) AS n FROM labels WHERE owner=? GROUP BY label ORDER BY n DESC, label").all(owner);
    return rows.map((row) => ({ label: String(row.label), count: Number(row.n) }));
  }
  /** What carries every one of these labels; an empty list means "no filter". */
  matching(owner: string, target: LabelTarget, labels: string[]): string[] | null {
    const wanted = labels.map(fold).filter(Boolean);
    if (!wanted.length) return null;
    const rows = this.db.prepare(`SELECT target_id FROM labels WHERE owner=? AND target=?
      AND label IN (${wanted.map(() => "?").join(",")}) GROUP BY target_id HAVING COUNT(DISTINCT label)=?`)
      .all(owner, target, ...wanted, wanted.length);
    return rows.map((row) => String(row.target_id));
  }
  /** Everything labelled, newest first, for the rail and the command palette. */
  list(owner: string, target?: LabelTarget): LabelRow[] {
    const rows = target
      ? this.db.prepare("SELECT * FROM labels WHERE owner=? AND target=? ORDER BY created_at DESC LIMIT 500").all(owner, target)
      : this.db.prepare("SELECT * FROM labels WHERE owner=? ORDER BY created_at DESC LIMIT 500").all(owner);
    return rows.map((row) => ({ target: String(row.target) as LabelTarget, targetId: String(row.target_id),
      label: String(row.label), createdAt: String(row.created_at) }));
  }
  /** Writes a note against a project; the project switcher shows them newest first. */
  comment(owner: string, input: unknown): CommentRow {
    const value = CommentSchema.parse(input);
    const row: CommentRow = { id: randomUUID(), ...value, createdAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO project_notes VALUES(?,?,?,?,?)")
      .run(row.id, owner, row.project, row.body, row.createdAt);
    return row;
  }
  comments(owner: string, project: string): CommentRow[] {
    return this.db.prepare("SELECT * FROM project_notes WHERE owner=? AND project=? ORDER BY created_at DESC LIMIT 200")
      .all(owner, project).map((row) => ({ id: String(row.id), project: String(row.project),
        body: String(row.body), createdAt: String(row.created_at) }));
  }
  removeComment(owner: string, id: string): { removed: boolean } {
    return { removed: this.db.prepare("DELETE FROM project_notes WHERE owner=? AND id=?").run(owner, id).changes > 0 };
  }
}

/** Tools so the assistant can label things and read the owner's notes on a project. */
export function registerLabels(registry: ToolRegistry, labels: Labels): void {
  registry.register({
    name: "labels.add",
    description: "Stick a short label on a conversation, a saved procedure or a document so it can be found again.",
    permission: "labels.manage",
    parameters: LabelSchema,
    execute: async (value, context) => labels.add(context.owner, value),
  });
  registry.register({
    name: "labels.remove",
    description: "Take a label off a conversation, a saved procedure or a document.",
    permission: "labels.manage",
    parameters: LabelSchema,
    execute: async (value, context) => labels.remove(context.owner, value),
  });
  registry.register({
    name: "labels.list",
    description: "Every label in use with how many things carry it, and what carries a given label.",
    permission: "labels.read",
    parameters: z.object({ target: z.enum(labelTargets).optional(), label: z.string().trim().max(40).optional() }).strict(),
    execute: async (value, context) => ({
      catalog: labels.catalog(context.owner, value.target),
      matching: value.label && value.target ? labels.matching(context.owner, value.target, [value.label]) : null,
    }),
  });
  registry.register({
    name: "projects.notes",
    description: "The owner's own notes on a project, newest first, with when each was written.",
    permission: "labels.read",
    parameters: CommentSchema.pick({ project: true }),
    execute: async (value, context) => ({ notes: labels.comments(context.owner, value.project) }),
  });
}
