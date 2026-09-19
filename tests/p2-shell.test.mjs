/* Redesign phase 2, shell (server side): a Trunk's look, the strip and 3D faces switches, and lending
   this computer to another Branch from the window — two real Branch servers on this computer's
   loopback address, the owner's yes on one, the other joined and connected, then leaving. Nothing is
   captured or run: every ability of the joined computer stays switched off. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { exportTrunk } from "../dist/trunks/share.js";

const scripted = { name: "scripted", async complete() { return { content: "Hello.", toolCalls: [] }; } };

async function branch(t, name) {
  const root = await mkdtemp(join(tmpdir(), `branch-p2-shell-${name}-`));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, token = server.token) => {
    const response = await fetch(new URL(path, server.url), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, server, call, root };
}
async function until(check, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await wait(100); }
  assert.fail(`timed out waiting for ${what}`);
}

test("the strip ships on and 3D faces ship off; only the owner at the window changes them", async (t) => {
  const b = await branch(t, "look");
  assert.deepEqual((await b.call("/api/shell-look")).body, { strip: "on", faces3d: "off" });
  assert.deepEqual((await b.call("/api/shell-look", { faces3d: "on" })).body, { strip: "on", faces3d: "on" });
  assert.equal((await b.call("/api/shell-look", { strip: "sometimes" })).status, 400, "only off or on");
  assert.equal((await b.call("/api/shell-look", { extra: true })).status, 400, "nothing else is kept");
  const key = b.app.sessionTokens.create(b.app.runtime.owner, { name: "script", scope: "run" }).token;
  assert.ok([401, 403].includes((await b.call("/api/shell-look", { strip: "off" }, key)).status), "a short-lived key cannot change it");
  const person = (await b.call("/api/profiles", { name: "Amara", pin: "4321" })).body;
  assert.equal((await b.call("/api/profiles/switch", { profileId: person.id, pin: "4321" })).status, 200);
  assert.equal((await b.call("/api/shell-look")).status, 200, "a household person may read what to draw");
  assert.equal((await b.call("/api/shell-look", { strip: "off" })).status, 400, "but not change it");
  await b.call("/api/profiles/switch", { profileId: null });
  assert.deepEqual((await b.call("/api/shell-look")).body, { strip: "on", faces3d: "on" });
});

test("a Trunk keeps its look: colour tokens only, a real emoji, and it travels in its file", async (t) => {
  const b = await branch(t, "trunk-look");
  await b.call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const { trunk } = (await b.call("/api/trunks", { name: "Ledger", title: "Keeps receipts", description: "" })).body;
  assert.equal(trunk.look, undefined, "a Trunk nobody restyled has no look and draws as before");
  const look = { face: "emoji", emoji: "📒", colour: 7, shape: "shield", motion: "pulse", depth: "3d" };
  const saved = (await b.call(`/api/trunks/${trunk.id}`, { look })).body.trunk;
  assert.deepEqual(saved.look, { ...look, letters: "", shuffle: 0 });
  assert.equal((await b.call(`/api/trunks/${trunk.id}`, { look: { colour: "#ff0000" } })).status, 400, "a colour is a token, never a value");
  assert.equal((await b.call(`/api/trunks/${trunk.id}`, { look: { face: "emoji", emoji: "<b>" } })).status, 400, "an emoji, not markup");
  assert.equal((await b.call(`/api/trunks/${trunk.id}`, { look: { shape: "star" } })).status, 400);
  assert.equal((await b.call(`/api/trunks/${trunk.id}`, { look: { colour: "theme", face: "letters", letters: "LG" } })).body.trunk.look.colour, "theme");
  assert.equal(exportTrunk(b.app.trunks.records.get(trunk.id)).trunk.look.letters, "LG", "the look goes with the Trunk's file");
  assert.equal((await b.call(`/api/trunks/${trunk.id}`, { order: 30, pinned: true })).body.trunk.order, 30, "the strip's order and pin are the Trunk's own");
});

test("another computer joins from its window: the owner's yes, connected, then it leaves", async (t) => {
  const host = await branch(t, "host");
  const guest = await branch(t, "guest");
  await host.call("/api/devices/mode", { mode: "when-needed" });
  const invite = (await host.call("/api/devices/invite", {})).body;
  assert.match(invite.link, /^http:\/\/127\.0\.0\.1:\d+\/devices\/pair\?offer=[a-f0-9]{32}$/);
  assert.equal((await guest.call("/api/devices/join")).body.state, "off", "nothing is lent until the owner joins");
  const started = await guest.call("/api/devices/join", { link: invite.link, code: invite.code, name: "Kitchen laptop" });
  assert.equal(started.status, 200);
  assert.equal(started.body.state, "waiting");
  const request = await until(async () => (await host.call("/api/devices")).body.requests.find((entry) => entry.name === "Kitchen laptop"), "the join request");
  assert.equal((await host.call(`/api/devices/requests/${request.id}`, { approve: true })).status, 200);
  const joined = await until(async () => { const now = (await guest.call("/api/devices/join")).body; return now.connected ? now : null; }, "the guest to connect");
  assert.equal(joined.state, "joined");
  assert.equal(joined.hub, new URL(host.server.url).origin);
  const device = await until(async () => (await host.call("/api/devices")).body.devices.find((entry) => entry.name === "Kitchen laptop" && entry.connected), "the host to see it connected");
  assert.deepEqual(device.enabled, [], "everything it could do starts off");
  assert.ok((await stat(join(guest.root, "data", "node", "identity.json"))).isFile(), "its key is kept in its own data folder");
  assert.equal((await host.call(`/api/devices/${device.id}/rename`, { name: "Kitchen" })).body.device.name, "Kitchen", "renaming a computer");
  assert.equal((await guest.call("/api/devices/join", { link: invite.link, code: invite.code })).status, 409, "one Branch at a time");
  assert.equal((await guest.call("/api/devices/join/leave", {})).body.state, "off");
  await until(async () => !(await host.call("/api/devices")).body.devices.find((entry) => entry.id === device.id).connected, "the host to see it go");
  await assert.rejects(stat(join(guest.root, "data", "node", "identity.json")), "leaving forgets the key");
});

test("joining is the owner's alone, refused under Lockdown, and a wrong number says so plainly", async (t) => {
  const host = await branch(t, "host2");
  const guest = await branch(t, "guest2");
  await host.call("/api/devices/mode", { mode: "when-needed" });
  const invite = (await host.call("/api/devices/invite", {})).body;
  const wrong = invite.code === "000000" ? "111111" : "000000";
  assert.equal((await guest.call("/api/devices/join", { link: invite.link, code: wrong })).body.state, "waiting");
  const failed = await until(async () => { const now = (await guest.call("/api/devices/join")).body; return now.state === "failed" ? now : null; }, "the refusal");
  assert.match(failed.message, /did not accept that invitation|could not be reached/);
  assert.equal((await guest.call("/api/devices/join", { link: "https://example.com/elsewhere", code: invite.code })).status, 400, "only a pairing link");
  assert.equal((await guest.call("/api/devices/join", { link: invite.link, code: "12" })).status, 400);
  const key = guest.app.sessionTokens.create(guest.app.runtime.owner, { name: "script", scope: "run" }).token;
  assert.equal((await guest.call("/api/devices/join", { link: invite.link, code: invite.code }, key)).status, 401, "a short-lived key cannot lend this computer");
  const person = (await guest.call("/api/profiles", { name: "Sam", pin: "1234" })).body;
  await guest.call("/api/profiles/switch", { profileId: person.id, pin: "1234" });
  assert.equal((await guest.call("/api/devices/join", { link: invite.link, code: invite.code })).status, 400, "nor may a household person");
  assert.equal((await guest.call("/api/devices/join")).status, 400);
  await guest.call("/api/profiles/switch", { profileId: null });
  await guest.call("/api/lockdown", { on: true });
  const locked = await guest.call("/api/devices/join", { link: invite.link, code: invite.code });
  assert.equal(locked.status, 409);
  assert.match(locked.body.error, /Lockdown/);
});
