import { rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  fingerprintTree, type ActivationEntry, type ActivationJournal, type DatabaseChange, type Fingerprint,
} from "./activation.js";
import { databaseName } from "../install/layout.js";

/**
 * Going back to the version before an update — and refusing to, in plain words, whenever going back
 * would cost the owner something.
 *
 * The rule is the one the format stamp already states: a version can only open data whose
 * `readableBy` it understands. The activation journal wrote down what the older version understood
 * while that version was still the one running, so this can be answered exactly rather than guessed.
 * If the saved work has since been moved to a shape that version cannot read, the undo **refuses**
 * and says what to do instead — it never restores an old program on top of new data, and it never
 * half-undoes. The same holds for the files: if the program on the disk is not the one this entry
 * activated, or the kept previous version is not the one it kept, the undo refuses rather than put
 * back something nobody checked. See the re-audit's A2 and docs/never-break.md.
 */

export type RefusalReason =
  | "no-activation"
  | "already-undone"
  | "in-progress"
  | "previous-missing"
  | "previous-changed"
  | "program-changed"
  | "unverifiable"
  | "state-migrated-no-rollback"
  | "state-moved-since";

export interface RollbackRefusal {
  ok: false;
  reason: RefusalReason;
  /** What happened and what the person can do instead, in words they can act on. */
  message: string;
}

export interface RollbackPlan {
  ok: true;
  entry: ActivationEntry;
  /** What happens to the saved work: nothing, or these format changes taken back down. */
  data: { action: "leave-alone"; why: string } | { action: "take-down"; to: number; changes: number[] };
  /** What the person is told before it starts. */
  message: string;
}

export type RollbackDecision = RollbackPlan | RollbackRefusal;

/** What is true on the disk right now, gathered before the gate decides. */
export interface RollbackObservation {
  /** The installed program as it stands. Null when it is not there at all. */
  current: Fingerprint | null;
  /** The kept previous version (`<target>.previous`). Null when it is not there. */
  previous: Fingerprint | null;
  /** The saved work's format as it stands, or null when there is no saved work yet. */
  store: { version: number; readableBy: number } | null;
  /** The newest format change this running copy knows, so it can say whether it could take the data back down. */
  runnerKnows: number;
}

const backupAdvice = (entry: ActivationEntry): string =>
  entry.backups.length
    ? ` The safety copy taken before the update is at ${entry.backups[entry.backups.length - 1]}, and \`branch restore\` puts it back.`
    : " No safety copy of the work before the update was found, so there is nothing to restore from here.";

const forwardAdvice = (entry: ActivationEntry): string =>
  ` You can keep going forward on version ${entry.toVersion}, restore a safety copy onto the older version, or ask for help — nothing has been changed.`;

/** The store's record in an activation entry, by the name the data folder uses. */
export function storeChange(entry: ActivationEntry): DatabaseChange | null {
  return entry.databases.find((one) => one.name === databaseName) ?? null;
}

/**
 * Whether the older version could still open the saved work as it stands. This is the same test
 * `migrate()` makes before it throws `DataTooNewError`, asked from the outside: a version can read
 * data whose `readableBy` is no newer than the newest format that version knows.
 */
export function olderVersionCanRead(store: { readableBy: number } | null, understood: number): boolean {
  return store === null || store.readableBy <= understood;
}

/**
 * The gate. Pure: it is given the entry and what is on the disk and answers either a plan or a
 * refusal with a sentence. Nothing is touched here.
 */
