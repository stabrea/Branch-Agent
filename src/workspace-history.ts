import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, lstat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { WorkspaceFiles } from "./files.js";
import type { ToolRegistry } from "./registry.js";

/**
 * Workspace history: the exact bytes of a file before the assistant changes it, a readable
 * before-and-after diff for each change, and whole-workspace snapshots that restore every file
 * to its exact previous bytes.
 */
export interface FileVersion { id: string; path: string; bytes: number; existed: boolean; runId: string; reason: string; snapshotId: string | null; createdAt: string }
export interface FileChange { path: string; versionId: string | null; existed: boolean; added: number; removed: number; diff: string }
export interface Snapshot { id: string; label: string; files: number; bytes: number; createdAt: string }
const skipDirs = new Set(["node_modules", ".git", "dist", "release", ".branch"]);
const secretName = /(^\.env($|\.)|^\.ssh$|^\.aws$|credentials|secrets?|^id_rsa|^id_ed25519|\.(pem|key|p12|pfx)$)/i;
export const snapshotLimits = { files: 500, fileBytes: 256 * 1024, totalBytes: 16 * 1024 * 1024 };
const diffLimit = 8000;

/** Line diff by longest common subsequence, rendered like a compact unified diff. */
export function lineDiff(before: string, after: string): { added: number; removed: number; diff: string } {
  const a = before.length ? before.split(/\r?\n/) : [], b = after.length ? after.split(/\r?\n/) : [];
  if (a.length * b.length > 4_000_000) return { added: b.length, removed: a.length, diff: "(files too large to compare line by line)" };
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const lines: string[] = []; let added = 0, removed = 0, i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push(` ${a[i]}`); i++; j++; }
    else if (j < b.length && (i >= a.length || table[i]![j + 1]! >= table[i + 1]![j]!)) { lines.push(`+${b[j]}`); added++; j++; }
    else { lines.push(`-${a[i]}`); removed++; i++; }
  }
  const kept = lines.filter((line, index) => line[0] !== " " || lines.slice(Math.max(0, index - 2), index + 3).some((l) => l[0] !== " "));
  const text = kept.join("\n");
  return { added, removed, diff: text.length > diffLimit ? text.slice(0, diffLimit) + "\n… (diff shortened)" : text };
}

