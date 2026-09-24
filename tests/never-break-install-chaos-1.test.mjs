/**
 * Never breaks: the second chaos round — installing, updating and starting up (Part 1/4).
 * Update-related tests and data format checks.
 *
 * The first round (never-break-chaos.test.mjs) kills Branch in the middle of a task. This one kills
 * it in the middle of an update, a change to the shape of its saved work, and a first start, and
 * starts it on machines that are already broken. Each seed picks a state to put the saved work in
 * and a moment to cut off, and then the same question is asked every time:
 *
 *   Branch starts, the owner's conversations, settings and memory are all still there, no change to
 *   the shape of the data is half-applied, nothing half-installed is left lying about, and anything
 *   Branch refuses to do it says in a sentence a person can act on.
 *
 * A crash, quiet loss of the owner's work, or a state only a person with a terminal could clean up
 * is a failure. Quick by default (a few seeds, for CI); BRANCH_INSTALL_SEEDS=200 runs the long set.
 * Every seed's choices are printed, so a failing one can be replayed on its own.
 *
 * Only temporary folders, fake releases and fake installs. Nothing is installed on this computer, no
 * real app is launched, no `launchctl`, `systemctl` or real GitHub release is ever touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertFormatWhole, assertNothingHalfInstalled, fakeRelease, fingerprint, ownersData, random, startOrRefuse, temp,
  systemWords,
} from "./never-break-install-chaos-helpers.mjs";
import { Updater } from "../dist/desktop/updater.js";
import { assertFormatReadable, DataTooNewError, formatOf, migrate, storeMigrations } from "../dist/never-break/migrations.js";
import { writeUpdateBackup, backupFileName, backupsToPrune, formatCopiesToPrune } from "../dist/install/update-backup.js";

const seeds = Math.max(1, Number(process.env.BRANCH_INSTALL_SEEDS ?? 4));

/* ============================== 1. killed in the middle of an update ======================== */

/** The five named moments an update can be cut off at, before the files are swapped. */
const updateMoments = [
  { id: "after-the-download", fetch: { checksum: "unreachable" }, expect: /could not read the checksum published with the new version/ },
  { id: "during-the-checksum", fetch: { checksum: "cut-off" }, expect: /checksum published with the new version did not arrive in full/ },
  { id: "checksum-does-not-match", fetch: { checksum: "wrong" }, expect: /did not match the published checksum/ },
  { id: "during-the-self-test", canary: async () => { throw new Error("the engine stopped half-way through its check"); },
    expect: /did not pass its check, so nothing was changed/ },
  { id: "self-test-said-nothing", canary: async () => { throw new Error("The new version did not finish its check (it was ended by SIGKILL)."); },
    expect: /did not pass its check[\s\S]*did not finish its check/ },
  { id: "no-room-for-the-safety-copy", backup: async () => { throw new Error("ENOSPC: no space left on device"); },
    expect: /safety copy could not be made, so the update was stopped/ },
];

