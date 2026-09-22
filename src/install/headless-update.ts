import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updater, type UpdaterOptions } from "../desktop/updater.js";
import { appEntryName, releaseAssetName } from "../desktop/release-assets.js";
import { snapshotData, updateCanary } from "../never-break/canary.js";
import {
  activationJournalName, databaseFormat, fingerprintTree, openActivationJournal, type ActivationRecord,
} from "../never-break/activation.js";
import { assertFormatReadable, dataOpenError, storeMigrations } from "../never-break/migrations.js";
import { Store } from "../store.js";
import { requestUpdateBackup } from "./background-engine.js";
import { databaseName } from "./layout.js";
import { drainRunning, quitRunning, runningNow, undrainRunning, type QuitReport } from "./quit.js";
import { sessionTokenFileName, type RunningInstance } from "./running.js";
import { writeUpdateBackup } from "./update-backup.js";
import { restartService, waitForReturn, type ReturnDeps } from "./service-return.js";
import { launchInstalled, rollbackCommand } from "./rollback-cli.js";

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
  /** Asks the running Branch to finish what it is doing first (src/install/quit.ts `drainRunning`). */
  drain?: (dataDir: string) => Promise<unknown>;
  undrain?: (dataDir: string) => Promise<void>;
  /** Starts the background service again through its manager (launchctl, systemctl, the scheduled task). */
  restartService?: () => Promise<void>;
  /** How long, and how, to wait for the new version to say it is running. */
  returnWait?: ReturnDeps;
  /** Opens the installed app again (a window Branch closed for an update that then stopped). */
  launchApp?: (target: string, executableName: string) => void;
  /** Goes back to the version before; answers with an exit code. */
  rollback?: (restart: () => Promise<void>) => Promise<number>;
}

/** The safety copies this data folder holds, newest last, so a refusal can name one. */
async function backupPaths(dataDir: string): Promise<string[]> {
  const { listUpdateBackups } = await import("./update-backup.js");
  return listUpdateBackups(dataDir).then((points) => points.map((one) => one.path).reverse(), () => []);
}

