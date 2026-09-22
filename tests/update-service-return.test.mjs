/**
 * A Branch that was working in the background comes back by itself after `branch update --yes` and
 * after `branch rollback --yes` (src/install/service-return.ts). Closing it for the swap is a polite
 * exit, which neither launchd's KeepAlive{SuccessfulExit:false} nor systemd's Restart=on-failure
 * restarts, so before this the service stayed down until the next sign-in and the watch that rolls a
 * bad version back never ran. When the new version does not come up, the version before is put back
 * and started instead: the owner is never left with no Branch running.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { discardTemp } from "./temp-dir.mjs";
import { restartService, serviceRestartCommand, waitForReturn } from "../dist/install/service-return.js";
import { performRollback } from "../dist/never-break/rollback.js";
import { headlessUpdate } from "../dist/install/headless-update.js";
import { rollbackCommand } from "../dist/install/rollback-cli.js";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { attachToRunning, readRunning, writeRunning } from "../dist/install/running.js";
import { ActivationJournal, fingerprintTree } from "../dist/never-break/activation.js";

const posixOnly = process.platform === "win32" && "shell scripts are for macOS and Linux";

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-service-return-"));
  t.after(() => discardTemp(root));
  return root;
}

test("each system's own manager is asked to start the service again, by its exact name", () => {
  assert.deepEqual(serviceRestartCommand("darwin", 501), ["/bin/launchctl", ["kickstart", "-k", "gui/501/com.keepoak.branch-agent"]]);
  assert.deepEqual(serviceRestartCommand("linux"), ["systemctl", ["--user", "restart", "branch-agent.service"]]);
  const [tool, args] = serviceRestartCommand("win32");
  assert.match(tool, /schtasks\.exe$/i);
  assert.deepEqual(args, ["/Run", "/TN", "Branch Agent daemon"]);
  assert.throws(() => serviceRestartCommand("aix"), /not available/);
});

test("starting the service again really runs that system's own command", async () => {
  // Every test below hands in its own `restartService`, so without this the one function that
  // actually asks the system to start Branch again could do nothing at all and nothing would notice.
  const ran = [];
  await restartService("linux", async (tool, args) => { ran.push([tool, args]); });
  assert.deepEqual(ran, [["systemctl", ["--user", "restart", "branch-agent.service"]]]);

  const onMac = [];
  await restartService("darwin", async (tool, args) => { onMac.push([tool, args]); });
  assert.equal(onMac.length, 1);
  assert.equal(onMac[0][0], "/bin/launchctl");
  assert.equal(onMac[0][1][0], "kickstart");
});

/** A note the way the running file holds one, so a test says what it means rather than what it types. */
const note = (over = {}) => ({
  pid: 5151, mode: "daemon", port: 8787, url: "http://127.0.0.1:8787",
  version: "2.0.0", startedAt: "2026-09-22T10:00:05.000Z", ...over,
});
const wasRunning = { pid: 4242, mode: "daemon", port: 8787, url: "http://127.0.0.1:8787",
  version: "1.0.0", startedAt: "2026-09-22T10:00:00.000Z" };
/** The wait, driven by a list of notes, with the clock and the answering Branch in the test's hands. */
async function waiting(notes, over = {}) {
  let clock = 0;
  const left = [...notes];
  const answers = over.attach === undefined ? { instance: note(), version: "2.0.0" } : over.attach;
  const back = await waitForReturn("data", wasRunning, { version: "2.0.0" }, {
    running: async () => left.shift() ?? null,
    attach: async () => answers,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    waitMs: 3000,
  });
  return { back, clock };
}

