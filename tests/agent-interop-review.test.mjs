import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/* Integration review of mac4/bucket-20 (src/interop/): the holes the adversarial pass found. */
const say = (content) => ({ content, toolCalls: [] });

async function fixture(t, { server = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-interop-review-"));
  const provider = { name: "scripted", async complete() { return say("ok"); } };
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }],
  });
  const started = server ? await startServer(app, { dataDir: join(root, "data"), port: 0 }) : null;
  t.after(async () => { await started?.close(); await app.close(); await discardTemp(root); });
  const http = (path, { key = started?.token, body } = {}) => fetch(started.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const on = (part, mode = "when-needed") => app.interop.setMode(part, { mode });
  return { app, root, http, on, owner: app.runtime.owner, server: started };
}
const contextFor = (app, permissions) => {
  const run = app.store.createRun(app.runtime.owner, "a task");
  return app.runtime.context({ runId: run.id, ...(permissions ? { permissions } : {}) });
};

test("A0421 review: a drafted flow may only ask and branch; a tool, map or sub-flow box is refused untried", async () => {
  const { scoreDraft } = await import("../dist/interop/flow-search.js");
  let tried = 0;
  const parts = { ask: async () => "", tryFlow: async () => { tried++; return { status: "completed", state: { answer: "x" } }; }, save: () => ({}) };
  const draft = {
    name: "sneaky", input: { topic: "text" }, state: { topic: "text", answer: "text" }, entry: "a",
    nodes: [{ id: "a", name: "a", kind: "tool", tool: "shell.execute", args: { executable: "rm" }, input: {}, output: { answer: "text" } }],
    edges: [],
  };
  const scored = await scoreDraft(parts, draft, [{ input: { topic: "x" }, expect: "x" }]);
  assert.equal(scored.score, 0);
  assert.equal(scored.definition, null);
  assert.match(scored.problems.join(" "), /only ask|tool/i);
  assert.equal(tried, 0, "a draft that could use a tool is never run");
  const box = (id) => ({ id, name: id, kind: "prompt", input: { topic: "text" }, output: { answer: "text" }, prompt: "{topic}" });
  const big = { name: "big", input: { topic: "text" }, state: { topic: "text", answer: "text" }, entry: "n0",
    nodes: Array.from({ length: 12 }, (_, i) => box(`n${i}`)), edges: Array.from({ length: 11 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })) };
  const large = await scoreDraft(parts, big, [{ input: { topic: "x" }, expect: "x" }]);
  assert.equal(large.definition, null, "a draft with too many boxes is not tried");
  assert.equal(tried, 0);
});

test("A0421 review: the model's flow.search cannot save a flow; only the owner can", async (t) => {
  const f = await fixture(t);
  f.on("flow-search");
  const args = { goal: "g", examples: [{ input: { topic: "x" }, expect: "x" }], save: true };
  await assert.rejects(f.app.registry.execute("flow.search", args, contextFor(f.app)));
});

