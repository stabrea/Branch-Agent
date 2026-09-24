/**
 * Never breaks: the second chaos round — installing, updating and starting up (Part 4/4).
 * Migrations, settings, and journal tests.
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
import { spawnSync } from "node:child_process";
import { stat, truncate, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ownersData, random, startOrRefuse, temp, systemWords,
} from "./never-break-install-chaos-helpers.mjs";
import { formatOf, migrate, storeMigrations } from "../dist/never-break/migrations.js";
import { loadGatewayConfig, promoteGood, saveGatewayConfig, GatewayConfigSchema } from "../dist/never-break/gateway-config.js";
import { openJournal } from "../dist/never-break/journal.js";

const seeds = Math.max(1, Number(process.env.BRANCH_INSTALL_SEEDS ?? 4));

/* ============================== 2. killed in the middle of a migration ====================== */

const migrationScript = resolve("tests/fixtures/never-break-kill-migration.mjs");

test(`a change to the shape of the data killed part-way, twice, is finished by a newer version (${seeds * 4} tries)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 30011);
    const root = await temp(t, `migrate-${seed}`);
    for (let trial = 0; trial < 4; trial++) {
      const path = join(root, `try-${trial}.sqlite`);
      const db = new DatabaseSync(path);
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE notes(t TEXT)");
      db.prepare("INSERT INTO notes VALUES('the owner''s memory')").run();
      migrate(db, [{ version: 1, readableBy: 1, up: () => undefined, down: () => undefined }], { backupTo: null });
      db.close();
      // Killed at a point the seed picks, twice in a row, then finished by a version that knows more.
      const at = Math.floor(next() * 5);
      for (const round of [1, 2]) {
        const killed = spawnSync(process.execPath, [migrationScript, path, String(at), String(round)], { stdio: "ignore" });
        assert.notEqual(killed.status, 0, `seed ${seed} try ${trial}: the run at step ${at} was meant to be cut off`);
      }
      const after = new DatabaseSync(path);
      const label = `seed ${seed}, killed twice at step ${at}`;
      try {
        const report = migrate(after, newerVersionMigrations(), { backupTo: null });
        assert.equal(report.to, 3, `${label}: the newer version did not finish the change`);
        assertFormatWhole(label, formatOf(after), newerVersionMigrations());
        assert.equal(after.prepare("SELECT t FROM notes").get().t, "the owner's memory", `${label}: the owner's memory was lost`);
        const columns = after.prepare("PRAGMA table_info(notes)").all().map((row) => row.name);
        assert.deepEqual(columns, ["t", "extra", "newer"], `${label}: the change is half-applied: ${columns.join(",")}`);
        assert.equal(after.prepare("SELECT x FROM more").get().x, "filled in", `${label}: the change ran but left its work undone`);
      } finally { after.close(); }
      outcomes.push(`${seed}:${trial}:step${at}`);
    }
  }
  t.diagnostic(outcomes.join(" "));
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

function assertFormatWhole(label, format, list = storeMigrations) {
  const newest = list.at(-1).version;
  assert.ok(format.version >= 1, `${label}: the data has no format at all (${format.version})`);
  assert.ok(format.readableBy <= format.version, `${label}: the format says it needs a newer reader than it is`);
  if (format.version > newest)
    assert.ok(format.readableBy <= newest,
      `${label}: the data is at format ${format.version}, which this build cannot read (it needs ${format.readableBy})`);
}

test(`settings written over while Branch was being killed never stop it starting (${seeds * 10} tries)`, async (t) => {
  const root = await temp(t, "settings");
  for (let trial = 0; trial < seeds * 10; trial++) {
    const next = random(trial + 101);
    const dataDir = join(root, `try-${trial}`);
    await (await import("node:fs/promises")).mkdir(dataDir, { recursive: true });
    const good = GatewayConfigSchema.parse({ mode: "on", holdSeconds: 11 });
    await promoteGood(dataDir, good);
    await saveGatewayConfig(dataDir, good);
    // A settings file caught half-written: cut short, or the two halves of two different writes.
    const whole = await (await import("node:fs/promises")).readFile(join(dataDir, "gateway.json"), "utf8");
    const other = JSON.stringify({ ...good, holdSeconds: 33, startSeconds: 45 });
    const kind = Math.floor(next() * 3);
    const torn = kind === 0 ? whole.slice(0, Math.floor(next() * whole.length))
      : kind === 1 ? whole.slice(0, whole.length / 2) + other.slice(other.length / 2)
      : `${whole}${whole}`;
    await writeFile(join(dataDir, "gateway.json"), torn);
    const loaded = await loadGatewayConfig(dataDir);
    assert.ok(GatewayConfigSchema.safeParse(loaded.config).success, `try ${trial} (kind ${kind}): the settings in use are not valid`);
    if (loaded.problem) {
      assert.equal(loaded.config.holdSeconds, 11, `try ${trial}: the last settings known to be good were not put back`);
      assert.doesNotMatch(loaded.problem, systemWords, `try ${trial}: ${loaded.problem}`);
    }
  }
});

/* ============================== 9. a journal cut off mid-write ============================= */

test(`a journal cut off mid-write is put aside and Branch starts with a fresh one (${seeds * 3} tries)`, async (t) => {
  const root = await temp(t, "journal");
  for (let trial = 0; trial < seeds * 3; trial++) {
    const next = random(trial + 7);
    const path = join(root, `j-${trial}.sqlite`);
    const { journal } = openJournal(path);
    journal.begin({ runId: "r", sessionId: "s", callId: "c", tool: "files.write", arguments: "{}", key: "k", effects: "idempotent", evidence: null });
    journal.close();
    const kind = Math.floor(next() * 3);
    if (kind === 0) await truncate(path, Math.max(0, Math.floor((await stat(path)).size * next())));
    else if (kind === 1) await writeFile(path, "not a journal at all");
    else {
      const db = new DatabaseSync(path);
      db.exec("PRAGMA user_version=99");
      db.exec("UPDATE branch_format SET version=99, readable_by=98");
      db.close();
    }
    const again = openJournal(path);
    try {
      assert.ok(again.journal, `try ${trial} (kind ${kind}): Branch could not open a journal at all`);
      if (again.reset) {
        assert.match(again.reset, /put aside|new one started/, `try ${trial}: ${again.reset}`);
        assert.doesNotMatch(again.reset.replace(/\(.*\)/s, ""), systemWords, `try ${trial}: ${again.reset}`);
      }
      // Whatever happened, the journal works from here on.
      const id = again.journal.begin({ runId: "r2", sessionId: "s2", callId: "c2", tool: "files.write", arguments: "{}", key: "k2", effects: "idempotent", evidence: null });
      assert.ok(id > 0, `try ${trial}: the fresh journal cannot be written to`);
    } finally { again.journal.close(); }
  }
});