test("the version a Branch answers with is not the version written down beside it", async (t) => {
  // `running.json` is written by whatever started. A swap that half happened, or an older copy that
  // wrote the file last, can leave it naming a version that is not the one now answering on the port.
  // The return check compares the answer, so the two have to come back as different things.
  const root = await mkdtemp(join(tmpdir(), "branch-attach-version-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, presence: "app" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });

  // Tell the note a lie the server will not repeat.
  const note = await readRunning(join(root, "data"));
  await writeRunning(join(root, "data"), { ...note, version: "9.9.9-not-really" });

  const joined = await attachToRunning(join(root, "data"));
  assert.ok(joined, "the running Branch is found");
  assert.equal(joined.instance.version, "9.9.9-not-really", "the note still says what it was told to say");
  assert.equal(joined.version, app.version, "and the version handed back is the one it answered with");
  assert.notEqual(joined.version, joined.instance.version, "which is the whole point of keeping both");
});

test("with nothing stubbed, the wait believes the running Branch and not the note", async (t) => {
  // The default way of asking is the one production uses: `attachToRunning`, with this computer's own
  // saved key. This drives it for real — a real server, a real note on disk — and makes the note claim
  // the version we are waiting for while the Branch answering says something else.
  const root = await mkdtemp(join(tmpdir(), "branch-return-real-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir,
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir, port: 0, presence: "app" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });

  const started = await readRunning(dataDir);
  const before = { pid: 1, startedAt: "2000-01-01T00:00:00.000Z" };
  const clock = () => 0;
  const patient = { sleep: async () => undefined, now: clock, waitMs: 0 };

  // The note says it is the service on 2.0.0, started long after the one that was closed. Everything
  // on disk agrees. The Branch on the port does not.
  await writeRunning(dataDir, { ...started, mode: "daemon", version: "2.0.0", startedAt: "2030-01-01T00:00:00.000Z" });
  assert.equal(await waitForReturn(dataDir, before, { version: "2.0.0" }, patient), null,
    "a note that says 2.0.0 is not a Branch running 2.0.0");

  // And when what is asked for is what it really answers, it is accepted.
  await writeRunning(dataDir, { ...started, mode: "daemon", version: app.version, startedAt: "2030-01-01T00:00:00.000Z" });
  const back = await waitForReturn(dataDir, before, { version: app.version }, patient);
  assert.ok(back, "the Branch that is really there, on the version it really is");
  assert.equal(back.pid, started.pid);
});

test("the wait is for the service, on the right version, started since — and it has to answer", async () => {
  // What coming back looks like: the service, version 2.0.0, started after the one that was closed,
  // and answering on its own port with this computer's key.
  const good = await waiting([null, note()]);
  assert.equal(good.back?.pid, 5151, "that is the return");

  // Four things that look like a return and are not. Each of these was accepted before.
  const notTheService = await waiting([note({ mode: "app" })]);
  assert.equal(notTheService.back, null, "a window somebody opened is not the service coming back");

  const oldVersion = await waiting([note({ version: "1.0.0" })]);
  assert.equal(oldVersion.back, null, "coming back on the version we were leaving is not coming back");

  const staleNote = await waiting([note({ pid: 4242, startedAt: wasRunning.startedAt })]);
  assert.equal(staleNote.back, null, "the note the closed copy left behind is not a new Branch");

  const unrelated = await waiting([note({ pid: 9999, startedAt: "2026-09-22T09:59:00.000Z" })]);
  assert.equal(unrelated.back, null, "something that started before the swap is not the return either");

  // A process id the system handed out again is still a new Branch, and must not be punished for it.
  const reused = await waiting([note({ pid: 4242 })], { attach: { instance: note({ pid: 4242 }), version: "2.0.0" } });
  assert.equal(reused.back?.pid, 4242, "the same id, a later start: a new Branch");

  // And a note that cannot be made to answer is not proof of anything.
  const silent = await waiting([note(), note(), note()], { attach: null });
  assert.equal(silent.back, null, "a Branch that will not answer with this computer's key is not counted");
  assert.ok(silent.clock >= 3000 && silent.clock < 4000, "it waited as long as it was allowed, and no longer");

  const wrongAnswer = await waiting([note()], { attach: { instance: note(), version: "1.0.0" } });
  assert.equal(wrongAnswer.back, null, "and one that answers with another version is not the version we wanted");
});

test("an undo whose restart fails is a failure, whatever else went right", async (t) => {
  // Everything about this undo works except the one thing that puts Branch back in front of the owner.
  // Being on the older files with nothing running them is not being back, and saying otherwise sent the
  // owner away with exit code 0 and a service that was down.
  const root = await scratch(t);
  const journal = new ActivationJournal(join(root, "activation.sqlite"));
  const target = join(root, "Apps", "Branch-Agent");
  await fakeApp(target, "2.0.0");
  await fakeApp(`${target}.previous`, "1.0.0");
  const id = journal.stage({ kind: "update", fromVersion: "1.0.0", toVersion: "2.0.0", target,
    previous: await fingerprintTree(`${target}.previous`), candidate: await fingerprintTree(target),
    launcher: null, executableName: "branch-agent", understood: 1, databases: [], backups: [] });
  journal.activated(id);

  const shared = {
    journal, by: "test@test",
    observe: async () => ({ current: await fingerprintTree(target), previous: await fingerprintTree(`${target}.previous`), store: null, runnerKnows: 0 }),
    swap: async () => ["put version 1.0.0 back"],
  };
  const refused = await performRollback(journal.current(), { ...shared, restart: async () => { throw new Error("no such unit"); } });
  assert.equal(refused.ok, false, "the undo did not do what it set out to do");
  assert.match(refused.message, /could not be started again/);
  assert.match(refused.message, /no such unit/, "and says what the manager said");
  assert.ok(refused.steps.some((step) => step.step === "started Branch again" && !step.ok), "the step is written down as failed");

  // The same undo with a restart that works is a success, so this is about the restart and nothing else.
  journal.activated(journal.stage({ kind: "update", fromVersion: "1.0.0", toVersion: "2.0.0", target,
    previous: await fingerprintTree(`${target}.previous`), candidate: await fingerprintTree(target),
    launcher: null, executableName: "branch-agent", understood: 1, databases: [], backups: [] }));
  const fine = await performRollback(journal.current(), { ...shared, restart: async () => undefined });
  journal.close(); // before the folder goes, or Windows will not let it
  assert.equal(fine.ok, true, fine.message);
  assert.match(fine.message, /Branch is back on version 1\.0\.0/);
});

/* ---------- branch update --yes ---------- */

async function fakeApp(dir, version) {
  await mkdir(join(dir, "resources", "app", "dist"), { recursive: true });
  await writeFile(join(dir, "branch-agent"), `#!/bin/sh\necho ${version}\n`);
  await writeFile(join(dir, "resources", "app", "dist", "cli.js"), `// ${version}\n`);
  await writeFile(join(dir, "resources", "version.txt"), version);
}

async function updateSetup(t, { mode = "daemon" } = {}) {
  const root = await scratch(t);
  const archive = Buffer.from("pretend download");
  const digest = createHash("sha256").update(archive).digest("hex");
  const release = {
    tag_name: "v2.0.0", name: "Branch Agent 2.0.0", body: "", published_at: null, html_url: "https://github.com/stabrea/Branch-Agent/releases/v2.0.0",
    assets: [
      { name: "Branch-Agent-linux-x64.tar.gz", browser_download_url: "https://example.test/app.tar.gz", size: archive.length },
      { name: "Branch-Agent-linux-x64.tar.gz.sha256", browser_download_url: "https://example.test/app.sha256", size: 10 },
    ],
  };
  const events = [];
  const running = { pid: 4242, mode, port: 8787, url: "http://127.0.0.1:8787", version: "1.0.0", startedAt: new Date().toISOString() };
  const deps = {
    fetch: async (url) => url.endsWith("/releases/latest") ? Response.json(release)
      : url.endsWith(".sha256") ? new Response(`${digest}  x\n`) : new Response(archive),
    scratchDir: join(root, "scratch"),
    running: async () => running,
    extract: async (_file, into) => { await fakeApp(into, "2.0.0"); },
    backup: async () => { events.push("backup"); },
    snapshot: async () => join(root, "snapshot"),
    quit: async () => { events.push("quit"); return { stopped: true, wasRunning: true, pid: 4242, message: "" }; },
    runScript: (...args) => { events.push(["script", ...args]); return 0; },
    restartService: async () => { events.push("restart"); },
    rollback: async () => { events.push("rollback"); return 0; },
  };
  const lines = [];
  const input = { installRoot: join(root, "app"), dataDir: join(root, "data"), version: "1.0.0", platform: "linux", arch: "x64",
    yes: true, print: (line) => lines.push(line) };
  await mkdir(input.dataDir, { recursive: true });
  await fakeApp(input.installRoot, "1.0.0");
  return { deps, events, lines, input };
}
/**
 * A return the strict check will accept: the background service, on the version asked for, started
 * after the one that was closed, and answering on its own port with that same version. Anything a
 * test leaves out here is a thing the check is entitled to refuse.
 */
const cameBack = (over = {}) => {
  const note = { pid: 5151, mode: "daemon", port: 8787, url: "http://127.0.0.1:8787",
    version: "2.0.0", startedAt: new Date(Date.now() + 60000).toISOString(), ...over };
  return {
    running: async () => note,
    attach: async () => ({ instance: note, version: over.answers ?? note.version }),
    sleep: async () => undefined, waitMs: 0,
  };
};
/** Nothing comes back at all, and nothing answers. */
const neverBack = () => ({ running: async () => null, attach: async () => null, sleep: async () => undefined, waitMs: 0 });

test("a Branch working in the background comes back by itself on the new version", { skip: posixOnly }, async (t) => {
  const s = await updateSetup(t);
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps, returnWait: cameBack() } });
  assert.equal(code, 0, s.lines.join("\n"));
  assert.ok(s.events.includes("restart"), "the service was started again through its manager");
  assert.ok(!s.events.includes("rollback"));
  assert.match(s.lines.at(-1), /working in the background again, on version 2\.0\.0/);
  assert.ok(!s.lines.some((line) => /start it again with `branch start`/.test(line)), "the owner is no longer told to do it themselves");
});

