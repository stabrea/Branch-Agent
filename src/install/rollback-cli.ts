import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  activationJournalName, databaseFormat, openActivationJournal, type ActivationEntry, type ActivationJournal,
} from "../never-break/activation.js";
import { migrateDown, storeMigrations } from "../never-break/migrations.js";
import {
  assessRollback, observeForRollback, performRollback, type RollbackReport,
} from "../never-break/rollback.js";
import { Store } from "../store.js";
import { databaseName } from "./layout.js";
import { quitRunning, runningNow, type QuitDeps } from "./quit.js";
import { restartService, waitForReturn, type ReturnDeps } from "./service-return.js";
import type { RunningInstance } from "./running.js";

/**
 * `branch rollback` — going back to the version before the last update, and being told plainly when
 * that is not safe. Without `--yes` it only says what it would do, or why it will not; the refusal
 * is the same sentence either way, so nobody has to run it to find out. The decision itself is in
 * `src/never-break/rollback.ts`; this file is the plumbing round it.
 */

export interface RollbackCliInput {
  dataDir: string;
  /** The version running now, only used in what is printed. */
  version: string;
  yes: boolean;
  /** Which system this is for; defaults to this computer's. */
  platform?: NodeJS.Platform;
  print: (line: string) => void;
  deps?: RollbackCliDeps;
}
export interface RollbackCliDeps {
  quit?: QuitDeps;
  /** Starts the version that was put back; left out when nothing should be started. */
  launch?: (target: string, executableName: string) => void;
  /** Starts a background service again (it was one before the undo), through its own manager. */
  restartService?: () => Promise<void>;
  /** How long to wait for the version that was put back to answer, and what to ask; tests hold the clock. */
  returnWait?: ReturnDeps;
  /**
   * What was running before all of this began, when the caller knows and the disk no longer does. The
   * update's own recovery comes in here after the service has been closed and the new version failed to
   * come up: reading the disk then says "nothing was running", and the undo would put the files back and
   * start nothing.
   */
  wasRunning?: RunningInstance | null;
  /** Only for the torture tests: stops the swap after this many moves. */
  stopAfter?: number;
  budgetMs?: number;
}

/** The saved work's format, read and closed again so nothing holds the database open. */
function readStoreFormat(dataDir: string): { version: number; readableBy: number } | null {
  if (!existsSync(join(dataDir, databaseName))) return null;
  const store = new Store(join(dataDir, databaseName));
  try { return databaseFormat(store.sqlite); } finally { store.close(); }
}

/**
 * Takes the saved work back to the format the older version reads, after copying it. The copy is
 * kept, not cleaned up: if anything about the way back turns out to be wrong, that file is the way
 * to the work as the newer version left it.
 */
async function takeStoreDown(dataDir: string, to: number): Promise<{ backup: string | null }> {
  const path = join(dataDir, databaseName);
  const backup = join(dataDir, "update-backups", `before-going-back-${Date.now()}.sqlite`);
  const store = new Store(path);
  try {
    if (existsSync(backup)) await rm(backup, { force: true });
    store.sqlite.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    migrateDown(store.sqlite, storeMigrations, to);
    return { backup };
  } finally { store.close(); }
}

const launcher = (target: string, executableName: string): void => {
  const file = process.platform === "darwin" ? "/usr/bin/open" : join(target, executableName);
  const args = process.platform === "darwin" ? [target] : [];
  spawn(file, args, { detached: true, stdio: "ignore" }).unref();
};

/** How the on-disk facts are gathered, shared by the check and the real thing. */
const observer = (input: RollbackCliInput) => (entry: ActivationEntry) =>
  observeForRollback(entry, {
    runnerKnows: storeMigrations.at(-1)?.version ?? 0,
    ...(input.deps?.budgetMs === undefined ? {} : { budgetMs: input.deps.budgetMs }),
    storeFormat: async () => readStoreFormat(input.dataDir),
  });

/** Answers with an exit code: 0 only when it did what it says, or when a check found nothing wrong. */
export async function rollbackCommand(input: RollbackCliInput): Promise<number> {
  // The Windows swap is a mirror run by a batch file, not the moves this does; going back there is
  // the app's Updates screen, as installing is. Said plainly rather than half-attempted.
  if ((input.platform ?? process.platform) === "win32") {
    input.print("On Windows, go back to the previous version from the app: Settings, Updates. `branch rollback` works on macOS and Linux.");
    return 1;
  }
  const { journal, reset } = openActivationJournal(join(input.dataDir, activationJournalName));
  if (reset) input.print(reset);
  try {
    const entry = journal.current();
    if (!entry) {
      // Before refusing: an undo may have put the files back and failed only to start Branch again.
      // That is not "nothing to go back from" — it is one step short of done, and it is the step the
      // owner cannot do for themselves as a background service.
      const pending = startPending(journal);
      if (pending) return await startAgainOnly(pending, journal, input);
      const nothing = assessRollback(null, { current: null, previous: null, store: null, runnerKnows: 0 });
      input.print(nothing.ok ? "There is nothing to go back from." : nothing.message);
      return 1;
    }
    if (!input.yes) {
      const decision = assessRollback(entry, await observer(input)(entry));
      input.print(decision.ok ? `${decision.message}\n\nRun \`branch rollback --yes\` to do it.` : decision.message);
      return decision.ok ? 0 : 1;
    }
    const report = await runRollback(entry, journal, input);
    input.print(report.message);
    return report.ok ? 0 : 1;
  } finally { journal.close(); }
}

