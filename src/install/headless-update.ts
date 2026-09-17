import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updater, type UpdaterOptions } from "../desktop/updater.js";
import { appEntryName, releaseAssetName } from "../desktop/release-assets.js";
import { snapshotData, updateCanary } from "../never-break/canary.js";
import { Store } from "../store.js";
import { requestUpdateBackup } from "./background-engine.js";
import { databaseName } from "./layout.js";
import { quitRunning, runningNow, type QuitReport } from "./quit.js";
import { sessionTokenFileName, type RunningInstance } from "./running.js";
import { writeUpdateBackup } from "./update-backup.js";

/**
 * `branch update --yes`: the app's Update button without the window. It uses the same updater, so the
 * download is checked against its published checksum, the new version is tried on a copy of the
 * work when that switch is on, a safety copy is written first, and the same hand-over script swaps
 * the files and keeps the version before as `<name>.previous`, logging to the same file. Branch is
 * closed for the swap and opened again only if its window was open before.
 */

/** The same repository the app's Update button reads (`updateSource` in src/desktop/updater-ipc.ts). */
export const releaseRepo = "stabrea/Branch-Agent";

export interface HeadlessUpdateInput {
  installRoot: string;
  dataDir: string;
  version: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** False only checks and says what would happen. */
  yes: boolean;
  print: (line: string) => void;
  deps?: HeadlessUpdateDeps;
}
export interface HeadlessUpdateDeps {
  fetch?: typeof fetch;
  extract?: UpdaterOptions["extract"];
  scratchDir?: string;
  quit?: (dataDir: string) => Promise<QuitReport>;
  /** Runs the hand-over script and answers with its exit code. */
  runScript?: (script: string, args: string[]) => number;
  running?: (dataDir: string) => Promise<RunningInstance | null>;
  backup?: () => Promise<void>;
  snapshot?: () => Promise<string>;
}

async function engineCall(dataDir: string, note: RunningInstance, path: string): Promise<Response> {
  const token = (await readFile(join(dataDir, sessionTokenFileName), "utf8")).trim();
  return fetch(`${note.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}", signal: AbortSignal.timeout(180000) });
}

/** Opens the saved work directly, for when nothing is running that holds it. */
async function withStore<T>(dataDir: string, use: (store: Store) => Promise<T>): Promise<T> {
  const store = new Store(join(dataDir, databaseName));
  try { return await use(store); } finally { store.close(); }
}

/** The safety copy: asked of the running engine, or written here when nothing is running. */
function defaultBackup(dataDir: string, version: string, note: RunningInstance | null, print: (line: string) => void): () => Promise<void> {
  return async () => {
    if (note) {
      const token = (await readFile(join(dataDir, sessionTokenFileName), "utf8")).trim();
      return requestUpdateBackup(note.url, token);
    }
    if (!existsSync(join(dataDir, databaseName))) { print("There is no saved work yet, so no safety copy was needed."); return; }
    await withStore(dataDir, async (store) => { await writeUpdateBackup(dataDir, store.backup(version), version); });
  };
}

function defaultSnapshot(dataDir: string, note: RunningInstance | null): () => Promise<string> {
  return async () => {
    if (!note) return withStore(dataDir, (store) => snapshotData({ dataDir, database: store.sqlite }));
    const response = await engineCall(dataDir, note, "/api/never-break/snapshot");
    const body = await response.json().catch(() => null) as { folder?: unknown } | null;
    if (!response.ok || typeof body?.folder !== "string") throw new Error("The running Branch did not make a copy of your work.");
    return body.folder;
  };
}

/** A process id that has already ended, so the hand-over script does not wait for anything. */
const endedPid = (): number => spawnSync("/bin/sh", ["-c", "exit 0"]).pid ?? 0;
const runSh = (script: string, args: string[]): number => spawnSync("/bin/sh", [script, ...args], { stdio: "ignore" }).status ?? 1;

function makeUpdater(input: HeadlessUpdateInput, note: RunningInstance | null, stopped: { report: QuitReport | null }): Updater {
  const platform = input.platform ?? process.platform, deps = input.deps ?? {};
  const executableName = appEntryName(platform);
  return new Updater({
    repo: releaseRepo, currentVersion: input.version, installDir: input.installRoot, executableName,
    assetName: releaseAssetName(platform, input.arch ?? process.arch), packaged: true, platform,
    scratchDir: deps.scratchDir ?? join(tmpdir(), "branch-agent-update"),
    ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.extract ? { extract: deps.extract } : {}),
    backup: deps.backup ?? defaultBackup(input.dataDir, input.version, note, input.print),
    canary: updateCanary({ dataDir: input.dataDir, platform, executableName, fromVersion: input.version,
      target: input.installRoot, snapshot: deps.snapshot ?? defaultSnapshot(input.dataDir, note) }),
    stopDaemon: async () => {
      // A Branch that would not close stops the update below; it is never ended mid-work to make room.
      stopped.report = await (deps.quit ?? quitRunning)(input.dataDir);
      return stopped.report.stopped ? stopped.report.pid : null;
    },
  });
}

/** Checks, and with `yes` installs, the newest release. Answers with the exit code. */
export async function headlessUpdate(input: HeadlessUpdateInput): Promise<number> {
  const platform = input.platform ?? process.platform, deps = input.deps ?? {};
  if (platform === "win32") {
    input.print("On Windows, update from the app: Settings, Updates. `branch update --yes` works on macOS and Linux.");
    return 1;
  }
  const note = await (deps.running ?? runningNow)(input.dataDir);
  const stopped: { report: QuitReport | null } = { report: null };
  const updater = makeUpdater(input, note, stopped);
  const status = await updater.check();
  if (status.phase !== "available") { input.print(status.message); return status.phase === "current" ? 0 : 1; }
  const to = status.release!.latestVersion;
  if (!input.yes) { input.print(`Version ${to} is ready (you have ${input.version}). Run \`branch update --yes\` to install it.`); return 0; }
  input.print(`Updating Branch Agent from ${input.version} to ${to}...`);
  const { script } = await updater.install().catch((error: unknown) => {
    input.print(error instanceof Error ? error.message : String(error));
    return { script: null };
  });
  if (!script) return 1;
  if (stopped.report && !stopped.report.stopped) {
    input.print(`${stopped.report.message} Nothing was changed; the update can be run again once Branch has closed.`);
    return 1;
  }
  // The stop already happened (and was waited for) in the updater, so the script waits for nothing.
  const reopen = stopped.report?.wasRunning === true && note?.mode === "app";
  const code = (deps.runScript ?? runSh)(script, [String(stopped.report?.pid ?? endedPid()), ...(reopen ? [] : ["stay"])]);
  const log = join(deps.scratchDir ?? join(tmpdir(), "branch-agent-update"), "apply-update.log");
  if (code !== 0) { input.print(`The update did not finish, so Branch stays on the version it had. What happened is in ${log}.`); return 1; }
  input.print(`Updated Branch Agent from ${input.version} to ${to}. The version before is kept beside it. Log: ${log}`);
  if (stopped.report?.wasRunning && !reopen) input.print("Branch was working in the background; start it again with `branch start` or by signing in again.");
  return 0;
}