test("when the new version does not come up, the version before is put back and started", { skip: posixOnly }, async (t) => {
  const s = await updateSetup(t);
  // The service does come back — on the version we were leaving. That is not the new version coming
  // up, and taking the note's word for it was how this used to pass.
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps, returnWait: cameBack({ version: "1.0.0" }) } });
  assert.equal(code, 1);
  assert.ok(s.events.indexOf("rollback") > s.events.indexOf("restart"), "it went back only after the new version failed to come up");
  assert.match(s.lines.join("\n"), /did not come back up in the background, so Branch is going back to the version it had/);
});

test("a Branch that answers with the old version is not the new one coming back", { skip: posixOnly }, async (t) => {
  // The note on disk is written by whatever started, so a swap that half happened can leave it saying
  // 2.0.0 while the Branch actually answering on the port is still 1.0.0. The note is not the proof.
  const s = await updateSetup(t);
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps, returnWait: cameBack({ answers: "1.0.0" }) } });
  assert.equal(code, 1, "what it answered with is what counts, not what was written down");
  assert.ok(s.events.includes("rollback"), "so the version before was put back");
});

test("a service manager that refuses the start goes straight to the way back", { skip: posixOnly }, async (t) => {
  const s = await updateSetup(t);
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps, restartService: async () => { throw new Error("no such unit"); }, returnWait: neverBack() } });
  assert.equal(code, 1);
  assert.ok(s.events.includes("rollback"));
});

