import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./contracts.js";
import { WorkspaceFiles } from "./files.js";
import { sliceFor } from "./sandbox-backends.js";

/**
 * Files the owner uploads once and keeps in a library of their own — separate from the workspace —
 * so a task can be given one without the assistant ever being asked to leave it writable. Mounting
 * one writes its bytes into the task's own sandbox folder and then takes the write permission back
 * off the file: the filesystem itself refuses anything that tries to change it from inside the
 * sandbox, the same way a real read-only bind mount would.
 */
export const managedFileBytesLimit = 20 * 1024 * 1024;

export interface ManagedFileMetadata {
  id: string; name: string; mediaType: string; size: number; createdAt: string;
}
/** A plain file name: no path separators, so a mount can never land outside its own folder. */
const nameSchema = /^[^/\\:*?"<>|]{1,200}$/;
const AddSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mediaType: z.string().trim().min(1).max(200).default("application/octet-stream"),
  /** File bytes from the owner, base64 encoded. */
  content: z.string().min(1).max(Math.ceil(managedFileBytesLimit / 3) * 4 + 1024),
}).strict();

export class ManagedFileStore {
  private readonly db: DatabaseSync;
  constructor(private readonly store: Store) {
    this.db = store.sqlite;
    this.db.exec(`CREATE TABLE IF NOT EXISTS managed_files(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL);`);
  }

  /** Adds a file to the owner's library from bytes the browser sent up, base64 encoded. */
  add(owner: string, input: unknown): ManagedFileMetadata {
    const value = AddSchema.parse(input);
    if (!nameSchema.test(value.name)) throw new Error("Give the file a plain name, with no slashes.");
    const bytes = decodeBytes(value.content);
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare("INSERT INTO managed_files VALUES(?,?,?,?,?,?,?)")
      .run(id, owner, value.name, value.mediaType, bytes.length, bytes, now);
    return { id, name: value.name, mediaType: value.mediaType, size: bytes.length, createdAt: now };
  }
  list(owner: string): ManagedFileMetadata[] {
    return this.db.prepare(`SELECT id, name, media_type, size, created_at FROM managed_files
      WHERE owner=? ORDER BY created_at DESC LIMIT 500`).all(owner).map((row) => ({
      id: String(row.id), name: String(row.name), mediaType: String(row.media_type),
      size: Number(row.size), createdAt: String(row.created_at),
    }));
  }
  remove(owner: string, id: string): { removed: string } {
    if (!this.db.prepare("SELECT id FROM managed_files WHERE id=? AND owner=?").get(id, owner))
      throw new Error("That managed file is not in your library.");
    this.db.prepare("DELETE FROM managed_files WHERE id=?").run(id);
    return { removed: id };
  }
  private row(owner: string, id: string): { name: string; bytes: Buffer } {
    const row = this.db.prepare("SELECT name, bytes FROM managed_files WHERE id=? AND owner=?").get(id, owner);
    if (!row) throw new Error("That managed file is not in your library.");
    return { name: String(row.name), bytes: Buffer.from(row.bytes as Uint8Array) };
  }
  /**
   * Writes the managed file into a task's sandbox folder and makes it read-only on disk. The task
   * can see and read it through its mount; a write to that exact path — from the task, or from
   * anything it starts — is refused by the filesystem itself, not by a rule this app is checking.
   */
  async mount(owner: string, id: string, destDir: string): Promise<{ path: string; name: string; size: number }> {
    const { name, bytes } = this.row(owner, id);
    await mkdir(destDir, { recursive: true });
    const path = resolve(destDir, name);
    if (path !== destDir && !path.startsWith(destDir + sep)) throw new Error("That name would leave the mount.");
    // A file left read-only from an earlier mount would otherwise block writeFile below.
    await chmod(path, 0o644).catch(() => undefined);
    await rm(path, { force: true });
    await writeFile(path, bytes);
    await chmod(path, 0o444);
    return { path, name, size: bytes.length };
  }
}

export function registerManagedFiles(registry: ToolRegistry, files: ManagedFileStore): void {
  registry.register({
    name: "files.managed.add", permission: "files.managed.write",
    description: "Upload a file (name, media type, base64 content) to the owner's managed-files library, kept separate from the workspace, so it can later be mounted read-only into a task.",
    parameters: AddSchema,
    execute: async (input, context) => files.add(context.owner, input),
  });
  registry.register({
    name: "files.managed.list", permission: "files.managed.read",
    description: "List the files in the owner's managed-files library.",
    parameters: z.object({}).strict(),
    execute: async (_input, context) => ({ files: files.list(context.owner) }),
  });
  registry.register({
    name: "files.managed.remove", permission: "files.managed.write",
    description: "Take a file out of the owner's managed-files library.",
    parameters: z.object({ id: z.string().min(1).max(100) }).strict(),
    execute: async ({ id }, context) => files.remove(context.owner, id),
  });
  registry.register({
    name: "files.managed.mount", permission: "files.managed.write",
    description: "Mount a managed file into this task's sandbox folder, read-only: the task can read it, but the filesystem itself rejects any write to it.",
    parameters: z.object({ id: z.string().min(1).max(100) }).strict(),
    execute: async ({ id }, context: ToolContext) => {
      const root = await new WorkspaceFiles(context.workspace).checked(".", true);
      const slice = await sliceFor(root, context.sandboxPaths ?? []);
      const mounted = await files.mount(context.owner, id, slice.hostPath);
      return { name: mounted.name, size: mounted.size, folder: context.sandboxPaths?.[0] ?? "." };
    },
  });
}

function decodeBytes(content: string): Buffer {
  const bytes = Buffer.from(content.replace(/^data:[^,]*,/, ""), "base64");
  if (!bytes.length) throw new Error("That file came through empty.");
  if (bytes.length > managedFileBytesLimit) throw new Error(`Managed files up to ${managedFileBytesLimit / 1048576} MB can be added.`);
  return bytes;
}
