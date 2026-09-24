/**
 * Never breaks: the second chaos round — installing, updating and starting up (Part 2/4).
 * Broken machine states test (the heavy one).
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
import { mkdir, open, readFile, stat, truncate, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import {
  assertNothingHalfInstalled, ownersData, random, startOrRefuse, temp, makeReadOnly, makeWritable,
} from "./never-break-install-chaos-helpers.mjs";

const seeds = Math.max(1, Number(process.env.BRANCH_INSTALL_SEEDS ?? 4));

/* ============================== 3. a machine that is already broken ========================= */

/**
 * The states a machine can be in before Branch even starts. Each one is made on a folder that
 * already holds the owner's work, so the rules can be checked against what was there.
 */
const brokenStates = [
  { id: "the-data-folder-is-read-only", must: "refused",
    make: async ({ dataDir }) => { await makeReadOnly(dataDir); }, undo: async ({ dataDir }) => { await makeWritable(dataDir); } },
  { id: "the-database-was-cut-off-half-written", must: "refused",
    make: async ({ dataDir }) => { const p = join(dataDir, "branch.sqlite"); await truncate(p, Math.floor((await stat(p)).size / 2)); } },
  { id: "the-database-is-not-a-database", must: "refused",
    make: async ({ dataDir }) => { await writeFile(join(dataDir, "branch.sqlite"), "this file was replaced by something else"); } },
  { id: "a-page-of-the-database-was-scribbled-over", must: "either",
    make: async ({ dataDir }) => { const fh = await open(join(dataDir, "branch.sqlite"), "r+"); await fh.write(Buffer.alloc(4096, 0x41), 0, 4096, 8192); await fh.close(); } },
  { id: "the-journal-has-a-torn-last-entry", must: "started",
    make: async ({ dataDir }) => { const p = join(dataDir, "journal.sqlite"); await truncate(p, Math.max(0, (await stat(p)).size - 300)); } },
  { id: "the-journal-is-not-a-database", must: "started",
    make: async ({ dataDir }) => { await writeFile(join(dataDir, "journal.sqlite"), "scribbled on"); } },
  { id: "the-settings-are-not-valid-json", must: "started",
    make: async ({ dataDir }) => { await writeFile(join(dataDir, "gateway.json"), "{ half a settings file,,,"); } },
  { id: "the-note-about-what-is-running-is-rubbish", must: "started",
    make: async ({ dataDir }) => { await writeFile(join(dataDir, "running.json"), "\x00\x00not json"); } },
  { id: "the-note-about-the-last-update-is-rubbish", must: "started",
    make: async ({ dataDir }) => { await writeFile(join(dataDir, "update-watch.json"), "{"); } },
  { id: "the-device-key-was-cut-off-half-written", must: "started",
    make: async ({ dataDir }) => { await writeFile(join(dataDir, "locker.key"), "hal"); } },
  { id: "the-update-copies-folder-is-a-file", must: "started",
    make: async ({ dataDir }) => { await writeFile(join(dataDir, "update-backups"), "not a folder"); } },
  { id: "a-copy-taken-for-a-check-was-left-behind", must: "started",
    make: async ({ dataDir }) => { await mkdir(join(dataDir, "updates", "canary-2020-01-01T00-00-00-000Z", "data"), { recursive: true }); },
    allowLeftovers: true },
];

