import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { maximumBackupBytes } from "../backup.js";

/**
 * A safety copy taken just before an update swaps the program files. Three are kept, oldest thrown
 * away, so there is always something to go back to if a new version does not come up properly. Only
 * the person's own saved work is copied; secrets stay where they are, protected by this device's key.
 */
export const backupFolder = "update-backups";
export const keepBackups = 3;
const namePattern = /^before-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-v(.+)\.json$/;
/** The copies `migrate` takes before it changes the database's shape (see never-break/migrations.ts). */
const formatCopyPattern = /^before-format-(\d+)\.sqlite$/;

export function backupFileName(version: string, at: Date): string {
  const stamp = at.toISOString().replace(/\..*$/, "").replace(/:/g, "-");
  return `before-${stamp}-v${version.replace(/[^\w.-]/g, "")}.json`;
}
/** The safety copies to throw away: everything older than the newest `keep` of them. */
export function backupsToPrune(names: string[], keep = keepBackups, keepAlways?: string): string[] {
  const mine = names.filter((name) => namePattern.test(name) && name !== keepAlways).sort();
  // mac7/install-torture: a clock that jumped backwards names the newest copy with an old date, so
  // sorting alone would throw away the one just written. The caller's own copy is always kept.
  const room = Math.max(0, keep - (keepAlways && namePattern.test(keepAlways) ? 1 : 0));
  return mine.slice(0, Math.max(0, mine.length - room));
}

/**
 * The copies taken before a change to the database's shape. They are whole databases, so a machine
 * that keeps failing the same change would otherwise grow one per start, for ever.
 */
export function formatCopiesToPrune(names: string[], keep = keepBackups, keepAlways?: string): string[] {
  // merge-queue review: the copy just taken is the one an undo of this update points at
  // (activation.sqlite records it), and a clock that jumped backwards gives it the oldest name.
  const room = Math.max(0, keep - (keepAlways && formatCopyPattern.test(keepAlways) ? 1 : 0));
  const mine = names.filter((name) => formatCopyPattern.test(name) && name !== keepAlways)
    .sort((a, b) => Number(formatCopyPattern.exec(a)![1]) - Number(formatCopyPattern.exec(b)![1]));
  return mine.slice(0, Math.max(0, mine.length - room));
}

export interface RestorePoint { name: string; path: string; bytes: number; savedAt: string; version: string }

export async function listUpdateBackups(dataDir: string): Promise<RestorePoint[]> {
  const dir = join(dataDir, backupFolder);
  const names = await readdir(dir).catch(() => [] as string[]);
  const points: RestorePoint[] = [];
  for (const name of names.filter((entry) => namePattern.test(entry)).sort().reverse()) {
    const match = namePattern.exec(name)!;
    const size = await stat(join(dir, name)).then((s) => s.size, () => 0);
    points.push({
      name, path: join(dir, name), bytes: size, version: match[2]!,
      savedAt: match[1]!.replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3") + "Z",
    });
  }
  return points;
}

/** Writes the safety copy and removes the oldest ones beyond the three that are kept. */
export async function writeUpdateBackup(
  dataDir: string, archive: unknown, version: string, at = new Date(), keep = keepBackups,
): Promise<{ path: string; pruned: string[] }> {
  const dir = join(dataDir, backupFolder);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(archive);
  if (Buffer.byteLength(body) > maximumBackupBytes)
    throw new Error(`This copy holds more saved work than a safety copy can hold (${Math.round(maximumBackupBytes / 1048576)} MiB).`);
  const name = backupFileName(version, at);
  const path = join(dir, name);
  await writeFile(path, body, { mode: 0o600 });
  const here = await readdir(dir);
  const pruned = [...backupsToPrune(here, keep, name), ...formatCopiesToPrune(here, keep)];
  for (const entry of pruned) await rm(join(dir, entry), { force: true });
  return { path, pruned };
}

export async function readUpdateBackup(dataDir: string, name: string): Promise<unknown> {
  if (!namePattern.test(name)) throw new Error("That is not a safety copy this app made.");
  const path = join(dataDir, backupFolder, name);
  const body = await readFile(path, "utf8");
  if (Buffer.byteLength(body) > maximumBackupBytes) throw new Error("That safety copy is too large to read back.");
  return JSON.parse(body);
}

/**
 * Whether the version that is running now came up healthy the first time it started. The update
 * screen uses it to offer going back to the copy taken before the update.
 */
const CheckSchema = z.object({
  version: z.string().max(40),
  previousVersion: z.string().max(40).nullable(),
  healthy: z.boolean(),
  checkedAt: z.iso.datetime(),
}).strict();
export type FirstStartCheck = z.infer<typeof CheckSchema>;
const checkFile = (dataDir: string) => join(dataDir, "first-start.json");

export async function readFirstStart(dataDir: string): Promise<FirstStartCheck | null> {
  try { return CheckSchema.parse(JSON.parse(await readFile(checkFile(dataDir), "utf8"))); }
  catch { return null; }
}
/** Records how this version's first start went; later starts of the same version leave it alone. */
export async function recordFirstStart(
  dataDir: string, version: string, healthy: boolean, at = new Date(),
): Promise<FirstStartCheck> {
  const previous = await readFirstStart(dataDir);
  if (previous?.version === version) return previous;
  const value: FirstStartCheck = {
    version, previousVersion: previous?.version ?? null, healthy, checkedAt: at.toISOString(),
  };
  await writeFile(checkFile(dataDir), JSON.stringify(value), { mode: 0o600 });
  return value;
}