export function assessRollback(entry: ActivationEntry | null, observed: RollbackObservation): RollbackDecision {
  if (!entry) return { ok: false, reason: "no-activation",
    message: "There is no record of an update to go back from, so Branch does not know what it would be undoing and will not guess. If an update did go wrong, restore a safety copy from the Updates screen, or ask for help." };
  if (entry.state === "rolled-back" || entry.state === "superseded" || entry.state === "failed")
    return { ok: false, reason: "already-undone",
      message: `The update from version ${entry.fromVersion} to ${entry.toVersion} has already been dealt with (${entry.state.replace("-", " ")}), so there is nothing here to undo.` };
  if (entry.state === "rolling-back")
    return { ok: false, reason: "in-progress",
      message: `Another copy of Branch (${entry.claimedBy ?? "unknown"}) is already putting version ${entry.fromVersion} back. Wait for it to finish rather than running two at once; if nothing is happening, start Branch again and it will tidy up what was left.` };

  /* ---- the files ---- */
  if (!observed.previous) return { ok: false, reason: "previous-missing",
    message: `Version ${entry.fromVersion} is not kept beside the installed program any more, so there is nothing to put back.${backupAdvice(entry)} Installing ${entry.fromVersion} again from its release page and then restoring that copy is the way back.` };
  // Either walk can have run out of its budget: the one taken now, or the one taken when the update
  // was recorded. A digest over half a folder is not a fingerprint, and comparing two of them would
  // tell the owner their files had been tampered with when all that happened is that a busy disk ran
  // the check out of time. Both fall here.
  if (observed.previous.partial || observed.current?.partial || entry.previous?.partial || entry.candidate?.partial)
    return { ok: false, reason: "unverifiable",
      message: `Branch could not finish checking that the kept copy of version ${entry.fromVersion} is exactly the one it put aside — one of the checks ran out of time, which usually means a slow or busy disk. It will not put back a version it has not checked.${forwardAdvice(entry)} Try again when the disk is quiet.` };
  if (entry.previous && observed.previous.digest !== entry.previous.digest)
    return { ok: false, reason: "previous-changed",
      message: `The kept copy of version ${entry.fromVersion} is not the one this update put aside — its files have changed since. Branch will not put back a version it cannot vouch for.${forwardAdvice(entry)} Download version ${entry.fromVersion} again from its release page if you want it back.` };
  if (!observed.current) return { ok: false, reason: "program-changed",
    message: `The installed program is not where the update left it, so Branch cannot tell what is there now and will not move anything.${forwardAdvice(entry)} Start Branch again first: it puts a half-finished update back together by itself.` };
  if (entry.candidate && observed.current.digest !== entry.candidate.digest)
    return { ok: false, reason: "program-changed",
      message: `The installed program is not the version ${entry.toVersion} this update put there — its files have changed since (another update, a reinstall, or something editing them). Undoing an update that is no longer the one installed could leave two versions mixed together, so Branch has stopped.${forwardAdvice(entry)}` };
  // Where the file system keeps each folder is recorded but deliberately not compared: the hand-over
  // moves the old version aside on macOS and Linux but mirrors it on Windows, and the new version is
  // always a fresh copy of the download, so a changed place is normal on some systems and proves
  // nothing on any of them. The tree digest is the check, and it is the stronger one.

  /* ---- the saved work ---- */
  const change = storeChange(entry);
  // First: does what is on the disk still match what was written down? A record that does not
  // describe the data in front of it cannot be used to undo anything, whichever way it points.
  if (change && observed.store && observed.store.version !== change.after.version)
    return { ok: false, reason: "state-moved-since",
      message: `Your saved work has moved on since this update: it was in format ${change.after.version} when version ${entry.toVersion} was installed and it is in format ${observed.store.version} now, so the record of what to undo no longer matches what is on the disk. Branch will not undo changes it did not write down.${backupAdvice(entry)} Staying on version ${entry.toVersion} keeps everything you have.` };
  if (change && !observed.store)
    return { ok: false, reason: "state-moved-since",
      message: `This update recorded saved work in format ${change.after.version}, and there is none there now, so the record no longer matches what is on the disk. Branch will not move a program version on the strength of a record it cannot check.${backupAdvice(entry)}` };
  // Then: can the older version read the data as it stands? This is the same test `migrate()` makes
  // before it refuses, asked ahead of time — and the older version's reach was written down while
  // that version was still running, so it is known rather than guessed.
  if (olderVersionCanRead(observed.store, entry.understood)) {
    return { ok: true, entry, data: { action: "leave-alone",
      why: observed.store === null
        ? "there is no saved work to change"
        : `your work is in format ${observed.store.version}, which version ${entry.fromVersion} can still read` },
      message: plainPlan(entry, "your conversations, settings and memory are left exactly as they are") };
  }
  // The data is in a shape the older version refuses. The only way back is to run the exact format
  // changes this update made backwards — and only when they were written down, this copy knows them,
  // and the update kept the work as it was before them, so nothing the newer version added is lost
  // without a copy of it to go to.
  if (!change || change.ran.length === 0)
    return { ok: false, reason: "state-migrated-no-rollback",
      message: `Your saved work is now in a format (${observed.store!.version}) that version ${entry.fromVersion} cannot read, and there is no record of which changes took it there, so Branch does not know how to take it back. Putting ${entry.fromVersion} back would leave it unable to open your conversations, so it has not been done.${backupAdvice(entry)} Staying on version ${entry.toVersion} keeps everything you have.` };
  if (observed.runnerKnows < change.after.version)
    return { ok: false, reason: "state-migrated-no-rollback",
      message: `Your saved work is in format ${observed.store!.version}, which this copy of Branch does not know how to take back down, so it cannot undo the update without risking your conversations.${backupAdvice(entry)} Staying on version ${entry.toVersion} keeps everything you have.` };
  if (change.before.readableBy > entry.understood)
    return { ok: false, reason: "state-migrated-no-rollback",
      message: `Even before this update, your saved work was in a format version ${entry.fromVersion} could not read, so there is no shape of it for ${entry.fromVersion} to open.${backupAdvice(entry)} Staying on version ${entry.toVersion} keeps everything you have.` };
  if (!change.backup)
    return { ok: false, reason: "state-migrated-no-rollback",
      message: `Your saved work was changed into a shape version ${entry.fromVersion} cannot read (format ${observed.store!.version}), and no copy of it as it was before that change was kept. Taking the change back out would throw away whatever version ${entry.toVersion} has written since, with nothing to go back to, so Branch has not done it.${backupAdvice(entry)} Staying on version ${entry.toVersion} keeps everything you have.` };
  return { ok: true, entry, data: { action: "take-down", to: change.before.version, changes: [...change.ran].reverse() },
    message: plainPlan(entry, `the ${change.ran.length} format change${change.ran.length === 1 ? "" : "s"} version ${entry.toVersion} made to your work will be taken back out — anything it has written in the new shape since goes with them, and your work as it was before the update is kept at ${change.backup}`) };
}