test(`Branch started on a broken machine either starts with everything there or says why (${brokenStates.length} states x ${seeds} seeds)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 40009);
    // The seed decides the order, so a long run tries them in different sequences; each is still tried.
    const order = [...brokenStates].sort(() => next() - 0.5);
    for (const state of order) {
      const root = await temp(t, `broken-${seed}`);
      const made = await ownersData(root);
      await state.make(made);
      const label = `seed ${seed}, ${state.id}`;
      let outcome;
      try { outcome = await startOrRefuse(label, made.dataDir, made.workspace, made.before); }
      finally { await state.undo?.(made); }
      if (state.must !== "either") assert.equal(outcome, state.must, `${label}: expected it to have ${state.must}`);
      if (outcome === "started" && !state.allowLeftovers) await assertNothingHalfInstalled(label, made.dataDir);
      outcomes.push(`${seed}:${state.id}:${outcome}`);
    }
  }
  t.diagnostic(outcomes.join(" "));
});

/* ============================== 5. the clock talking nonsense ============================== */

test("a clock that jumped backwards neither holds an update's watch open nor rolls a good version back", async () => {
  const { watchVerdict } = await import("../dist/never-break/canary.js");
  const started = Date.parse("2026-09-18T12:00:00.000Z");
  const watch = { from: "1.0.0", to: "2.0.0", target: "/x", platform: "linux", executableName: "b", startedAt: new Date(started).toISOString() };
  const at = (now, extra) => watchVerdict(watch, { now, watchSeconds: 300, runningVersion: "2.0.0", failing: false, ...extra });
  const year = 365 * 86400 * 1000;
  assert.equal(at(started + 10_000), "watching", "the ordinary case still watches");
  assert.equal(at(started - year), "done", "a clock a year behind does not keep watching for ever");
  assert.equal(at(started - year, { failing: true }), "done", "a crash with the clock a year behind is not an update to roll back");
  assert.equal(at(started - 1000, { failing: true }), "done", "a clock a second behind is not a reason to roll back");
  assert.equal(at(started + year), "done", "a clock years ahead ends the watch rather than leaving it open");
  const unreadable = { ...watch, startedAt: "when the update happened" };
  assert.equal(watchVerdict(unreadable, { now: Date.now(), watchSeconds: 300, runningVersion: "2.0.0", failing: true }), "done",
    "a time that cannot be read is not a reason to roll back either");
});

test("a clock that jumped backwards never throws away the safety copy just written", async (t) => {
  const root = await temp(t, "clock-backups");
  const dataDir = join(root, "d");
  const { writeUpdateBackup, backupFileName } = await import("../dist/install/update-backup.js");
  const times = ["2026-09-15T10:00:00Z", "2026-09-16T10:00:00Z", "2026-09-17T10:00:00Z"];
  for (const [index, when] of times.entries())
    await writeUpdateBackup(dataDir, { note: `copy ${index}` }, `0.17.${index}`, new Date(when));
  // The clock jumps back years; this copy is the newest there is, and must survive the tidy-up.
  const jumped = new Date("2019-01-01T10:00:00Z");
  const written = await writeUpdateBackup(dataDir, { note: "taken after the clock jumped" }, "0.18.0", jumped);
  const name = backupFileName("0.18.0", jumped);
  assert.ok(!written.pruned.includes(name), `the copy just written was thrown away: ${written.pruned.join(", ")}`);
  const { exists } = await import("./never-break-install-chaos-helpers.mjs");
  assert.ok(await exists(join(dataDir, "update-backups", name)), "the copy just written is gone");
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, "update-backups", name), "utf8")), { note: "taken after the clock jumped" });
  const { backupsToPrune } = await import("../dist/install/update-backup.js");
  assert.deepEqual(backupsToPrune([name, ...times.map((when, i) => backupFileName(`0.17.${i}`, new Date(when)))], 3, name).includes(name), false);
});

test("the copies taken before a change to the data's shape do not pile up for ever", async () => {
  const { formatCopiesToPrune } = await import("../dist/install/update-backup.js");
  const names = Array.from({ length: 7 }, (_, i) => `before-format-${1_700_000_000_000 + i}.sqlite`);
  const pruned = formatCopiesToPrune([...names].reverse(), 3);
  assert.deepEqual(pruned, names.slice(0, 4), "the oldest are let go and the newest three kept");
  assert.deepEqual(formatCopiesToPrune(["before-2026-09-17T10-00-00-v0.17.0.json", "notes.txt"], 3), [],
    "the owner's own safety copies are not touched by this");
});