test("review: a short-lived key cannot switch the project, run a flow search or stop the fleet", async (t) => {
  const f = await fixture(t, { server: true });
  f.on("project-routing"); f.on("flow-search"); f.on("fleet");
  f.app.store.projects.save(f.owner, { id: "garden", name: "Garden plans" });
  const key = f.app.sessionTokens.create(f.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const route = await f.http("/api/interop/route", { key, body: { request: "the garden plans", switch: true } });
  assert.equal(route.status, 401);
  assert.equal(f.app.store.projects.active(f.owner).id, "default");
  assert.equal((await f.http("/api/interop/flow-search", { key, body: { goal: "g", examples: [{ input: {}, expect: "x" }], save: true } })).status, 401);
  assert.equal((await f.http("/api/interop/fleet/stop", { key, body: { scope: "everything" } })).status, 401);
  // Looking is still fine for that key.
  assert.equal((await f.http("/api/interop", { key })).status, 200);
});

test("A0429 review: a .branch folder that is a link out of an untrusted workspace brings no modes", async (t) => {
  const f = await fixture(t);
  f.on("modes");
  const { saveFolderTrustSettings, decideFolder } = await import("../dist/folder-trust.js");
  const elsewhere = join(f.root, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  await writeFile(join(elsewhere, "modes.json"), JSON.stringify({ modes: [{ slug: "ask", name: "Ask", role: "Change anything." }] }));
  await mkdir(f.app.runtime.workspace, { recursive: true });
  await symlink(elsewhere, join(f.app.runtime.workspace, ".branch"), "dir");
  saveFolderTrustSettings(f.app.store, f.owner, { mode: "on" });
  decideFolder(f.app.store, f.owner, f.app.runtime.workspace, { folder: "", decision: "distrust" });
  assert.ok(!f.app.interop.modes.list().some((m) => m.origin === "this folder"), "the link does not escape the folder's trust");
  assert.equal(f.app.interop.modes.find("ask").readOnly, true);
});

test("client-tools review: every lent call asks under Ask before changes, and a lent tool files in a known box", async (t) => {
  const f = await fixture(t);
  f.on("client-tools");
  const sent = [];
  const connection = f.app.interop.clients.open({ send: (v) => sent.push(v), close: () => undefined });
  connection.receive(JSON.stringify({ type: "hello", client: "editor", tools: [{ name: "open_file", description: "Open a file" }] }));
  assert.deepEqual(sent.at(-1), { type: "ready", tools: ["client.editor.open_file"] });
  const { savePolicy } = await import("../dist/policy.js");
  savePolicy(f.app.store, f.owner, { preset: "ask-before-changes" });
  const context = contextFor(f.app);
  const first = f.app.runtime.checkPolicy("client.editor.open_file", { path: "a.md" }, context, "fp-a");
  assert.equal(first.decision, "ask");
  assert.equal(first.readOnly, false);
  const { inferToolGroup } = await import("../dist/catalog.js");
  assert.notEqual(inferToolGroup("client.editor.open_file"), "other");
  for (const name of ["mode.task", "fleet.stop", "assistant.market", "project.route", "conversation.handoff", "flow.search"])
    assert.notEqual(inferToolGroup(name), "other", `${name} has no toolbox in src/catalog.ts`);
  connection.closed();
  assert.equal(f.app.registry.permissionOf("client.editor.open_file"), "");
});

test("client-tools review: only a few programs may lend tools at once", async (t) => {
  const f = await fixture(t);
  f.on("client-tools");
  const answers = [];
  for (let i = 0; i < 12; i++) {
    const sent = [];
    const c = f.app.interop.clients.open({ send: (v) => sent.push(v), close: () => undefined });
    c.receive(JSON.stringify({ type: "hello", client: `prog-${i}`, tools: [{ name: "t", description: "d" }] }));
    answers.push(sent.at(-1).type);
  }
  assert.equal(answers.filter((a) => a === "ready").length, 8);
  assert.equal(f.app.interop.clients.list().length, 8);
  assert.equal(answers.at(-1), "error");
});

test("A1857 review: a market that sends too much is cut off while reading, and an import never replaces your own specialist", async (t) => {
  const f = await fixture(t);
  const { AgentMarket } = await import("../dist/interop/agent-market.js");
  f.on("agent-market");
  let pulled = 0;
  const endless = () => new Response(new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(64 * 1024)); } }));
  const policy = { assertAllowed: async () => undefined };
  const flood = new AgentMarket(f.app.store, f.owner, policy, f.app.files, "test", async () => endless());
  await assert.rejects(flood.browse("https://example.test/market.json"), /more than/);
  assert.ok(pulled < 20, `stopped reading early (${pulled} chunks)`);

  // A publisher's specialist with the same id as one of yours is left out.
  f.app.store.save("specialists", f.owner, "writer-1", { name: "writer", marker: "from the publisher" });
  f.app.store.save("specialists", f.owner, "fresh-1", { name: "fresh", marker: "new one" });
  const published = await f.app.interop.market.publish({ folder: "market", id: "helper", name: "Helper" });
  const folder = join(f.app.runtime.workspace, "market");
  const bytes = await readFile(join(folder, "helper.branch-agent"));
  const index = await readFile(join(folder, "market.json"));
  assert.ok(published.entry.sha256);
  const g = await fixture(t);
  g.on("agent-market");
  g.app.store.save("specialists", g.owner, "writer-1", { name: "writer", marker: "mine" });
  const serve = async (url) => new Response(new URL(url).pathname.endsWith("market.json") ? index : bytes);
  const market = new AgentMarket(g.app.store, g.owner, policy, g.app.files, "test", serve);
  const installed = await market.install("https://example.test/market.json", "helper", ["specialists"]);
  assert.equal(g.app.store.get("specialists", g.owner, "writer-1").data.marker, "mine", "your own specialist is kept");
  assert.equal(g.app.store.get("specialists", g.owner, "fresh-1").data.marker, "new one");
  assert.match(JSON.stringify(installed.reports), /kept yours|already/i);
});

test("agent-protocol review: no route runs without the key, and a short-lived look-only key cannot start a step", async (t) => {
  const f = await fixture(t, { server: true });
  f.on("agent-protocol"); f.on("client-tools");
  assert.equal((await f.http("/ap/v1/agent/tasks", { key: "", body: { input: "hi" } })).status, 401);
  assert.equal((await f.http("/ap/v1/agent/tasks", { key: "wrong", body: { input: "hi" } })).status, 401);
  const created = await (await f.http("/ap/v1/agent/tasks", { body: { input: "hi" } })).json();
  const look = f.app.sessionTokens.create(f.owner, { name: "look", scope: "read", minutes: 5 }).token;
  assert.equal((await f.http(`/ap/v1/agent/tasks/${created.task_id}/steps`, { key: look, body: {} })).status, 401);
  assert.equal(f.app.store.runs(f.owner).length, 0, "no task ran");
  const big = await fetch(`${f.server.url}/ap/v1/agent/tasks`, { method: "POST",
    headers: { authorization: `Bearer ${f.server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ input: "x".repeat(200000) }) });
  assert.ok(big.status >= 400 && big.status < 500, `an oversized body is refused (${big.status})`);
  // The lending socket wants the master key, not a short-lived one.
  const address = f.server.url.replace("http", "ws") + "/api/interop/client-tools/ws";
  for (const protocols of [[], ["bearer", look]]) {
    const socket = new WebSocket(address, protocols);
    const opened = await new Promise((resolve) => { socket.onopen = () => resolve(true); socket.onerror = () => resolve(false); });
    assert.equal(opened, false);
  }
});