function plainPlan(entry: ActivationEntry, dataWords: string): string {
  return `Going back to version ${entry.fromVersion}: the copy kept beside the installed program is put back, ${dataWords}, and Branch starts again on ${entry.fromVersion}. Version ${entry.toVersion} is kept beside it in case you want it again.`;
}

/* ---------- gathering what is on the disk ---------- */

export interface ObserveDeps {
  /** How long each fingerprint may take. Past it the rollback refuses rather than proceed unchecked. */
  budgetMs?: number;
  fingerprint?: (root: string, budgetMs: number) => Promise<Fingerprint | null>;
  /** The saved work's format, read without holding the database open. */
  storeFormat?: () => Promise<{ version: number; readableBy: number } | null>;
  runnerKnows: number;
}

export async function observeForRollback(entry: ActivationEntry, deps: ObserveDeps): Promise<RollbackObservation> {
  const budgetMs = deps.budgetMs ?? 20_000;
  const take = deps.fingerprint ?? ((root, ms) => fingerprintTree(root, { budgetMs: ms }));
  const [current, previous, store] = await Promise.all([
    take(entry.target, budgetMs),
    take(`${entry.target}.previous`, budgetMs),
    deps.storeFormat ? deps.storeFormat().catch(() => null) : Promise.resolve(null),
  ]);
  return { current, previous, store, runnerKnows: deps.runnerKnows };
}

/* ---------- putting the files back ---------- */

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/**
 * The swap, in the order the hand-over script uses so that an interruption leaves one of the same
 * few shapes whichever ran it (`src/desktop/hand-over.ts`, `posixRollbackScript`): the failed
 * version is moved aside, the kept one takes its place, and the one before that moves up.
 *
 * `stopAfter` is for the torture tests: the swap stops after that many moves, acting out a machine
 * losing power part-way through.
 */
export async function rollbackSwap(target: string, stopAfter = Number.POSITIVE_INFINITY): Promise<string[]> {
  const previous = `${target}.previous`, failed = `${target}.failed`, spare = `${target}.previous-2`;
  const done: string[] = [];
  const step = async (what: string, work: () => Promise<void>): Promise<boolean> => {
    if (done.length >= stopAfter) return false;
    await work();
    done.push(what);
    return true;
  };
  if (!(await step("cleared the old failed copy", () => rm(failed, { recursive: true, force: true })))) return done;
  if (await exists(target)) {
    if (!(await step(`moved version aside as ${failed}`, () => rename(target, failed)))) return done;
  } else done.push("there was nothing where the program should be");
  if (!(await step("put the kept version back", () => rename(previous, target)))) return done;
  if (await exists(spare)) await step("promoted the spare kept version", () => rename(spare, previous));
  return done;
}

/**
 * A rollback cut off part-way leaves the program folder in one of a few shapes; this puts it back to
 * one whole version and says what it did. It is shape-based on purpose, so it works even when the
 * activation journal itself was lost. `repairSwap` in canary.ts calls it on every start.
 */
