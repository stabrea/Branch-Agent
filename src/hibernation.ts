import { randomUUID, createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * A serverless deployment scales an operation's compute to zero once it sits idle, and starts it
 * again when the owner comes back to it. Suspend stops Branch treating an operation as running —
 * for the local adapter, that is the only compute there is to destroy — and freezes the exact bytes
 * of its workspace as hashes. Resume checks the workspace against those hashes, so the owner is told
 * plainly whether it came back intact or what changed, then picks the operation back up from the
 * step it had reached rather than starting over.
 *
 * Everything lives under `<dataDir>/hibernation/<id>/`, read fresh from disk on every call, so a
 * restart of Branch itself — the real test that compute was destroyed, not just marked so in memory
 * — still resumes correctly.
 */

export const HibernationSettingsSchema = z.object({
  /** The name the owner gave the serverless target. Only "local" ever really runs; a cloud name is
   *  accepted so a future adapter can be swapped in without changing the operation's shape (see the
   *  seam noted in hibernation-api.ts). */
  environment: z.string().trim().min(1).max(80).default("local"),
}).strict();
export type HibernationSettings = z.infer<typeof HibernationSettingsSchema>;

export interface SettingsStore {
  get(kind: string, owner: string, key: string): { data: unknown } | undefined;
  save(kind: string, owner: string, key: string, data: Record<string, unknown>): unknown;
}

export function hibernationSettings(store: SettingsStore, owner: string): HibernationSettings {
  const saved = HibernationSettingsSchema.safeParse(store.get("settings", owner, "hibernation")?.data ?? {});
  return saved.success ? saved.data : HibernationSettingsSchema.parse({});
}
export function saveHibernationSettings(store: SettingsStore, owner: string, input: unknown): HibernationSettings {
  const value = HibernationSettingsSchema.parse(input ?? {});
  store.save("settings", owner, "hibernation", { ...value });
  return value;
}

export type OperationStatus = "running" | "suspended" | "done";

export interface OperationRecord {
  id: string;
  environment: string;
  steps: string[];
  step: number;
  status: OperationStatus;
  /** File name → sha256, taken the moment the operation was last suspended. Empty until then. */
  hashes: Record<string, string>;
}

export type WorkspaceCheck = { intact: true } | { intact: false; changed: string[] };

export class OperationNotFoundError extends Error {
  constructor(id: string) { super(`No operation by the id ${id}`); }
}

/** The workspace's files, named and hashed, in a stable order. */
async function hashWorkspace(dir: string): Promise<Record<string, string>> {
  const files = (await readdir(dir)).sort();
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file] = createHash("sha256").update(await readFile(join(dir, file))).digest("hex");
  return hashes;
}

/** Where a file name changed, went missing, or turned up that was not there when it was frozen. */
function workspaceDiff(expected: Record<string, string>, actual: Record<string, string>): string[] {
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...names].filter((name) => expected[name] !== actual[name]).sort();
}

export class HibernationStore {
  constructor(private readonly dataDir: string) {}

  private opDir(id: string): string { return join(this.dataDir, "hibernation", id); }
  private manifestPath(id: string): string { return join(this.opDir(id), "manifest.json"); }
  workspacePath(id: string): string { return join(this.opDir(id), "workspace"); }

  private async writeManifest(record: OperationRecord): Promise<void> {
    await writeFile(this.manifestPath(record.id), JSON.stringify(record, null, 2), "utf8");
  }

  async read(id: string): Promise<OperationRecord> {
    try {
      return JSON.parse(await readFile(this.manifestPath(id), "utf8")) as OperationRecord;
    } catch {
      throw new OperationNotFoundError(id);
    }
  }

  /** Starts a new operation in the configured environment, with its work laid out as named steps. */
  async start(environment: string, steps: string[]): Promise<OperationRecord> {
    const id = randomUUID();
    await mkdir(this.workspacePath(id), { recursive: true });
    const record: OperationRecord = { id, environment, steps, step: 0, status: "running", hashes: {} };
    await this.writeManifest(record);
    return record;
  }

  /** Runs the next step: writes its output into the workspace and moves the operation's checkpoint forward. */
  async advance(id: string): Promise<OperationRecord> {
    const record = await this.read(id);
    if (record.status !== "running") throw new Error("Only a running operation can be advanced.");
    const label = record.steps[record.step];
    if (label !== undefined) {
      await writeFile(join(this.workspacePath(id), `step-${record.step}.txt`), label, "utf8");
      record.step += 1;
    }
    if (record.step >= record.steps.length) record.status = "done";
    await this.writeManifest(record);
    return record;
  }

  /** Suspends the operation's serverless compute: freezes the workspace's bytes and refuses further steps
   *  until it is resumed. */
  async suspend(id: string): Promise<OperationRecord> {
    const record = await this.read(id);
    if (record.status !== "running") throw new Error("Only a running operation can be suspended.");
    record.hashes = await hashWorkspace(this.workspacePath(id));
    record.status = "suspended";
    await this.writeManifest(record);
    return record;
  }

  /** Resumes a suspended operation: checks the workspace against the bytes frozen at suspend, then
   *  continues from the saved step — never from the start. */
  async resume(id: string): Promise<{ record: OperationRecord; workspace: WorkspaceCheck }> {
    const record = await this.read(id);
    if (record.status !== "suspended") throw new Error("Only a suspended operation can be resumed.");
    const changed = workspaceDiff(record.hashes, await hashWorkspace(this.workspacePath(id)));
    record.status = "running";
    await this.writeManifest(record);
    return { record, workspace: changed.length ? { intact: false, changed } : { intact: true } };
  }
}
