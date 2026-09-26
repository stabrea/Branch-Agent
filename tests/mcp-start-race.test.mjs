/**
 * The owner's own MCP servers when the owner acts while one is still starting: switched off or removed, it ends with
 * nothing on, nothing running and no tools of it left; the same name added again asks the owner again; and on demand,
 * a connection still opening when its server is switched off is closed, so no program of it outlives Branch.
 * The server is a small stand-in on this computer that is slow to answer (tests/fixtures/mcp-slow-server.mjs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const slowServer = resolve("tests/fixtures/mcp-slow-server.mjs");
/** How long the stand-in waits before it answers: long enough for the owner's click to land while it starts. */
const delay = 1500;
/** Longer than a start already under way takes to finish: the program its tools are listed from, then the one that stays. */
const wouldHaveFinished = 2 * delay + 2500;

const pidsIn = async (file) => existsSync(file) ? (await readFile(file, "utf8")).split("\n").filter(Boolean).map(Number) : [];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stillRunning = async (file) => (await pidsIn(file)).filter(alive);
const until = async (check, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await sleep(50); }
  return false;
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-mcprace-"));
  await mkdir(join(root, "pids")); // outside the workspace, so no launch is refused for pointing into it
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  let closing;
  const close = () => (closing ??= (async () => { await server.close(); await app.close(); })());
  const pidfiles = [];
  t.after(async () => {
    await close();
    // Whatever a stand-in left running is ended here, so none outlives the test even when an assertion failed.
    for (const file of pidfiles) for (const pid of await pidsIn(file)) { try { process.kill(pid, "SIGKILL"); } catch { /* ended already */ } }
    await discardTemp(root);
  });
  const pidfile = (name) => { const file = join(root, "pids", `${name}.pid`); pidfiles.push(file); return file; };
  return { app, close, pidfile, url: server.url, token: server.token };
}
const api = (fx, path, body) => fetch(`${fx.url}${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { authorization: `Bearer ${fx.token}`, origin: fx.url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then(async (response) => {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "request failed");
  return data;
});
const toolsOf = (app, id) => app.registry.names().filter((name) => name.startsWith(`mcp.${id}.`));
const serverOf = async (fx, id) => (await api(fx, "/api/mcp/servers")).servers.find((server) => server.id === id);
const slow = (name, pidfile, wait = delay) => ({ name, server: { transport: "stdio", command: process.execPath,
  args: [slowServer, "--delay", String(wait), "--pidfile", pidfile] } });

/** Switches a server on and gives the owner's yes at the window. */
async function switchOn(fx, id) {
  await api(fx, `/api/mcp/servers/${id}/start`, {});
  const question = (await api(fx, "/api/policy")).waiting.find((q) => q.tool === "mcp.start" && q.target === id);
  assert.ok(question, "switching it on asks the owner");
  await api(fx, "/api/policy/approve", { sessionId: question.sessionId, decision: "allow", remember: "never", fingerprint: question.fingerprint });
}
/** Adds a slow server, says yes to it, and waits until that many of its programs have started. */
async function startSlowly(fx, name, pidfile, programs) {
  const { server: { id } } = await api(fx, "/api/mcp/servers", slow(name, pidfile));
  await switchOn(fx, id);
  assert.ok(await until(async () => (await pidsIn(pidfile)).length >= programs), "its program started");
  return id;
}
/** Every program of that server has ended, given a moment to. */
async function assertEnded(pidfile, message) {
  await until(async () => (await stillRunning(pidfile)).length === 0, 5000);
  assert.deepEqual(await stillRunning(pidfile), [], message);
}

test("a server switched off while it is still starting stays off, with no tools and no program running", async (t) => {
  const fx = await fixture(t);
  const pidfile = fx.pidfile("off");
  // Its first program is the one its tools are listed from: switched off while that is still under way.
  const id = await startSlowly(fx, "Slow off", pidfile, 1);
  const off = await api(fx, `/api/mcp/servers/${id}/stop`, {});
  assert.equal(off.said, "Slow off is off.");
  await sleep(wouldHaveFinished);
  const after = await serverOf(fx, id);
  assert.equal(after.on, false, "it stays off");
  assert.equal(after.running, false, "and is not running");
  assert.deepEqual(toolsOf(fx.app, id), [], "no tool of it is registered");
  await assertEnded(pidfile, "no program of it is left running");
});

test("a server removed while it is still starting is gone, with no tools and no program running", async (t) => {
  const fx = await fixture(t);
  const pidfile = fx.pidfile("removed");
  // Its second program is the one that would stay running: removed while that one is still starting.
  const id = await startSlowly(fx, "Slow remove", pidfile, 2);
  const removed = await api(fx, `/api/mcp/servers/${id}/remove`, {});
  assert.equal(removed.said, "Slow remove is removed.");
  await sleep(wouldHaveFinished);
  assert.equal(await serverOf(fx, id), undefined, "it is not listed");
  assert.deepEqual(toolsOf(fx.app, id), [], "no tool of it is registered");
  await assertEnded(pidfile, "no program of it is left running");
});

test("the same name added again after a remove during its start asks the owner before it is on", async (t) => {
  const fx = await fixture(t);
  const first = fx.pidfile("first");
  const id = await startSlowly(fx, "Slow again", first, 2);
  await api(fx, `/api/mcp/servers/${id}/remove`, {});
  await sleep(wouldHaveFinished);
  const second = fx.pidfile("second");
  const added = await api(fx, "/api/mcp/servers", slow("Slow again", second, 0));
  assert.equal(added.server.id, id, "the name is free again, so the same id is used");
  const turned = await api(fx, `/api/mcp/servers/${id}/start`, {});
  assert.match(turned.said, /Before I go ahead: Start a program on this computer/, "switching it on asks");
  assert.ok(turned.server.waiting, "and waits for the owner's answer");
  assert.equal(turned.server.running, false, "nothing of the removed server runs in its place");
  assert.deepEqual(toolsOf(fx.app, id), []);
  assert.equal(existsSync(second), false, "its own program has not started");
  await assertEnded(first, "no program of the removed server is left running");
});

test("on demand, a connection still opening when its server is switched off is closed, and nothing outlives Branch", async (t) => {
  const fx = await fixture(t);
  await api(fx, "/api/mcp/connections", { connect: "on-demand" });
  const pidfile = fx.pidfile("on-demand");
  const id = await startSlowly(fx, "Slow on demand", pidfile, 1);
  assert.ok(await until(() => toolsOf(fx.app, id).length === 2), "the first start connects once and notes its tools");
  // Off and on again: now its tools are listed from what it said last time, and it connects only when a task needs it.
  await api(fx, `/api/mcp/servers/${id}/stop`, {});
  await switchOn(fx, id);
  assert.ok(await until(async () => (await serverOf(fx, id)).running && toolsOf(fx.app, id).length === 2), "it is on again");
  await assertEnded(pidfile, "nothing of it is connected yet");
  const before = (await pidsIn(pidfile)).length;
  const opening = fx.app.mcpConnections.acquire("a-task", id).then(() => "connected", (error) => error.message);
  assert.ok(await until(async () => (await pidsIn(pidfile)).length > before), "a task's connection is opening");
  await api(fx, `/api/mcp/servers/${id}/stop`, {});
  const outcome = await opening; // the open that was under way has finished, one way or the other
  await fx.close();
  await assertEnded(pidfile, "no program of it outlives Branch");
  assert.notEqual(outcome, "connected", "the connection that was opening is not handed to the task");
});
