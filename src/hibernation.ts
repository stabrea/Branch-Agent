import { randomUUID, createHash } from "node:crypto";
import { mkdir, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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
  /** Path inside the workspace (forward slashes; a folder ends in "/") → sha256, taken the moment
   *  the operation was last suspended. Empty until then. */
  hashes: Record<string, string>;
}

export type WorkspaceCheck = { intact: true } | { intact: false; changed: string[] };

export class OperationNotFoundError extends Error {
  constructor(id: string) { super(`No operation by the id ${id}`); }
}
/** The operation is not in a state that allows what was asked (advancing a suspended one, say). */
export class OperationStateError extends Error {}
/** Resume found the workspace different from the bytes frozen at suspend, and was not told to go on anyway. */
export class WorkspaceChangedError extends Error {
  constructor(readonly changed: string[]) {
    super(`The workspace changed since it was suspended: ${changed.join(", ")}. It stays suspended; resume it again saying to continue anyway if that is what you want.`);
  }
}

/** Only the ids the store makes itself (randomUUID) name an operation; anything else names no folder. */
const operationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The workspace's files and folders, named by their path inside it and hashed, in a stable order.
 *  A folder is walked, not read as a file; a link is recorded by where it points and never followed. */
async function hashWorkspace(root: string, inside = ""): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const entries = (await readdir(join(root, inside), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const name = inside ? `${inside}/${entry.name}` : entry.name;
    const full = join(root, inside, entry.name);
    if (entry.isSymbolicLink()) hashes[name] = `link:${await readlink(full)}`;
    else if (entry.isDirectory()) {
      hashes[`${name}/`] = "folder";
      Object.assign(hashes, await hashWorkspace(root, name));
    } else if (entry.isFile()) hashes[name] = createHash("sha256").update(await readFile(full)).digest("hex");
  }
  return hashes;
}

/** Where a path changed, went missing, or turned up that was not there when it was frozen. */
function workspaceDiff(expected: Record<string, string>, actual: Record<string, string>): string[] {
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...names].filter((name) => expected[name] !== actual[name]).sort();
}

/** One call at a time per operation folder, across every HibernationStore in this process: src/server.ts
 *  builds a fresh store for each request, so the queue cannot live on the instance. */
const queues = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const mine = (queues.get(key) ?? Promise.resolve()).then(work);
  const settled = mine.catch(() => undefined);
  queues.set(key, settled);
  try {
    return await mine;
  } finally {
    if (queues.get(key) === settled) queues.delete(key);
  }
}

export class HibernationStore {
  constructor(private readonly dataDir: string) {}

  private root(): string { return resolve(this.dataDir, "hibernation"); }
  /** The operation's own folder, or OperationNotFoundError for an id that could name anything else. */
  private opDir(id: string): string {
    if (typeof id !== "string" || !operationId.test(id)) throw new OperationNotFoundError(String(id));
    const dir = resolve(this.root(), id);
    const inside = relative(this.root(), dir);
    if (inside !== id || isAbsolute(inside)) throw new OperationNotFoundError(id);
    return dir;
  }
  private manifestPath(id: string): string { return join(this.opDir(id), "manifest.json"); }
  workspacePath(id: string): string { return join(this.opDir(id), "workspace"); }

  private async writeManifest(id: string, record: OperationRecord): Promise<void> {
    await writeFile(this.manifestPath(id), JSON.stringify(record, null, 2), "utf8");
  }

  async read(id: string): Promise<OperationRecord> {
    const path = this.manifestPath(id);
    let record: OperationRecord;
    try {
      record = JSON.parse(await readFile(path, "utf8")) as OperationRecord;
    } catch {
      throw new OperationNotFoundError(id);
    }
    if (record?.id !== id) throw new OperationNotFoundError(id);
    return record;
  }

  /** Every operation on file, oldest id first. Used by `branch hibernation list` and by
   *  `GET /api/hibernation/operations` for any client that wants the same list; nothing is kept in
   *  memory between calls, so a fresh instance sees the same list. */
  async list(): Promise<OperationRecord[]> {
    let ids: string[];
    try {
      ids = (await readdir(this.root())).sort();
    } catch {
      return [];
    }
    const records: OperationRecord[] = [];
    for (const id of ids) {
      try { records.push(await this.read(id)); } catch { /* not an operation folder */ }
    }
    return records;
  }

  /** Starts a new operation in the configured environment, with its work laid out as named steps. */
  async start(environment: string, steps: string[]): Promise<OperationRecord> {
    const id = randomUUID();
    await mkdir(this.workspacePath(id), { recursive: true });
    const record: OperationRecord = { id, environment, steps, step: 0, status: "running", hashes: {} };
    await this.writeManifest(id, record);
    return record;
  }

  /** Runs the next step: writes its output into the workspace and moves the operation's checkpoint forward. */
  async advance(id: string): Promise<OperationRecord> {
    return oneAtATime(this.opDir(id), async () => {
      const record = await this.read(id);
      if (record.status !== "running") throw new OperationStateError("Only a running operation can be advanced.");
      const label = record.steps[record.step];
      if (label !== undefined) {
        await writeFile(join(this.workspacePath(id), `step-${record.step}.txt`), label, "utf8");
        record.step += 1;
      }
      if (record.step >= record.steps.length) record.status = "done";
      await this.writeManifest(id, record);
      return record;
    });
  }

  /** Suspends the operation's serverless compute: freezes the workspace's bytes and refuses further steps
   *  until it is resumed. */
  async suspend(id: string): Promise<OperationRecord> {
    return oneAtATime(this.opDir(id), async () => {
      const record = await this.read(id);
      if (record.status !== "running") throw new OperationStateError("Only a running operation can be suspended.");
      record.hashes = await hashWorkspace(this.workspacePath(id));
      record.status = "suspended";
      await this.writeManifest(id, record);
      return record;
    });
  }

  /** Resumes a suspended operation: checks the workspace against the bytes frozen at suspend, then
   *  continues from the saved step — never from the start. A changed workspace is refused and the
   *  operation stays suspended, unless the owner said to continue anyway (`acceptChanges`). */
  async resume(id: string, options: { acceptChanges?: boolean } = {}): Promise<{ record: OperationRecord; workspace: WorkspaceCheck }> {
    return oneAtATime(this.opDir(id), async () => {
      const record = await this.read(id);
      if (record.status !== "suspended") throw new OperationStateError("Only a suspended operation can be resumed.");
      const changed = workspaceDiff(record.hashes, await hashWorkspace(this.workspacePath(id)));
      if (changed.length && !options.acceptChanges) throw new WorkspaceChangedError(changed);
      record.status = "running";
      await this.writeManifest(id, record);
      return { record, workspace: changed.length ? { intact: false, changed } : { intact: true } };
    });
  }
}