export class WorkspaceHistory {
  constructor(private readonly db: DatabaseSync, private readonly files: WorkspaceFiles, private readonly owner: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS file_versions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, path TEXT NOT NULL, snapshot_id TEXT,
      content TEXT NOT NULL, bytes INTEGER NOT NULL, existed INTEGER NOT NULL, run_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS file_versions_path ON file_versions(owner, path, created_at);
      CREATE TABLE IF NOT EXISTS workspace_snapshots(id TEXT PRIMARY KEY, owner TEXT NOT NULL, label TEXT NOT NULL, files INTEGER NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL);`);
  }
  private async current(path: string): Promise<Buffer | null> {
    try { return await readFile(await this.files.checked(path)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private insert(path: string, content: Buffer | null, runId: string, reason: string, snapshotId: string | null): FileVersion {
    const version: FileVersion = { id: randomUUID(), path, bytes: content?.length ?? 0, existed: content !== null, runId, reason, snapshotId, createdAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO file_versions VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(version.id, this.owner, path, snapshotId, content ? content.toString("base64") : "", version.bytes, Number(version.existed), runId, reason, version.createdAt);
    return version;
  }
  /** Keeps the file's exact bytes before a change so the change can be undone. */
  async before(path: string, context: ToolContext): Promise<{ version: FileVersion; text: string }> {
    const content = await this.current(path);
    const version = this.insert(path, content, context.runId, "before write", null);
    return { version, text: content ? content.toString("utf8") : "" };
  }
  /** The readable difference between the kept version and what the file holds now. */
  async change(path: string, before: { version: FileVersion; text: string }): Promise<FileChange> {
    const now = await this.current(path);
    const { added, removed, diff } = lineDiff(before.text, now ? now.toString("utf8") : "");
    return { path, versionId: before.version.id, existed: before.version.existed, added, removed, diff };
  }
  history(path: string): FileVersion[] {
    return this.db.prepare("SELECT * FROM file_versions WHERE owner=? AND path=? ORDER BY created_at DESC, rowid DESC LIMIT 50").all(this.owner, path).map((row) => this.toVersion(row));
  }
  /** Writes a kept version's exact bytes back; a version of a file that did not exist removes nothing but writes an empty file only if asked. */
  async restore(versionId: string): Promise<{ path: string; bytes: number; restored: boolean }> {
    const row = this.db.prepare("SELECT * FROM file_versions WHERE owner=? AND id=?").get(this.owner, versionId);
    if (!row) throw new Error("That earlier version is not kept");
    const path = String(row.path), target = await this.files.checked(path);
    if (!Number(row.existed)) return { path, bytes: 0, restored: false };
    const content = Buffer.from(String(row.content), "base64");
    this.insert(path, await this.current(path), "", `before restore of ${versionId}`, null);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o600 });
    return { path, bytes: content.length, restored: true };
  }
  /** Records every readable workspace file (bounded) under one snapshot id. */
  async snapshot(input: unknown): Promise<Snapshot> {
    const { label } = z.object({ label: z.string().trim().min(1).max(120).default("Snapshot") }).strict().parse(input ?? {});
    const id = randomUUID(); let files = 0, bytes = 0;
    for (const path of await this.walk()) {
      const content = await readFile(join(this.files.root, path));
      if (content.length > snapshotLimits.fileBytes) continue;
      if (files >= snapshotLimits.files || bytes + content.length > snapshotLimits.totalBytes) throw new Error(`The workspace is too large to snapshot (limit ${snapshotLimits.files} files, ${snapshotLimits.totalBytes / 1048576} MB)`);
      this.insert(path, content, "", "snapshot", id); files++; bytes += content.length;
    }
    const snapshot: Snapshot = { id, label, files, bytes, createdAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO workspace_snapshots VALUES(?,?,?,?,?,?)").run(id, this.owner, label, files, bytes, snapshot.createdAt);
    return snapshot;
  }
  snapshots(): Snapshot[] {
    return this.db.prepare("SELECT * FROM workspace_snapshots WHERE owner=? ORDER BY created_at DESC LIMIT 50").all(this.owner)
      .map((row) => ({ id: String(row.id), label: String(row.label), files: Number(row.files), bytes: Number(row.bytes), createdAt: String(row.created_at) }));
  }
  /** Puts every file in the snapshot back to its exact bytes; files created since are left in place. */
  async restoreSnapshot(id: string): Promise<{ id: string; restored: number }> {
    const rows = this.db.prepare("SELECT path, content FROM file_versions WHERE owner=? AND snapshot_id=?").all(this.owner, id);
    if (!rows.length) throw new Error("That snapshot is not kept");
    let restored = 0;
    for (const row of rows) {
      const path = String(row.path), target = await this.files.checked(path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(String(row.content), "base64"), { mode: 0o600 });
      restored++;
    }
    return { id, restored };
  }
  private async walk(dir = this.files.root, out: string[] = []): Promise<string[]> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name), rel = relative(this.files.root, full).split("\\").join("/");
      if (secretName.test(entry.name)) continue;
      if (entry.isDirectory()) { if (!skipDirs.has(entry.name)) await this.walk(full, out); continue; }
      if (entry.isFile() && !(await lstat(full)).isSymbolicLink()) out.push(rel);
      if (out.length > snapshotLimits.files) break;
    }
    return out;
  }
  private toVersion(row: Record<string, unknown>): FileVersion {
    return { id: String(row.id), path: String(row.path), bytes: Number(row.bytes), existed: Number(row.existed) === 1, runId: String(row.run_id),
      reason: String(row.reason), snapshotId: row.snapshot_id === null ? null : String(row.snapshot_id), createdAt: String(row.created_at) };
  }
}

export function registerWorkspaceHistory(registry: ToolRegistry, history: WorkspaceHistory): void {
  registry.register({
    name: "files.history", permission: "files.read",
    description: "Earlier kept versions of a workspace file (before each change the assistant made, and snapshots).",
    parameters: z.object({ path: z.string().min(1).max(500) }).strict(),
    execute: async ({ path }) => history.history(path),
  });
  registry.register({
    name: "files.restore", permission: "files.write",
    description: "Put a workspace file back to a kept earlier version by that version's id (from files.history).",
    parameters: z.object({ versionId: z.string().uuid() }).strict(),
    execute: async ({ versionId }) => history.restore(versionId),
  });
  registry.register({
    name: "workspace.snapshot", permission: "files.write",
    description: "Keep a snapshot of every workspace file so the whole workspace can be put back later.",
    parameters: z.object({ label: z.string().trim().min(1).max(120).optional() }).strict(),
    execute: async ({ label }) => history.snapshot(label ? { label } : {}),
  });
}
