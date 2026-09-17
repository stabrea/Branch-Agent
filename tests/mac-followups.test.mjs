import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";

import { stopBackgroundEngine } from "../dist/install/background-engine.js";
import { readRunning, writeRunning } from "../dist/install/running.js";
import { daemonOptions, deploymentApi, engineScriptPath, startsBySelfWords } from "../dist/deployment-api.js";
import { installedAppRoot } from "../dist/desktop/install-root.js";
import { Updater } from "../dist/desktop/updater.js";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { appEntryName, checksumAssetName, releaseAssets } from "../dist/desktop/release-assets.js";

async function scratch(t) {
  const base = join(tmpdir(), "Codex-session-files");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "branch-mac-followups-"));
  t.after(() => discardTemp(root));
  return root;
}
const token = "b".repeat(64);
async function engineNote(root, pid, { url = "http://127.0.0.1:3210", mode = "daemon" } = {}) {
  await writeFile(join(root, "session-token"), token);
  await writeRunning(root, { port: 3210, pid, url, mode, version: "1.0.0" });
}
const noTaskkill = async (file) => { throw new Error(`taskkill must not run here: ${file}`); };

// ------------------------------------------------------- closing the background engine, Mac and Linux

for (const platform of ["darwin", "linux"]) {
  test(`${platform}: the engine is asked over its own address first, and no signal is sent when it goes`, async (t) => {
    const root = await scratch(t);
    await engineNote(root, 41414);
    const asked = [], kills = [];
    let living = true;
    const report = await stopBackgroundEngine(root, {
      platform, run: noTaskkill, alive: () => living, sleep: async () => {},
      kill: (pid, signal) => kills.push([pid, signal]),
      fetch: async (url, init) => { asked.push([url, init.method, init.headers.authorization]); living = false; return new Response("{}"); },
    });
    assert.deepEqual(asked, [["http://127.0.0.1:3210/api/deployment/close", "POST", `Bearer ${token}`]]);
    assert.deepEqual(kills, []);
    assert.deepEqual([report.pid, report.stopped, report.forced], [41414, true, false]);
    assert.equal(await readRunning(root), null, "the note is cleared");
  });

  test(`${platform}: a refusal leads to the stop signal, and a stubborn engine is ended outright`, async (t) => {
    const root = await scratch(t);
    await engineNote(root, 42424);
    const kills = [];
    let living = true;
    // The close door says no (an older engine), but the address still answers as Branch.
    const refused = async (url) => url.endsWith("/api/state")
      ? new Response(JSON.stringify({ version: "1.0.0" }))
      : new Response("{}", { status: 400 });
    const gentle = await stopBackgroundEngine(root, {
      platform, run: noTaskkill, alive: () => living, sleep: async () => {}, fetch: refused,
      kill: (pid, signal) => { kills.push([pid, signal]); living = false; },
    });
    assert.deepEqual(kills, [[42424, "SIGTERM"]]);
    assert.deepEqual([gentle.stopped, gentle.forced], [true, false]);

    await engineNote(root, 43434);
    kills.length = 0;
    living = true;
    const forced = await stopBackgroundEngine(root, {
      platform, run: noTaskkill, alive: () => living, sleep: async () => {}, waitMs: 0, fetch: refused,
      kill: (pid, signal) => { kills.push([pid, signal]); if (signal === "SIGKILL") living = false; },
    });
    assert.deepEqual(kills, [[43434, "SIGTERM"], [43434, "SIGKILL"]]);
    assert.deepEqual([forced.stopped, forced.forced], [true, true]);
  });

  test(`${platform}: an engine that never goes does not stop the update, and its note stays`, async (t) => {
    const root = await scratch(t);
    await engineNote(root, 44444);
    const report = await stopBackgroundEngine(root, {
      platform, alive: () => true, sleep: async () => {}, waitMs: 0,
      // A hung engine: nothing answers, but the system says that process runs the engine script.
      run: async (file, args) => { assert.deepEqual([file, args], ["/bin/ps", ["-p", "44444", "-o", "command="]]); return "/Applications/Branch Agent.app/Contents/MacOS/Branch Agent /Applications/Branch Agent.app/Contents/Resources/app/dist/cli.js start\n"; },
      fetch: async () => { throw new Error("no answer"); },
      kill: () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); },
    });
    assert.deepEqual([report.pid, report.stopped], [44444, false]);
    assert.match(report.message, /did not close in time/);
    assert.notEqual(await readRunning(root), null);
  });
}