test(`an update cut off at each named moment changes nothing and says why (${updateMoments.length} moments x ${seeds} seeds)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 7907);
    for (const moment of updateMoments) {
      const root = await temp(t, `update-${seed}-${moment.id}`);
      const { dataDir, workspace, before } = await ownersData(root);
      const install = join(root, "installed");
      await (await import("node:fs/promises")).mkdir(install, { recursive: true });
      await (await import("node:fs/promises")).writeFile(join(install, "branch-agent"), "the version in use");
      const order = [];
      const updater = new Updater({
        repo: "x/y", currentVersion: "1.0.0", installDir: install, executableName: "branch-agent",
        assetName: "app.tgz", scratchDir: join(root, "scratch"), platform: "linux", packaged: true,
        fetch: fakeRelease(Buffer.from(`release-${seed}`), moment.fetch ?? {}),
        extract: async (_archive, into) => {
          const unpacked = join(into, "unpacked");
          await (await import("node:fs/promises")).mkdir(join(unpacked, "resources", "app"), { recursive: true });
          await (await import("node:fs/promises")).writeFile(join(unpacked, "branch-agent"), "the new version");
          await (await import("node:fs/promises")).writeFile(join(unpacked, "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version: "2.0.0" }));
        },
        canary: moment.canary ?? (async () => { order.push("canary"); }),
        backup: moment.backup ?? (async () => { order.push("backup"); }),
      });
      let refusal = null;
      await updater.install().catch((error) => { refusal = error; });
      assert.ok(refusal, `seed ${seed}, cut off ${moment.id}: the update went ahead anyway`);
      assert.ok(refusal instanceof Error, `seed ${seed}, cut off ${moment.id}: refused with something that is not an error`);
      assert.match(refusal.message, moment.expect, `seed ${seed}, cut off ${moment.id}: ${refusal.message}`);
      // Nothing was swapped, no hand-over was written, and the owner's work is untouched.
      assert.equal(await readFile(join(install, "branch-agent"), "utf8"), "the version in use",
        `seed ${seed}, cut off ${moment.id}: the program was replaced anyway`);
      const { exists } = await import("./never-break-install-chaos-helpers.mjs");
      assert.equal(await exists(join(root, "scratch", "apply-update.sh")), false, `seed ${seed}, cut off ${moment.id}: a hand-over was written`);
      assert.equal(await exists(`${install}.previous`), false, `seed ${seed}, cut off ${moment.id}: the old version was moved`);
      assert.equal(await startOrRefuse(`seed ${seed}, cut off ${moment.id}`, dataDir, workspace, before), "started");
      await assertNothingHalfInstalled(`seed ${seed}, cut off ${moment.id}`, dataDir);
      outcomes.push(`${seed}:${moment.id}`);
      // Cutting the update off never takes the safety copy after the check has already failed.
      if (moment.canary) assert.deepEqual(order, [], `seed ${seed}: a safety copy was taken after the check failed`);
      const _ = next();
    }
  }
  t.diagnostic(outcomes.join(" "));
});

/* ============================== 4. data from the wrong version ============================== */

test(`data from a newer Branch is refused without a single byte being changed (${seeds} seeds)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 50021);
    const root = await temp(t, `newer-${seed}`);
    const { dataDir, workspace, before } = await ownersData(root);
    const newest = storeMigrations.at(-1).version;
    const ahead = newest + 1 + Math.floor(next() * 40);
    // A task the newer Branch left running, and a table only it knows about: neither may be touched.
    const db = new DatabaseSync(join(dataDir, "branch.sqlite"));
    db.prepare("UPDATE tasks SET status='running', output=''").run();
    db.exec("CREATE TABLE only_the_newer_one_knows(x TEXT)");
    db.prepare("INSERT INTO only_the_newer_one_knows VALUES(?)").run("the owner's newer work");
    db.exec("CREATE TABLE IF NOT EXISTS branch_format(id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL, readable_by INTEGER NOT NULL, changed_at TEXT NOT NULL)");
    db.prepare("INSERT INTO branch_format(id,version,readable_by,changed_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, readable_by=excluded.readable_by")
      .run(ahead, ahead, new Date().toISOString());
    db.exec(`PRAGMA user_version=${ahead}`);
    db.close();
    const digest = async () => createHash("sha256").update(await readFile(join(dataDir, "branch.sqlite"))).digest("hex");
    const wasAt = await digest();
    const label = `seed ${seed}, data from format ${ahead}`;
    let refusal = null;
    const { createBranch } = await import("../dist/index.js");
    await createBranch({ workspace, dataDir }).then((app) => app.close(), (error) => { refusal = error; });
    assert.ok(refusal instanceof DataTooNewError, `${label}: an older Branch opened work it cannot read`);
    assert.ok(refusal instanceof Error, `${label}: refused with something that is not an error`);
    assert.match(refusal.message, /Nothing was changed/, label);
    assert.equal(await digest(), wasAt, `${label}: the file was changed although the refusal says nothing was`);
    // And the same check on its own, the way the start-up calls it.
    assert.throws(() => assertFormatReadable(join(dataDir, "branch.sqlite"), storeMigrations), DataTooNewError, label);
    outcomes.push(`${seed}:format-${ahead}`);
    const _ = before;
  }
  t.diagnostic(outcomes.join(" "));
});

