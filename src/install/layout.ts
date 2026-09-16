import { cp, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where the app keeps its files. Normally that is the per-user application-data folder Windows gives
 * every program. Put a file called `portable.txt` next to the executable and the app keeps everything
 * in a `Branch Data` folder beside itself instead, so the whole thing travels on a memory stick.
 */
export const portableMarker = "portable.txt";
export const portableFolder = "Branch Data";
/** The one file that proves a folder holds a real installation's saved work. */
export const databaseName = "branch.sqlite";

export interface DataLocation {
  /** Folder for the database, the device key and other saved state. */
  dataDir: string;
  /** Folder the assistant is allowed to read and write files in. */
  workspace: string;
  portable: boolean;
}

export function portableLocation(executableDir: string): DataLocation {
  const base = join(executableDir, portableFolder);
  return { dataDir: join(base, "state"), workspace: join(base, "workspace"), portable: true };
}
export function installedLocation(userDataDir: string): DataLocation {
  return { dataDir: join(userDataDir, "state"), workspace: join(userDataDir, "workspace"), portable: false };
}

export type Exists = (path: string) => Promise<boolean>;
export const pathExists: Exists = (path) => stat(path).then(() => true, () => false);

/** Portable mode wins when the marker file is beside the executable. */
export async function resolveDataLocation(
  executableDir: string, userDataDir: string, exists: Exists = pathExists,
): Promise<DataLocation> {
  return (await exists(join(executableDir, portableMarker)))
    ? portableLocation(executableDir)
    : installedLocation(userDataDir);
}

/**
 * Folders older versions used before the app moved to `%LOCALAPPDATA%\Programs\Branch Agent`.
 * Ordered newest-first so the most recent one wins when several are present.
 */
export function legacyDataDirs(env: NodeJS.ProcessEnv): string[] {
  const local = env.LOCALAPPDATA, roaming = env.APPDATA;
  const candidates = [
    local && join(local, "Branch Agent", "state"),
    local && join(local, "branch-agent", "state"),
    roaming && join(roaming, "Branch Agent", "state"),
    roaming && join(roaming, "branch-agent", "state"),
  ];
  return candidates.filter((path): path is string => typeof path === "string");
}

async function holdsWork(dir: string): Promise<boolean> {
  return stat(join(dir, databaseName)).then((s) => s.isFile() && s.size > 0, () => false);
}

export interface MigrationReport {
  /** The folder the files came from, or null when nothing needed moving. */
  from: string | null;
  to: string;
  reason: "copied" | "already-set-up" | "nothing-to-move";
}

/**
 * Copies saved work from an older folder layout into the new one, once. It never overwrites: if the
 * new folder already holds a database, the old copy is left untouched so nothing can be lost.
 */
export async function migrateLegacyData(
  candidates: string[], target: string, copy: typeof cp = cp,
): Promise<MigrationReport> {
  if (await holdsWork(target)) return { from: null, to: target, reason: "already-set-up" };
  for (const candidate of candidates) {
    if (candidate === target || !(await holdsWork(candidate))) continue;
    await copy(candidate, target, { recursive: true, force: false, errorOnExist: false });
    return { from: candidate, to: target, reason: "copied" };
  }
  return { from: null, to: target, reason: "nothing-to-move" };
}

/** True when a folder exists and contains at least one entry. */
export async function hasContents(dir: string): Promise<boolean> {
  return readdir(dir).then((entries) => entries.length > 0, () => false);
}