test("a window, not a service, is reopened by the hand-over as before and no service is started", { skip: posixOnly }, async (t) => {
  const s = await updateSetup(t, { mode: "app" });
  assert.equal(await headlessUpdate({ ...s.input, deps: s.deps }), 0, s.lines.join("\n"));
  const script = s.events.find((event) => Array.isArray(event) && event[0] === "script");
  assert.ok(script && !script.includes("stay"), "the hand-over reopens the window itself");
  assert.ok(!s.events.includes("restart"));
});

/* ---------- branch rollback --yes ---------- */

test("branch rollback brings a background service back as the service, not as a window", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const target = join(root, "Apps", "Branch-Agent");
  await fakeApp(target, "2.0.0");
  await fakeApp(`${target}.previous`, "1.0.0");
  const journal = new ActivationJournal(join(dataDir, "activation.sqlite"));
  const id = journal.stage({ kind: "update", fromVersion: "1.0.0", toVersion: "2.0.0", target,
    previous: await fingerprintTree(`${target}.previous`), candidate: await fingerprintTree(target),
    launcher: null, executableName: "branch-agent", understood: 1, databases: [], backups: [] });
  journal.activated(id);
  journal.close();
  await writeRunning(dataDir, { pid: process.pid, mode: "daemon", port: 8787, url: "http://127.0.0.1:8787", version: "2.0.0" });
  let restarted = 0;
  const said = [];
  const code = await rollbackCommand({ dataDir, version: "2.0.0", yes: true, platform: "linux", print: (line) => said.push(line),
    deps: {
      quit: { alive: () => true, stopEngine: async () => ({ stopped: true, message: "" }) },
      restartService: async () => { restarted += 1; },
      launch: () => assert.fail("a service is never brought back as a window"),
    } });
  assert.equal(code, 0, said.join("\n"));
  assert.equal(restarted, 1);
  assert.equal(await readFile(join(target, "resources", "version.txt"), "utf8"), "1.0.0", "the version before is back");
});