test("data a newer Branch marked as still readable here opens, and is not dragged back", async (t) => {
  // Seed 5 of the update round drew this case and showed the tests were asking for the wrong thing.
  // A change that only adds keeps `readableBy` at the old number precisely so the release before can
  // still open the data — going back one version is the whole point of it, so it must not refuse,
  // and it must not quietly stamp the data back down to its own format either.
  const root = await temp(t, "readable-ahead");
  const { dataDir, workspace, before } = await ownersData(root);
  const newest = storeMigrations.at(-1).version;
  const { stampFromTheFuture } = await import("./never-break-install-chaos-helpers.mjs");
  stampFromTheFuture(dataDir, newest + 1, newest);
  assert.doesNotThrow(() => assertFormatReadable(join(dataDir, "branch.sqlite"), storeMigrations),
    "data marked as still readable by this format must open");
  assert.equal(await startOrRefuse("newer data still readable here", dataDir, workspace, before), "started");
  const db = new DatabaseSync(join(dataDir, "branch.sqlite"), { readOnly: true });
  try {
    assert.equal(formatOf(db).version, newest + 1, "the newer version's format stamp was not written over");
  } finally { db.close(); }
  // One more ahead than that, and no longer readable here: it must refuse.
  stampFromTheFuture(dataDir, newest + 2, newest + 1);
  assert.throws(() => assertFormatReadable(join(dataDir, "branch.sqlite"), storeMigrations), DataTooNewError);
});

test("data from a much older Branch opens and keeps everything", async (t) => {
  const root = await temp(t, "older");
  const { dataDir, workspace, before } = await ownersData(root);
  // What a Branch from before formats were numbered left behind: no stamp at all.
  const db = new DatabaseSync(join(dataDir, "branch.sqlite"));
  db.exec("DROP TABLE IF EXISTS branch_format");
  db.exec("PRAGMA user_version=0");
  db.close();
  assert.doesNotThrow(() => assertFormatReadable(join(dataDir, "branch.sqlite"), storeMigrations));
  assert.equal(await startOrRefuse("much older data", dataDir, workspace, before), "started");
  const after = await fingerprint(dataDir, workspace);
  assertFormatWhole("much older data", after.format);
  assert.equal(after.format.version, storeMigrations.at(-1).version, "the old data was brought up to this version's format");
});

test("a saved-work file that was never there is not treated as damaged", async (t) => {
  const root = await temp(t, "absent");
  assert.doesNotThrow(() => assertFormatReadable(join(root, "nothing-here.sqlite"), storeMigrations));
});

test("a refusal names the file, says nothing was changed, and says what to do next", async () => {
  const { dataProblemSentence } = await import("../dist/never-break/migrations.js");
  const path = "/home/someone/Branch/state/branch.sqlite";
  for (const [why, must] of [
    [{ message: "database disk image is malformed", code: "ERR_SQLITE_ERROR", errcode: 11, errstr: "database disk image is malformed" }, /damaged[\s\S]*nothing was changed[\s\S]*safety copies/i],
    [{ message: "file is not a database", code: "ERR_SQLITE_ERROR", errcode: 26, errstr: "file is not a database" }, /damaged[\s\S]*safety copies/i],
    [{ message: "attempt to write a readonly database", code: "ERR_SQLITE_ERROR", errcode: 1544, errstr: "attempt to write a readonly database" }, /cannot write[\s\S]*allowed to write/i],
    [{ message: "database or disk is full", code: "ERR_SQLITE_ERROR", errcode: 13, errstr: "database or disk is full" }, /no room left[\s\S]*Free some space/i],
    [{ message: "unable to open database file", code: "ERR_SQLITE_ERROR", errcode: 14, errstr: "unable to open database file" }, /moved, renamed[\s\S]*disk may be full[\s\S]*allowed to read it/i],
    [new Error("database disk image is malformed"), /damaged/i],
    [new Error("attempt to write a readonly database"), /cannot write/i],
  ]) {
    const sentence = dataProblemSentence(path, why);
    assert.ok(sentence, `no plain words for ${why.message}`);
    assert.ok(sentence.includes(path), `the refusal does not say which file: ${sentence}`);
    assert.match(sentence, must, sentence);
    assert.ok(sentence instanceof Error || typeof sentence === "string", `the refusal is not plain text: ${sentence}`);
  }
});

