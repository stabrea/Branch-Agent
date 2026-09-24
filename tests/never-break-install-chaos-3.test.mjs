/**
 * Never breaks: the second chaos round — installing, updating and starting up (Part 3/4).
 * Extras, disk space, concurrent access, and clock jumping tests.
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
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertNothingHalfInstalled, ownersData, random, startOrRefuse, temp, systemWords,
} from "./never-break-install-chaos-helpers.mjs";
import { doctorFix } from "../dist/doctor-fix.js";
import { builtInSpeech } from "../dist/speech-engines.js";
import { writeUpdateBackup } from "../dist/install/update-backup.js";

const seeds = Math.max(1, Number(process.env.BRANCH_INSTALL_SEEDS ?? 4));

/* ============================== 6. two Branches on one folder ============================== */

test(`a second Branch on the same folder refuses cleanly and the first keeps working (${seeds} seeds)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const root = await temp(t, `two-${seed}`);
    const { dataDir, workspace, before } = await ownersData(root);
    const { createBranch } = await import("../dist/index.js");
    const first = await createBranch({ workspace, dataDir });
    let refusal = null, second = null;
    try {
      await createBranch({ workspace, dataDir }).then((app) => { second = app; }, (error) => { refusal = error; });
      assert.equal(second, null, `seed ${seed}: two Branches opened the same saved work at once`);
      assert.ok(refusal instanceof Error, `seed ${seed}, a second Branch: refused with something that is not an error`);
      assert.match(refusal.message, /already open|already running/i, `seed ${seed}: ${refusal.message}`);
      assert.match(refusal.message, /Nothing was changed/, `seed ${seed}: the refusal does not say the work is safe`);
      // The first one is untouched by the attempt and still works.
      const run = await first.runtime.run({ prompt: "still working", onTextDelta: () => undefined });
      assert.notEqual(run.status, "failed", `seed ${seed}: the first Branch was disturbed`);
    } finally {
      if (second) await second.close();
      await first.close();
    }
    assert.equal(await startOrRefuse(`seed ${seed}, after both closed`, dataDir, workspace, before), "started");
    outcomes.push(`${seed}:refused-cleanly`);
  }
  t.diagnostic(outcomes.join(" "));
});

/* ============================== 7. a fetched extra that is not all there =================== */

/**
 * How a fetched extra can be wrong on disk, and what can honestly be told about it without running
 * it. A file that is gone or empty can be seen from the outside; one whose insides are scrambled
 * cannot, so there the rule is only that Branch still starts and the failure reads as a sentence.
 */
const extraStates = [
  { id: "deleted", seen: true, make: async (path) => { await (await import("node:fs/promises")).rm(path, { force: true }); } },
  { id: "half-downloaded", seen: true, make: async (path) => { await writeFile(path, ""); await chmod(path, 0o755); } },
  { id: "corrupted", seen: false, make: async (path) => { await writeFile(path, "\x00\x00broken"); await chmod(path, 0o755); } },
];

test(`a fetched extra that is missing or half-there says why, and Branch still starts (${extraStates.length} states x ${seeds} seeds)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 70001);
    for (const state of extraStates) {
      const root = await temp(t, `extra-${seed}-${state.id}`);
      const { dataDir, workspace, before } = await ownersData(root);
      const label = `seed ${seed}, the browser was ${state.id}`;
      const browser = join(root, "chromium-shell");
      await writeFile(browser, "#!/bin/sh\nexit 0\n");
      await chmod(browser, 0o755);
      await state.make(browser);
      // The browser check, asked the same question the health screen asks.
      const present = async () => {
        const { stat } = await import("node:fs/promises");
        const info = await stat(browser).catch(() => null);
        return Boolean(info?.isFile() && info.size > 0);
      };
      const report = await doctorFix({ fix: false, port: 0, workspace, browsersInstalled: present, platform: "linux" },
        { run: async () => { throw new Error("nothing is run in this test"); }, portFree: async () => true });
      const web = report.checks.find((check) => check.name === "Web browsing");
      assert.doesNotMatch(web.summary, systemWords, `${label}: ${web.summary}`);
      if (state.seen) {
        assert.equal(web.ok, false, `${label}: an extra that is not there was called installed`);
        assert.match(web.summary, /missing/, `${label}: ${web.summary}`);
        assert.match(web.fix, /playwright install chromium/, `${label}: the fix does not say how to get it back`);
      }

      // The reading-aloud program, in the same three states.
      const speech = builtInSpeech().get("program");
      const spoke = await speech.speak("hello", { settings: { program: browser, programArgs: ["{text}", "{out}"] },
        run: async () => { throw new Error("the program on this computer could not be run"); } }).then(() => null, (error) => error);
      assert.ok(spoke, `${label}: speech claimed to work with no program to run it`);
      if (state.seen) {
        assert.ok(spoke instanceof Error, `${label} (speech): refused with something that is not an error`);
        assert.match(spoke.message, /is not there any more|did not finish/, `${label}: ${spoke.message}`);
        assert.match(spoke.message, /Settings/, `${label}: the refusal does not say where to fix it`);
      }
      assert.doesNotMatch(spoke.message, systemWords, `${label} (speech): ${spoke.message}`);
      // Whatever the extras are doing, Branch itself still starts with everything in place.
      assert.equal(await startOrRefuse(label, dataDir, workspace, before), "started");
      outcomes.push(`${seed}:${state.id}`);
      next();
    }
  }
  t.diagnostic(outcomes.join(" "));
});