test("a note left by a crash never gets another program's process signalled", async (t) => {
  const root = await scratch(t);
  await engineNote(root, 47474);
  const kills = [], asked = [];
  const report = await stopBackgroundEngine(root, {
    platform: "darwin", alive: () => true, sleep: async () => {}, waitMs: 0,
    fetch: async (url) => { asked.push(url); throw new Error("nothing is listening"); },
    run: async (file) => { assert.equal(file, "/bin/ps"); return "/usr/bin/vim notes.txt\n"; },
    kill: (pid, signal) => kills.push([pid, signal]),
  });
  assert.deepEqual(kills, [], "the reused process id is left alone");
  assert.deepEqual(asked, ["http://127.0.0.1:3210/api/deployment/close", "http://127.0.0.1:3210/api/state"]);
  assert.equal(report.pid, null, "the hand-over script is not told to wait for it or end it either");
  assert.equal(await readRunning(root), null, "the stale note is removed");
});

test("the key is never sent to an address that is not this computer's loopback", async (t) => {
  const root = await scratch(t);
  await engineNote(root, 45454, { url: "http://100.64.0.9:3210" });
  let fetched = false;
  let living = true;
  await stopBackgroundEngine(root, {
    platform: "linux", run: noTaskkill, alive: () => living, sleep: async () => {},
    fetch: async () => { fetched = true; return new Response("{}"); },
    kill: () => { living = false; },
  });
  assert.equal(fetched, false);
});

// ------------------------------------------------------------------ the engine's own close door

const fakeApp = { version: "1.0.0" };
function contextFor(root, overrides = {}) {
  return {
    dataDir: root, workspace: root, port: 3210, executable: null, installRoot: null,
    remote: { status: () => ({ enabled: false }) }, ...overrides,
  };
}
const request = (method, { key = token, local = "127.0.0.1" } = {}) =>
  ({ method, url: "/", headers: { authorization: `Bearer ${key}` }, socket: { localAddress: local } });
const call = (root, req, path, deps, context = contextFor(root), body = {}) =>
  deploymentApi(fakeApp, req, path, context, async () => body, () => {}, deps);

test("only this computer, with the master key, can close the engine, and only the background one", async (t) => {
  const root = await scratch(t);
  const signals = [];
  const deps = { platform: "darwin", signal: (pid, name) => signals.push([pid, name]) };
  await engineNote(root, process.pid);
  await assert.rejects(call(root, request("POST"), "/api/deployment/close", { ...deps, platform: "win32" }), /On Windows/);
  await assert.rejects(call(root, request("POST", { local: "100.64.0.9" }), "/api/deployment/close", deps), /Only the app on this computer/);
  await assert.rejects(call(root, request("POST", { key: "c".repeat(64) }), "/api/deployment/close", deps), /Only the app on this computer/);
  await assert.rejects(call(root, request("POST", { key: "short" }), "/api/deployment/close", deps), /Only the app on this computer/);
  await engineNote(root, process.pid, { mode: "app" });
  await assert.rejects(call(root, request("POST"), "/api/deployment/close", deps), /not the one working in the background/);
  await engineNote(root, 46464);
  await assert.rejects(call(root, request("POST"), "/api/deployment/close", deps), /not the one working in the background/);
  assert.deepEqual(signals, [], "nothing was closed by a refused ask");

  await engineNote(root, process.pid);
  const answer = await call(root, request("POST", { local: "::1" }), "/api/deployment/close", deps);
  assert.equal(answer.closing, true);
  assert.deepEqual(signals, [], "the answer goes out before the engine closes");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(signals, [[process.pid, "SIGTERM"]]);
});

test("a short-lived key is turned away from the close door by the server itself", async (t) => {
  const root = await scratch(t);
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  // No presence note is written, so even a mistake here could never signal this test process.
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); });
  for (const scope of ["read", "run"]) {
    const key = app.sessionTokens.create(app.runtime.owner, { scope, minutes: 5 });
    const answer = await fetch(`${server.url}/api/deployment/close`, { method: "POST", headers: { authorization: `Bearer ${key.token}` } });
    assert.equal(answer.status, 401, scope);
    assert.match((await answer.json()).error, /short-lived key cannot close Branch/, scope);
  }
  const pageAsk = await fetch(`${server.url}/api/deployment/close`, {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, origin: "http://evil.example" },
  });
  assert.equal(pageAsk.status, 403, "a web page elsewhere is refused before the key is even looked at");
});

// ------------------------------------------------------------- plain words for each kind of computer

test("the background and sign-in wording fits each computer, and Windows is unchanged", async (t) => {
  const root = await scratch(t);
  const expected = {
    win32: ["Branch Agent daemon", "Install Branch on this computer to keep it running with the window closed."],
    darwin: ["com.keepoak.branch-agent", /sign in to your Mac/],
    linux: ["branch-agent.service", /starts by itself when you sign in/],
  };
  for (const [platform, [taskName, message]] of Object.entries(expected)) {
    const overview = await call(root, request("GET"), "/api/deployment", { platform });
    assert.equal(overview.daemon.taskName, taskName);
    if (typeof message === "string") assert.equal(overview.daemon.message, message);
    else assert.match(overview.daemon.message, message);
    if (platform !== "win32") assert.ok(!/Windows|daemon|launchd|systemd/.test(overview.daemon.message), platform);
    const refused = call(root, request("POST"), "/api/deployment/autostart", { platform }, contextFor(root), { enabled: true });
    await assert.rejects(refused, new RegExp(`before it can ${startsBySelfWords(platform)}\\.$`));
  }
  assert.equal(startsBySelfWords("win32"), "start with Windows");
  assert.ok(!/Windows/.test(startsBySelfWords("darwin") + startsBySelfWords("linux")));
});