async function engineCall(dataDir: string, note: RunningInstance, path: string): Promise<Response> {
  const token = (await readFile(join(dataDir, sessionTokenFileName), "utf8")).trim();
  return fetch(`${note.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}", signal: AbortSignal.timeout(180000) });
}

/**
 * Opens the saved work directly, for when nothing is running that holds it. mac7/install-torture:
 * the format is read first, so an older `branch update --yes` run against work a newer Branch saved
 * refuses while that work is still untouched — the store's own opening rewrites tasks that were
 * running, throws temporary sessions away and adds columns, all before anything could refuse.
 */
async function withStore<T>(dataDir: string, use: (store: Store) => Promise<T>): Promise<T> {
  const path = join(dataDir, databaseName);
  assertFormatReadable(path, storeMigrations);
  let store: Store;
  try { store = new Store(path); }
  catch (error) { throw dataOpenError(path, error); }
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

/**
 * mac7/safe-rollback: writes down what this update is about to change, before a single file moves.
 * The fingerprints are taken of the program that is there now (which the hand-over keeps as
 * `<target>.previous`) and of the unpacked version that will replace it, so an undo can tell whether
 * either has moved since. `understood` is read here, in the version that is still running, because
 * it is that version's reach that decides whether going back stays safe.
 *
 * It is written with the same rule as the task journal: a record that cannot be written stops the
 * update, because an update nobody can undo is not one worth making. The entry stays `staged` until
 * something has seen the swap land: `branch update --yes` sees the hand-over's exit code, and the
 * app's Update button, which quits into the script, leaves it to the next start (`settleActivation`).
 */
export async function recordActivation(input: {
  dataDir: string; installRoot: string; stagedDir: string; fromVersion: string; toVersion: string;
  executableName: string;
}): Promise<{ id: number; activated: () => void; failed: () => void; close: () => void }> {
  const { journal } = openActivationJournal(join(input.dataDir, activationJournalName));
  try {
    const [previous, candidate] = await Promise.all([
      fingerprintTree(input.installRoot).catch(() => null),
      fingerprintTree(input.stagedDir).catch(() => null),
    ]);
    let store: { version: number; readableBy: number } | null = null;
    if (existsSync(join(input.dataDir, databaseName)))
      store = await withStore(input.dataDir, async (opened) => databaseFormat(opened.sqlite)).catch(() => null);
    const record: ActivationRecord = {
      kind: "update", fromVersion: input.fromVersion, toVersion: input.toVersion, target: input.installRoot,
      previous, candidate, launcher: null, executableName: input.executableName,
      understood: storeMigrations.at(-1)?.version ?? 0,
      databases: store ? [{ name: databaseName, before: store, after: store, ran: [], backup: null }] : [],
      backups: await backupPaths(input.dataDir),
    };
    const id = journal.stage(record);
    return {
      id,
      activated: () => { try { journal.activated(id); } catch { /* the swap already happened; the record is best effort from here */ } },
      failed: () => { try { journal.failed(id); } catch { /* see above */ } },
      close: () => journal.close(),
    };
  } catch (error) { journal.close(); throw error; }
}

/** A process id that has already ended, so the hand-over script does not wait for anything. */
const endedPid = (): number => spawnSync("/bin/sh", ["-c", "exit 0"]).pid ?? 0;
const runSh = (script: string, args: string[]): number => spawnSync("/bin/sh", [script, ...args], { stdio: "ignore" }).status ?? 1;

/**
 * Branch was closed for this update: if it stops before the swap is done, Branch is started again as
 * it was, a background service through its manager and a window by opening the app.
 */
function reviveFor(input: HeadlessUpdateInput, note: RunningInstance | null, stopped: { report: QuitReport | null }): () => Promise<void> {
  const deps = input.deps ?? {}, platform = input.platform ?? process.platform;
  return async () => {
    if (!stopped.report?.wasRunning) return;
    if (note?.mode === "daemon") await (deps.restartService ?? (() => restartService(platform)))().catch(() => undefined);
    else (deps.launchApp ?? launchInstalled)(input.installRoot, appEntryName(platform));
  };
}
function makeUpdater(input: HeadlessUpdateInput, note: RunningInstance | null, stopped: { report: QuitReport | null }): Updater {
  const platform = input.platform ?? process.platform, deps = input.deps ?? {};
  const executableName = appEntryName(platform);
  return new Updater({
    repo: releaseRepo, currentVersion: input.version, installDir: input.installRoot, executableName,
    assetName: releaseAssetName(platform, input.arch ?? process.arch), packaged: true, platform,
    scratchDir: deps.scratchDir ?? join(tmpdir(), "branch-agent-update"),
    ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.extract ? { extract: deps.extract } : {}),
    backup: deps.backup ?? defaultBackup(input.dataDir, input.version, note, input.print),
    drain: () => (deps.drain ?? ((dir: string) => drainRunning(dir)))(input.dataDir),
    undrain: () => (deps.undrain ?? ((dir: string) => undrainRunning(dir)))(input.dataDir),
    revive: reviveFor(input, note, stopped),
    canary: updateCanary({ dataDir: input.dataDir, platform, executableName, fromVersion: input.version,
      target: input.installRoot, snapshot: deps.snapshot ?? defaultSnapshot(input.dataDir, note) }),
    stopDaemon: async () => {
      // A Branch that would not close stops the update below; it is never ended mid-work to make room.
      // A stop that fails outright counts as "would not close": the swap must never run under a live Branch.
      stopped.report = await (deps.quit ?? quitRunning)(input.dataDir).catch((error: unknown) => ({
        stopped: false, wasRunning: true, pid: null,
        message: `Branch Agent could not be closed (${error instanceof Error ? error.message : String(error)}).`,
      }));
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
  const { script, stagedDir } = await updater.install().catch((error: unknown) => {
    input.print(error instanceof Error ? error.message : String(error));
    return { script: null, stagedDir: "" };
  });
  if (!script) return 1;
  if (!stopped.report || !stopped.report.stopped) {
    // It was asked to finish its work for the update and then did not close: it gets its work back now.
    await (deps.undrain ?? ((dir: string) => undrainRunning(dir)))(input.dataDir).catch(() => undefined);
    input.print(`${stopped.report?.message ?? "Branch Agent was not closed."} Nothing was changed; the update can be run again once Branch has closed.`);
    return 1;
  }
  const revive = reviveFor(input, note, stopped);
  // mac7/safe-rollback: what this update changes is written down before anything moves.
  let activation: Awaited<ReturnType<typeof recordActivation>> | null = null;
  try {
    activation = await recordActivation({ dataDir: input.dataDir, installRoot: input.installRoot, stagedDir,
      fromVersion: input.version, toVersion: to, executableName: appEntryName(platform) });
  } catch (error) {
    await revive();
    input.print(`${error instanceof Error ? error.message : String(error)} Nothing was changed, and Branch was started again.`);
    return 1;
  }
  // The stop already happened (and was waited for) in the updater, so the script waits for nothing.
  const reopen = stopped.report?.wasRunning === true && note?.mode === "app";
  const code = (deps.runScript ?? runSh)(script, [String(stopped.report?.pid ?? endedPid()), ...(reopen ? [] : ["stay"])]);
  const log = join(deps.scratchDir ?? join(tmpdir(), "branch-agent-update"), "apply-update.log");
  if (code !== 0) {
    activation.failed();
    activation.close();
    // The hand-over put the version before back; a window it reopens itself, a service it leaves closed.
    if (note?.mode === "daemon") await revive();
    input.print(`The update did not finish, so Branch stays on the version it had. What happened is in ${log}.`);
    return 1;
  }
  activation.activated();
  activation.close();
  input.print(`Updated Branch Agent from ${input.version} to ${to}. The version before is kept beside it. Log: ${log}`);
  if (stopped.report?.wasRunning && note?.mode === "daemon") return serviceBack(input, stopped.report.pid, to, log);
  return 0;
}

/**
 * A Branch that was working in the background comes back by itself on the new version, and when it
 * does not come up the version before is put back and started instead: the owner is never left with
 * no Branch running.
 */
async function serviceBack(input: HeadlessUpdateInput, before: number | null, to: string, log: string): Promise<number> {
  const deps = input.deps ?? {}, platform = input.platform ?? process.platform;
  const restart = deps.restartService ?? (() => restartService(platform));
  const started = await restart().then(() => true, () => false);
  if (started && (await waitForReturn(input.dataDir, before, deps.returnWait))) {
    input.print(`Branch is working in the background again, on version ${to}.`);
    return 0;
  }
  input.print(`Version ${to} did not come back up in the background, so Branch is going back to the version it had. Log: ${log}`);
  const rollback = deps.rollback ?? ((again: () => Promise<void>) => rollbackCommand({
    dataDir: input.dataDir, version: to, yes: true, platform, print: input.print, deps: { restartService: again },
  }));
  const code = await rollback(restart).catch(() => 1);
  if (code !== 0) input.print("Going back did not finish either. Start Branch with `branch start`, or see what happened with `branch rollback`.");
  return 1;
}