/* ============================== 8. the disk filling up while starting ====================== */

test(`a disk with no room left stops the start with a sentence, and a start after it works (${seeds} seeds)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const root = await temp(t, `full-${seed}`);
    const { dataDir, workspace, before } = await ownersData(root);
    // No room to write the safety copy an update takes first.
    const huge = { note: "x".repeat(1) };
    await writeFile(join(dataDir, "update-backups"), "a file where the folder should be").catch(() => undefined);
    const refused = await writeUpdateBackup(dataDir, huge, "0.17.0").then(() => null, (error) => error);
    assert.ok(refused, `seed ${seed}: the safety copy was written although there was nowhere to put it`);
    await (await import("node:fs/promises")).rm(join(dataDir, "update-backups"), { force: true });
    // And once there is room again, everything works and nothing was lost.
    const written = await writeUpdateBackup(dataDir, huge, "0.17.0");
    const { exists } = await import("./never-break-install-chaos-helpers.mjs");
    assert.ok(await exists(written.path), `seed ${seed}: the safety copy was not written once there was room`);
    assert.equal(await startOrRefuse(`seed ${seed}, after the disk filled up`, dataDir, workspace, before), "started");
    // The journal refusing to write is already the first round's ground; here it must not lose work.
    const { createBranch } = await import("../dist/index.js");
    const app = await createBranch({ workspace, dataDir });
    try {
      app.neverBreak.journal.failWrites = () => new Error("ENOSPC: no space left on device");
      const run = await app.runtime.run({ prompt: "one more thing", onTextDelta: () => undefined });
      if (run.status !== "completed") assert.match(run.output, /disk may be full/, `seed ${seed}: ${run.output}`);
      app.neverBreak.journal.failWrites = null;
    } finally { await app.close(); }
    assert.equal(await startOrRefuse(`seed ${seed}, after the journal could not write`, dataDir, workspace, before), "started");
    outcomes.push(`${seed}:no-room`);
  }
  t.diagnostic(outcomes.join(" "));
});

/* ============================== 5. the clock talking nonsense ============================== */

test(`the clock jumping between two starts loses nothing (${seeds} seeds)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 60013);
    const root = await temp(t, `clock-${seed}`);
    const { dataDir, workspace, before } = await ownersData(root);
    // The note an update leaves behind, written with a time the clock will later contradict.
    const jump = next() < 0.5 ? -400 * 86400 * 1000 : 400 * 86400 * 1000;
    const { writeWatch, readWatch, watchVerdict } = await import("../dist/never-break/canary.js");
    await writeWatch(dataDir, { from: "1.0.0", to: "2.0.0", target: join(root, "installed"), platform: "linux",
      executableName: "branch-agent", startedAt: new Date(Date.now() - jump).toISOString() });
    const label = `seed ${seed}, clock jumped ${Math.round(jump / 86400000)} days`;
    assert.equal(await startOrRefuse(label, dataDir, workspace, before), "started");
    const watch = await readWatch(dataDir);
    assert.ok(watch, `${label}: the note about the update became unreadable`);
    assert.equal(watchVerdict(watch, { now: Date.now(), watchSeconds: 300, runningVersion: "2.0.0", failing: true }), "done",
      `${label}: a clock that jumped would have rolled a good version back`);
    outcomes.push(`${seed}:${jump > 0 ? "forwards" : "backwards"}`);
  }
  t.diagnostic(outcomes.join(" "));
});