export async function repairRollback(target: string): Promise<string[]> {
  const previous = `${target}.previous`, failed = `${target}.failed`, spare = `${target}.previous-2`;
  const done: string[] = [];
  /** The spare kept version moves up whenever the one above it is gone, so no gap is left behind. */
  const promoteSpare = async (): Promise<void> => {
    if ((await exists(spare)) && !(await exists(previous))) await rename(spare, previous).catch(() => undefined);
  };
  if (await exists(target)) { await promoteSpare(); return done; }
  if (await exists(previous)) {
    await rename(previous, target);
    done.push("Going back to the previous version had stopped half-way; the previous version is now in place.");
    await promoteSpare();
    return done;
  }
  if (await exists(failed)) {
    await rename(failed, target);
    done.push("Going back to the previous version could not be finished, so the version that was there has been put back. Nothing of your work was changed.");
  }
  return done;
}

/* ---------- doing it ---------- */

export interface RollbackDeps {
  journal: ActivationJournal;
  /** Names this process in the journal so two copies at once are told apart. */
  by: string;
  observe: (entry: ActivationEntry) => Promise<RollbackObservation>;
  /** Takes the saved work's format changes back down, after taking a copy. Only called for a `take-down` plan. */
  takeDown?: (to: number) => Promise<{ backup: string | null }>;
  /** Stops and starts the gateway around the swap, so nothing holds the program's files. */
  stop?: () => Promise<void>;
  restart?: () => Promise<void>;
  /** Only for the torture tests: stops the swap after this many moves. */
  stopAfter?: number;
  swap?: (target: string, stopAfter?: number) => Promise<string[]>;
}

export interface RollbackReport {
  ok: boolean;
  reason: RefusalReason | null;
  /** What to tell the person, whichever way it went. */
  message: string;
  /** Every step that was attempted and how it went, so a partial rollback still reports. */
  steps: { step: string; ok: boolean; detail: string }[];
}

/**
 * Puts the previous version back when it is safe, and refuses in plain words when it is not. Every
 * step is written to the ledger before it is attempted, and a step that fails does not stop the ones
 * that can still be done: a rollback that only got part of the way says exactly how far it got
 * rather than pretending either way.
 */