test("the undo is told what was running, so a service that never came back is started again", async (t) => {
  // The update's recovery reaches the undo after the service has been closed and the new version never
  // came up. Asking the disk then answers "nothing is running", and the files would go back with nothing
  // started. What was running before all this began is carried in instead.
  const root = await scratch(t);
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const target = join(root, "Apps", "Branch-Agent");
  await fakeApp(target, "2.0.0");
  await fakeApp(`${target}.previous`, "1.0.0");
  const journal = new ActivationJournal(join(dataDir, "activation.sqlite"));
  const id = journal.stage({ kind: "update", fromVersion: "1.0.0", toVersion: "2.0.0", target,
    previous: await fingerprintTree(`${target}.previous`), candidate: await fingerprintTree(target),
    launcher: null, executableName: "branch-agent", understood: 1, databases: [], backups: [] });
  journal.activated(id);
  journal.close();

  // Nothing is running, exactly as it is at that moment.
  let restarted = 0;
  const said = [];
  const code = await rollbackCommand({ dataDir, version: "2.0.0", yes: true, platform: "linux", print: (line) => said.push(line),
    deps: {
      quit: { alive: () => false, stopEngine: async () => ({ stopped: true, message: "" }) },
      wasRunning: { pid: 4242, mode: "daemon", port: 8787, url: "http://127.0.0.1:8787", version: "1.0.0", startedAt: "2026-09-22T10:00:00.000Z" },
      restartService: async () => { restarted += 1; },
      launch: () => assert.fail("a service is never brought back as a window"),
    } });
  assert.equal(code, 0, said.join("\n"));
  assert.equal(restarted, 1, "the service was started again, because the undo was told there was one");
  assert.equal(await readFile(join(target, "resources", "version.txt"), "utf8"), "1.0.0");
});

test("an update whose hand-over fails does not leave a service down", { skip: posixOnly }, async (t) => {
  // The hand-over closed the service and told the script not to reopen it. If the script then fails,
  // stopping here leaves the owner on the version they had with nothing running it.
  const s = await updateSetup(t);
  const events = s.events;
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps,
    runScript: (...args) => { events.push(["script", ...args]); return 3; },
    returnWait: cameBack({ version: "1.0.0" }),
  } });
  assert.ok(events.includes("restart"), "the service was started again after the hand-over failed");
  assert.match(s.lines.join("\n"), /did not finish/);
  assert.match(s.lines.join("\n"), /working in the background again, on version 1\.0\.0/, "and it really came back");
  // The service is back, and the update still failed. Whatever asked for it is told so.
  assert.equal(code, 1, "a failed update never answers 0, however well the recovery went");
});