/**
 * A rollback that put the files back and then could not start Branch again. The swap is done and
 * written down, so running the whole undo a second time would be refused — the installed program is
 * no longer the version the record says it replaced — and it would be wrong anyway: the files need
 * nothing. What is left undone is the service, so that is the only thing this route does.
 *
 * It is read from the ledger rather than from a new state, because the state is not a lie: the files
 * really are back. What the ledger says is that the last thing the undo tried, and the only thing
 * still outstanding, is starting Branch again.
 */
export function startPending(journal: ActivationJournal): ActivationEntry | null {
  const [newest] = journal.recent(1);
  if (!newest || newest.state !== "rolled-back") return null;
  const starts = journal.ledger(newest.id).filter((line) => line.step === "started Branch again");
  const last = starts.at(-1);
  return last && !last.ok ? newest : null;
}

/**
 * Starts the service again for an undo that swapped the files and got no further, and waits for the
 * version that was put back to answer for itself. Nothing on disk is moved: the only thing this can
 * do is start Branch, and the only thing it reports is whether that worked.
 */
async function startAgainOnly(entry: ActivationEntry, journal: ActivationJournal, input: RollbackCliInput): Promise<number> {
  const deps = input.deps ?? {};
  if (!input.yes) {
    input.print(`Version ${entry.fromVersion} is already back in place; Branch was not started again. `
      + "Run `branch rollback --yes` to start it.");
    return 0;
  }
  const was = deps.wasRunning ?? await runningNow(input.dataDir, deps.quit?.alive);
  try {
    await (deps.restartService ?? (() => restartService(input.platform ?? process.platform)))();
    const back = await waitForReturn(input.dataDir, { pid: was?.pid ?? null, startedAt: was?.startedAt ?? null },
      { version: entry.fromVersion }, deps.returnWait);
    if (!back) throw new Error(`version ${entry.fromVersion} did not come back up in the background`);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    journal.step(entry.id, "started Branch again", false, why);
    input.print(`Version ${entry.fromVersion} is back in place, but Branch could not be started again (${why}). `
      + "Start it with `branch start`; nothing else was left half done.");
    return 1;
  }
  journal.step(entry.id, "started Branch again", true, `on version ${entry.fromVersion}`);
  input.print(`Branch is working in the background again, on version ${entry.fromVersion}.`);
  return 0;
}

async function runRollback(entry: ActivationEntry, journal: ActivationJournal, input: RollbackCliInput): Promise<RollbackReport> {
  const deps = input.deps ?? {};
  const was = deps.wasRunning ?? await runningNow(input.dataDir, deps.quit?.alive);
  const wasRunning = was !== null;
  return performRollback(entry, {
    journal, by: `${process.pid}@${process.platform}`,
    observe: observer(input),
    takeDown: (to) => takeStoreDown(input.dataDir, to),
    stop: async () => {
      const closed = await quitRunning(input.dataDir, deps.quit);
      // The swap must never run under a live Branch; a stop that would not happen stops the undo.
      if (!closed.stopped && closed.wasRunning) throw new Error(closed.message);
    },
    ...(deps.stopAfter === undefined ? {} : { stopAfter: deps.stopAfter }),
    restart: async () => {
      if (!wasRunning) return;
      // A background service comes back as the service, not as a window it never had.
      if (was.mode === "daemon") {
        await (deps.restartService ?? (() => restartService(input.platform ?? process.platform)))();
        // The service manager saying yes is not the older version running. It answers as soon as it
        // has been asked, whether or not anything came up, and an undo that reports success while
        // nothing is running is the one failure this whole path exists to prevent. So the same proof
        // the forward update already needs: a Branch that is not the one we just stopped, answering
        // for itself, and saying it is the version we put back.
        const back = await waitForReturn(input.dataDir, { pid: was.pid, startedAt: was.startedAt },
          { version: entry.fromVersion }, deps.returnWait);
        if (!back)
          throw new Error(`version ${entry.fromVersion} did not come back up in the background`);
        return;
      }
      (deps.launch ?? launcher)(entry.target, entry.executableName);
    },
  });
}