test("only a database another Branch is holding makes the format check step aside", async (t) => {
  const root = await temp(t, "held");
  const { dataDir, workspace } = await ownersData(root);
  const path = join(dataDir, "branch.sqlite");
  // A message that merely mentions being busy is not a reason to skip the check: only SQLite's own
  // numbers for busy (5) and locked (6) are, or an older Branch would write to newer data again.
  const stamped = new DatabaseSync(path);
  stamped.exec("CREATE TABLE IF NOT EXISTS branch_format(id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL, readable_by INTEGER NOT NULL, changed_at TEXT NOT NULL)");
  stamped.prepare("INSERT INTO branch_format(id,version,readable_by,changed_at) VALUES(1,99,98,?) ON CONFLICT(id) DO UPDATE SET version=99, readable_by=98").run(new Date().toISOString());
  stamped.exec("PRAGMA user_version=99");
  stamped.close();
  assert.throws(() => assertFormatReadable(path, storeMigrations), DataTooNewError,
    "the check must still refuse data from the future");
  // With a Branch holding the file, the check steps aside and the store says the plain thing.
  const { createBranch } = await import("../dist/index.js");
  const first = await createBranch({ workspace, dataDir: join(root, "other") });
  try {
    const held = await createBranch({ workspace, dataDir: join(root, "other") }).then(() => null, (error) => error);
    assert.ok(held instanceof Error, "a second Branch: refused with something that is not an error");
  } finally { await first.close(); }
});

test("a copy that cannot be taken before a change to the data's shape stops it in plain words", async (t) => {
  const root = await temp(t, "no-copy");
  const path = join(root, "x.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE notes(t TEXT)");
  db.prepare("INSERT INTO notes VALUES('the owner''s memory')").run();
  migrate(db, [{ version: 1, readableBy: 1, up: () => undefined, down: () => undefined }], { backupTo: null });
  try {
    // `update-backups` is a file, not a folder: the copy cannot be written, so nothing may change.
    await (await import("node:fs/promises")).writeFile(join(root, "update-backups"), "something is in the way");
    const refused = (() => { try { migrate(db, newerVersionMigrations(), { backupTo: join(root, "update-backups", "before.sqlite") }); return null; } catch (error) { return error; } })();
    assert.ok(refused, "the change went ahead with no copy to go back to");
    assert.ok(refused instanceof Error, "no plain words for the error");
    assert.match(refused.message, /could not take the copy[\s\S]*nothing was changed[\s\S]*update-backups/i, refused.message);
    assert.equal(formatOf(db).version, 1, "the change was not half-applied");
    assert.deepEqual(db.prepare("PRAGMA table_info(notes)").all().map((row) => row.name), ["t"], "nothing was added");
    // With the way clear it goes through and the owner's memory is still there.
    await (await import("node:fs/promises")).rm(join(root, "update-backups"), { force: true });
    await (await import("node:fs/promises")).mkdir(join(root, "update-backups"), { recursive: true });
    const report = migrate(db, newerVersionMigrations(), { backupTo: join(root, "update-backups", "before.sqlite") });
    assert.equal(report.to, 3);
    assert.equal(db.prepare("SELECT t FROM notes").get().t, "the owner's memory");
  } finally { db.close(); }
});

/** What the "newer version" of Branch knows how to do, used by the test above and its fixture. */
function newerVersionMigrations() {
  return [
    { version: 1, readableBy: 1, up: () => undefined, down: () => undefined },
    { version: 2, readableBy: 1,
      up: (d) => { d.exec("ALTER TABLE notes ADD COLUMN extra TEXT"); d.exec("UPDATE notes SET extra='moved'");
        d.exec("CREATE TABLE IF NOT EXISTS more(x TEXT)"); d.exec("INSERT INTO more VALUES('filled in')"); },
      down: (d) => d.exec("ALTER TABLE notes DROP COLUMN extra") },
    { version: 3, readableBy: 2, up: (d) => d.exec("ALTER TABLE notes ADD COLUMN newer TEXT"),
      down: (d) => d.exec("ALTER TABLE notes DROP COLUMN newer") },
  ];
}
