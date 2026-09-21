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
import { serviceRestartCommand, waitForReturn } from "../dist/install/service-return.js";
import { headlessUpdate } from "../dist/install/headless-update.js";
import { rollbackCommand } from "../dist/install/rollback-cli.js";
import { writeRunning } from "../dist/install/running.js";
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

test("the wait is for a Branch other than the one that was closed, and gives up in time", async () => {
  let clock = 0;
  const notes = [null, { pid: 10 }, { pid: 10 }, { pid: 22, mode: "daemon" }];
  const back = await waitForReturn("data", 10, { running: async () => notes.shift() ?? null, sleep: async (ms) => { clock += ms; }, now: () => clock });
  assert.equal(back?.pid, 22, "the old process id still written down is not the new version");

  clock = 0;
  const never = await waitForReturn("data", 10, { running: async () => ({ pid: 10 }), sleep: async (ms) => { clock += ms; }, now: () => clock, waitMs: 3000 });
  assert.equal(never, null);
  assert.ok(clock >= 3000 && clock < 4000, "it waited as long as it was allowed, and no longer");
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
const quick = (notes) => ({ running: async () => notes.shift() ?? null, sleep: async () => undefined, waitMs: 0 });

test("a Branch working in the background comes back by itself on the new version", { skip: posixOnly }, async (t) => {
  const s = await updateSetup(t);
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps, returnWait: quick([{ pid: 5151, mode: "daemon" }]) } });
  assert.equal(code, 0, s.lines.join("\n"));
  assert.ok(s.events.includes("restart"), "the service was started again through its manager");
  assert.ok(!s.events.includes("rollback"));
  assert.match(s.lines.at(-1), /working in the background again, on version 2\.0\.0/);
  assert.ok(!s.lines.some((line) => /start it again with `branch start`/.test(line)), "the owner is no longer told to do it themselves");
});

test("when the new version does not come up, the version before is put back and started", { skip: posixOnly }, async (t) => {
  const s = await updateSetup(t);
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps, returnWait: quick([{ pid: 4242 }]) } });
  assert.equal(code, 1);
  assert.ok(s.events.indexOf("rollback") > s.events.indexOf("restart"), "it went back only after the new version failed to come up");
  assert.match(s.lines.join("\n"), /did not come back up in the background, so Branch is going back to the version it had/);
});

test("a service manager that refuses the start goes straight to the way back", { skip: posixOnly }, async (t) => {
  const s = await updateSetup(t);
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps, restartService: async () => { throw new Error("no such unit"); }, returnWait: quick([]) } });
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