export async function performRollback(entry: ActivationEntry | null, deps: RollbackDeps): Promise<RollbackReport> {
  const steps: RollbackReport["steps"] = [];
  const note = (id: number | null, step: string, ok: boolean, detail: string): void => {
    steps.push({ step, ok, detail });
    if (id !== null) deps.journal.step(id, step, ok, detail);
  };
  if (!entry) {
    const refusal = assessRollback(null, { current: null, previous: null, store: null, runnerKnows: 0 }) as RollbackRefusal;
    return { ok: false, reason: refusal.reason, message: refusal.message, steps };
  }
  const observed = await deps.observe(entry);
  const decision = assessRollback(entry, observed);
  if (!decision.ok) {
    note(entry.id, "checked whether going back is safe", false, `refused: ${decision.reason}`);
    return { ok: false, reason: decision.reason, message: decision.message, steps };
  }
  if (!deps.journal.claim(entry.id, deps.by)) {
    const again = deps.journal.entry(entry.id);
    const refusal = assessRollback(again, observed);
    const message = refusal.ok
      ? "Another copy of Branch took this one on first, so nothing was done here."
      : refusal.message;
    note(entry.id, "took the undo", false, "another copy of Branch holds it");
    return { ok: false, reason: refusal.ok ? "in-progress" : refusal.reason, message, steps };
  }
  note(entry.id, "checked whether going back is safe", true, decision.message);
  let failures = 0;
  // Everything below is attempted even when an earlier step failed, so the report is complete.
  // Closing Branch first is a precondition, not a step to be collected: the swap must never run
  // under a live Branch holding the program's files open. A stop that would not happen stops the
  // undo outright, with nothing touched, exactly as the update does.
  if (deps.stop) {
    try { await deps.stop(); note(entry.id, "closed the running Branch", true, "nothing is holding the program's files"); }
    catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      note(entry.id, "closed the running Branch", false, why);
      deps.journal.release(entry.id);
      return { ok: false, reason: null, steps,
        message: `${why} Nothing was changed; going back to version ${entry.fromVersion} can be tried again once Branch has closed.` };
    }
  }
  // Set once the saved work has been moved back a format, so a swap that then fails says so.
  let tookDown: { backup: string | null } | null = null;
  if (decision.data.action === "take-down" && deps.takeDown) {
    try {
      const { backup } = await deps.takeDown(decision.data.to);
      tookDown = { backup };
      note(entry.id, "took the format changes back out of your work", true, `back to format ${decision.data.to}${backup ? `, copy at ${backup}` : ""}`);
    } catch (error) {
      // The data could not be taken back: putting an older program on top of it is the thing this
      // whole gate exists to prevent, so the undo stops here and the entry is handed back.
      failures += 1;
      const why = error instanceof Error ? error.message : String(error);
      note(entry.id, "took the format changes back out of your work", false, why);
      deps.journal.release(entry.id);
      return { ok: false, reason: "state-migrated-no-rollback", steps,
        message: `Your work could not be put back into the format version ${entry.fromVersion} reads (${why}), so the older version was **not** put back — it would not have been able to open your conversations. Nothing on the disk was changed.${backupAdvice(entry)} Staying on version ${entry.toVersion} keeps everything you have.` };
    }
  } else if (decision.data.action === "leave-alone") {
    note(entry.id, "left your work alone", true, decision.data.why);
  }
  let moved: string[] = [];
  try {
    moved = await (deps.swap ?? rollbackSwap)(entry.target, deps.stopAfter);
    note(entry.id, "put version back", true, moved.join("; "));
  } catch (error) {
    failures += 1;
    const why = error instanceof Error ? error.message : String(error);
    note(entry.id, "put version back", false, why);
    const repaired = await repairRollback(entry.target).catch(() => [] as string[]);
    for (const line of repaired) note(entry.id, "tidied up", true, line);
    deps.journal.release(entry.id);
    return { ok: false, reason: null, steps,
      message: `Version ${entry.fromVersion} could not be put back (${why}). ${repaired.length ? repaired.join(" ") : "The program folder was left as it was."} ${dataAfterFailedSwap(entry, tookDown)}${forwardAdvice(entry)}` };
  }
  deps.journal.rolledBack(entry.id);
  if (deps.restart) {
    try { await deps.restart(); note(entry.id, "started Branch again", true, `on version ${entry.fromVersion}`); }
    catch (error) {
      // Being back on the older files while nothing runs them is not being back. Saying so here is the
      // difference between the owner reading "Branch is back" and the owner knowing to start it.
      const why = error instanceof Error ? error.message : String(error);
      note(entry.id, "started Branch again", false, why);
      return { ok: false, reason: null, steps,
        message: `Version ${entry.fromVersion} is back in place, but Branch could not be started again (${why}). `
          + "Start it with `branch start`; nothing else was left half done." };
    }
  }
  const dataWords = decision.data.action === "leave-alone"
    ? "Your conversations, settings and memory are exactly as they were."
    : `Your work was put back into the format version ${entry.fromVersion} reads, after a copy was taken.`;
  const tail = failures
    ? ` ${failures} step${failures === 1 ? "" : "s"} did not go through; what was tried is listed above and in the update log.`
    : "";
  return { ok: true, reason: null, steps,
    message: `Branch is back on version ${entry.fromVersion}. ${dataWords} Version ${entry.toVersion} is kept beside it as \`${entry.target.split(/[\\/]/).pop()}.failed\` in case you want to try it again.${tail}` };
}

/**
 * What a rollback whose swap failed did to the saved work. When the format changes had already been
 * taken out, saying "not changed" would be false: version `toVersion` is still installed and moves
 * the work forward again the next time it starts, from the copy-free data it finds.
 */
function dataAfterFailedSwap(entry: ActivationEntry, tookDown: { backup: string | null } | null): string {
  if (!tookDown) return "Your conversations, settings and memory were not changed.";
  const copy = tookDown.backup ? ` A copy taken before that is at ${tookDown.backup}.` : "";
  return `Your work had already been put back into the format version ${entry.fromVersion} reads; version ${entry.toVersion}, `
    + `which is still the one installed, moves it forward again the next time it starts.${copy}`;
}

/** The format of the saved work, read from a database the caller already holds open. */
export function storeFormatFrom(db: DatabaseSync, formatOf: (db: DatabaseSync) => { version: number; readableBy: number }): { version: number; readableBy: number } {
  return formatOf(db);
}

/** Where the update log for a data folder lives, for pointing a person at it. */
export const rollbackLogPath = (dataDir: string): string => join(dataDir, "updates", "roll-back.log");