test("the engine script is found inside each kind of installed app", () => {
  assert.equal(engineScriptPath("win32", "C:\\Users\\pat\\AppData\\Local\\Programs\\Branch Agent"),
    "C:\\Users\\pat\\AppData\\Local\\Programs\\Branch Agent\\resources\\app\\dist\\cli.js");
  assert.equal(engineScriptPath("darwin", "/Applications/Branch Agent.app"),
    "/Applications/Branch Agent.app/Contents/Resources/app/dist/cli.js");
  assert.equal(engineScriptPath("linux", "/home/pat/Apps/Branch-Agent-linux-x64"),
    "/home/pat/Apps/Branch-Agent-linux-x64/resources/app/dist/cli.js");
  const mac = daemonOptions({
    dataDir: "/Users/pat/Library/Application Support/Branch Agent/data", workspace: "/Users/pat/Branch", port: 3210,
    executable: "/Applications/Branch Agent.app/Contents/MacOS/Branch Agent",
    installRoot: installedAppRoot(true, "darwin", "/Applications/Branch Agent.app/Contents/MacOS/Branch Agent"),
  }, "darwin");
  assert.equal(mac.script, "/Applications/Branch Agent.app/Contents/Resources/app/dist/cli.js");
  assert.throws(() => daemonOptions(contextFor("/x"), "darwin"), /has to be installed/);
});

// --------------------------------------------------------------- one answer to "where is Branch installed"

test("the install folder is worked out one way for the engine and the updater", () => {
  assert.equal(installedAppRoot(true, "win32", "C:\\Programs\\Branch Agent\\Branch Agent.exe"), "C:\\Programs\\Branch Agent");
  assert.equal(installedAppRoot(true, "darwin", "/Applications/Branch Agent.app/Contents/MacOS/Branch Agent"), "/Applications/Branch Agent.app");
  assert.equal(installedAppRoot(true, "darwin", "/Users/pat/Downloads/out/Branch Agent"), null, "a Mac copy outside an app bundle");
  assert.equal(installedAppRoot(true, "linux", "/opt/Branch-Agent-linux-x64/branch-agent"), "/opt/Branch-Agent-linux-x64");
  for (const platform of ["win32", "darwin", "linux"])
    assert.equal(installedAppRoot(false, platform, "/usr/local/bin/node"), null, `${platform} source checkout`);
});

test("a built Mac app outside an app bundle is not told it runs from source", () => {
  const base = { repo: "x/y", currentVersion: "1.0.0", executableName: "Branch Agent.app", scratchDir: "/tmp/none",
    assetName: "Branch-Agent-macos-arm64.zip", platform: "darwin", installDir: null };
  const loose = new Updater({ ...base, packaged: true });
  assert.equal(loose.status.phase, "unsupported");
  assert.match(loose.status.message, /Move Branch Agent into your Applications folder/);
  assert.ok(!/source/.test(loose.status.message));
  const source = new Updater(base);
  assert.match(source.status.message, /running from its source code/);
  const windows = new Updater({ ...base, platform: "win32", assetName: "Branch-Agent-windows-x64.zip", packaged: true });
  assert.equal(windows.status.message, "Updates apply to the installed app only.", "Windows wording is unchanged");
});

// ------------------------------------------------------------------ release notes use the same names

test("the release-notes draft takes every download name from the shared list", async () => {
  const { installSection } = await import("../scripts/release-notes.mjs");
  const text = installSection({ releaseAssets, checksumAssetName, appEntryName });
  for (const { name } of releaseAssets) assert.ok(text.includes(`\`${name}\``), name);
  assert.ok(text.includes(`\`${checksumAssetName(releaseAssetFor("win32"))}\``));
  for (const platform of ["win32", "darwin", "linux"]) assert.ok(text.includes(`\`${appEntryName(platform)}\``), platform);
  assert.throws(() => installSection({ releaseAssets: releaseAssets.slice(1), checksumAssetName, appEntryName }), /win32 x64/);
  const script = await readFile(new URL("../scripts/release-notes.mjs", import.meta.url), "utf8");
  assert.deepEqual(script.match(/Branch-Agent-[\w.-]+/g) ?? [], [], "no download name is written into the script by hand");
});
function releaseAssetFor(platform) {
  return releaseAssets.find((asset) => asset.platform === platform).name;
}
