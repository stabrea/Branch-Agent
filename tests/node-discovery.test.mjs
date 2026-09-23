/**
 * R17-interop/node-discovery: one listing of tools, skills and models, each tagged with the host that
 * owns it — this computer, a program lending tools, a paired device, or an assistant elsewhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { nodeCatalog } from "../dist/interop/node-discovery.js";
import { offeredOn } from "../dist/devices/capabilities.js";

const scripted = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
const skillDoc = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`;

function deviceKey() {
  const pair = generateKeyPairSync("ed25519");
  return { publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    sign: (text) => sign(null, Buffer.from(text), pair.privateKey).toString("base64") };
}
function pairOne(book, name, platform = "darwin") {
  const key = deviceKey();
  const offer = book.invite();
  const { requestId } = book.redeem({ offer: offer.id, code: offer.code, name, platform, publicKey: key.publicKey, offers: offeredOn(platform) });
  return book.device(book.decide(requestId, true).deviceId);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-node-discovery-"));
  const dataDir = join(root, "data");
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir, provider: scripted,
    presets: [{ id: "alpha", name: "Alpha", provider: scripted, model: "a-model" }],
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, owner: app.runtime.owner, dataDir };
}

test("nodes.catalog is out of the tool catalog while its switch is off, and in it once switched on", async (t) => {
  const { app } = await fixture(t);
  assert.equal(app.registry.permissionOf("nodes.catalog"), "");
  app.interop.setMode("node-discovery", { mode: "on" });
  assert.equal(app.registry.permissionOf("nodes.catalog"), "specialists.read");
  app.interop.setMode("node-discovery", { mode: "off" });
  assert.equal(app.registry.permissionOf("nodes.catalog"), "");
});

test("one listing names every tool, skill and model connection, each tagged with the host that owns it", async (t) => {
  const { app, owner } = await fixture(t);

  // This computer: an ordinary tool, an installed skill, and the one model connection.
  app.store.skills.install(owner, { document: skillDoc("garden-planner", "Plan a vegetable garden by season.") });

  // A program on this computer lending a tool over the socket.
  app.interop.setMode("client-tools", { mode: "on" });
  const sent = [];
  const connection = app.interop.clients.open({ send: (value) => sent.push(value), close() {} });
  connection.receive(JSON.stringify({ type: "hello", client: "my-editor", tools: [{ name: "open_file", description: "Opens a file in the editor" }] }));
  assert.equal(sent.at(-1).type, "ready");

  // A device paired with this computer, with one capability switched on.
  app.devices.book.setMode({ mode: "on" });
  const device = pairOne(app.devices.book, "Kitchen Mac");
  app.devices.book.setSwitch(device.id, "notify", true);

  // An assistant elsewhere, added the way `agents.remote add` would save it (no network call here).
  const agentId = randomUUID();
  app.store.save("settings", owner, `remote-agent:${agentId}`, {
    id: agentId, name: "Ada", description: "A helper elsewhere", cardUrl: "https://ada.example/.well-known/agent.json",
    url: "https://ada.example/a2a", skills: ["translate"], addedAt: new Date().toISOString(),
  });

  const catalog = nodeCatalog({ runtime: app.runtime, remoteAgents: app.remoteAgents });

  const byHost = (host) => catalog.items.filter((item) => item.host === host);
  const here = byHost("This computer");
  assert.ok(here.some((item) => item.kind === "tool" && item.name === "files.write"), "a core tool is tagged as this computer's");
  assert.ok(here.some((item) => item.kind === "skill" && item.name === "garden-planner"), "the installed skill is tagged as this computer's");
  assert.ok(here.some((item) => item.kind === "inference" && item.name === "Alpha"), "the model connection is tagged as this computer's");
  assert.ok(!here.some((item) => item.name.startsWith("client.") || item.name.startsWith("device.")), "a lent tool and a device capability are not counted as this computer's");

  const editor = byHost("my-editor");
  assert.deepEqual(editor.map((item) => [item.kind, item.name]), [["tool", "client.my-editor.open_file"]]);
  assert.equal(editor[0].description, "Opens a file in the editor (lent by my-editor)");

  const kitchen = byHost("Kitchen Mac");
  assert.deepEqual(kitchen.map((item) => [item.kind, item.name]), [["tool", "device.notify"]]);

  const ada = byHost("Ada");
  assert.deepEqual(ada.map((item) => [item.kind, item.name]), [["skill", "translate"]]);

  const summary = Object.fromEntries(catalog.hosts.map((h) => [h.host, h]));
  assert.equal(summary["my-editor"].hostKind, "program");
  assert.equal(summary["Kitchen Mac"].hostKind, "device");
  assert.equal(summary["Ada"].hostKind, "assistant");
  assert.equal(summary["This computer"].hostKind, "this-computer");
  assert.match(catalog.summary, /This computer/);

  // Switching devices off, or disconnecting the program, drops that host from the listing.
  connection.closed();
  app.devices.book.setMode({ mode: "off" });
  const after = nodeCatalog({ runtime: app.runtime, remoteAgents: app.remoteAgents });
  assert.equal(after.items.some((item) => item.host === "my-editor"), false);
  assert.equal(after.items.some((item) => item.host === "Kitchen Mac"), false);
  assert.ok(after.items.some((item) => item.host === "Ada"), "an assistant elsewhere is not affected by this computer's own switches");
});

test("the owner's route answers with the catalog only once node-discovery is switched on", async (t) => {
  const { app, dataDir } = await fixture(t);
  const { startServer } = await import("../dist/server.js");
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); });
  const get = (path) => fetch(server.url + path, { headers: { authorization: `Bearer ${server.token}` } });
  const off = await get("/api/interop/nodes");
  assert.equal(off.status, 409);
  app.interop.setMode("node-discovery", { mode: "on" });
  const on = await get("/api/interop/nodes");
  assert.equal(on.status, 200);
  const body = await on.json();
  assert.ok(body.items.some((item) => item.host === "This computer"));
  assert.ok(Array.isArray(body.hosts));
});
