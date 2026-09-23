/* Q44 (DG-107): which computer a Trunk starts in. The choices are this computer and the owner's paired
   computers only; an unknown id or a phone is refused before anything is saved; the choice outlives a
   restart; the start path hands a turn for another computer to the hop (a test double here) and never
   runs it here; and a record from before the setting, or an older build's edit, keeps working. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { trunksApi } from "../dist/trunks/api.js";
import { TrunkSchema } from "../dist/trunks/record.js";
import { TrunkFileSchema } from "../dist/trunks/share.js";
import { brain, on } from "./trunks-helpers.mjs";

const tower = "a1b2c3d4e5f60718";
const phone = "0f1e2d3c4b5a6978";
const device = (id, name, platform) => ({ id, name, platform, publicKey: "k".repeat(44), pairedAt: "2026-09-23T00:00:00.000Z",
  lastSeen: null, offers: [], enabled: [], folder: null, sharedWith: [] });

/** Pairs a computer and a phone straight into the device book, and checks the book really read them. */
function seedDevices(app, devices = [device(tower, "Tower", "linux"), device(phone, "Pixel", "android")]) {
  app.store.save("settings", app.runtime.owner, "devices-book", { mode: "on", devices, requests: [] });
  assert.equal(app.devices.book.devices().length, devices.length, "the seeded book is valid, so refusals are real");
}
async function open(dataDir, workspace, provider = brain()) {
  return createBranch({ workspace, dataDir, provider });
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-starts-in-"));
  const paths = { dataDir: join(root, "data"), workspace: join(root, "workspace") };
  const provider = brain();
  const app = await open(paths.dataDir, paths.workspace, provider);
  const state = { app };
  t.after(async () => { await state.app.close(); await discardTemp(root); });
  on(app);
  seedDevices(app);
  const trunk = app.trunks.create({ name: "Scout", title: "", description: "" });
  await app.trunks.introduced();
  return { app, provider, trunk, paths, state };
}
const post = (trunks, body) => ({ trunks, method: "POST", readBody: async () => body, person: null, requireOwner: () => undefined });

test("the choices are this computer and the paired computers; a phone is not one", async (t) => {
  const { app } = await fixture(t);
  assert.deepEqual(app.trunks.computers(), [{ id: tower, name: "Tower" }]);
});

test("where it starts is saved and survives a restart", async (t) => {
  const f = await fixture(t);
  assert.equal(f.app.trunks.edit(f.trunk.id, { startsIn: tower }).startsIn, tower);
  await f.app.close();
  f.state.app = await open(f.paths.dataDir, f.paths.workspace);
  assert.equal(f.state.app.trunks.records.get(f.trunk.id).startsIn, tower, "the same value after reloading");
  assert.equal(f.state.app.trunks.edit(f.trunk.id, { startsIn: null }).startsIn, null, "and back to this computer");
});

test("an unknown computer, or a phone, is refused with a 400 and nothing is saved", async (t) => {
  const { app, trunk } = await fixture(t);
  app.trunks.edit(trunk.id, { startsIn: tower });
  for (const id of ["ffffffffffffffff", phone]) {
    await assert.rejects(trunksApi(post(app.trunks, { startsIn: id }), `/api/trunks/${trunk.id}`),
      (error) => error.status === 400 && /not one of yours/.test(error.message), id);
    assert.equal(app.trunks.records.get(trunk.id).startsIn, tower, "the saved choice is untouched");
  }
  await assert.rejects(trunksApi(post(app.trunks, { startsIn: "not-a-computer" }), `/api/trunks/${trunk.id}`), (error) => error.status === 400);
  const before = app.trunks.records.list().length;
  await assert.rejects(trunksApi(post(app.trunks, { name: "Ghost", startsIn: "ffffffffffffffff" }), "/api/trunks"), (error) => error.status === 400);
  assert.equal(app.trunks.records.list().length, before, "no Trunk is made for an unknown computer");
  const made = await trunksApi(post(app.trunks, { name: "Far", startsIn: tower }), "/api/trunks");
  assert.equal(made.trunk.startsIn, tower, "a real computer can be chosen as it is made");
});

test("the start path hands a turn for another computer to the hop and never runs it here", async (t) => {
  const { app, provider, trunk } = await fixture(t);
  const asked = provider.requests.length;
  app.trunks.edit(trunk.id, { startsIn: tower });
  await assert.rejects(app.trunks.say(trunk.id, "hello"), (error) => error.status === 409 && /starts on Tower/.test(error.message),
    "with no hop wired it is refused in plain words");
  await assert.rejects(app.runtime.run({ prompt: "hello", sessionId: trunk.chatSessionId }), /starts on Tower/, "the window's path is refused too");
  const hops = [];
  app.trunks.startElsewhere = async (target, which, text) => { hops.push({ target, trunk: which.id, text }); return { status: "started" }; };
  assert.deepEqual(await app.trunks.say(trunk.id, "hello"), { status: "started" });
  assert.deepEqual(hops, [{ target: { id: tower, name: "Tower" }, trunk: trunk.id, text: "hello" }]);
  assert.equal(provider.requests.length, asked, "no model was asked here");
  app.trunks.edit(trunk.id, { startsIn: null });
  assert.equal((await app.trunks.say(trunk.id, "hello")).status, "completed", "this computer runs it here");
  assert.equal(hops.length, 1);
});

test("a message from another Trunk to one that starts elsewhere is refused up front, with no receipt", async (t) => {
  const { app, provider, trunk } = await fixture(t);
  on(app, "messages");
  const ann = app.trunks.create({ name: "Ann", title: "", description: "" });
  await app.trunks.introduced();
  const own = await app.runtime.run({ prompt: "hi", sessionId: ann.chatSessionId });
  const context = { ...app.runtime.context({ runId: own.id }), agent: `trunk:${ann.id}` };
  app.trunks.edit(trunk.id, { startsIn: tower });
  const receipts = app.trunks.messages.receipts().length, asked = provider.requests.length;
  assert.throws(() => app.trunks.messages.send(context, { to: "scout", message: "hello" }),
    (error) => error.status === 409 && /starts on Tower/.test(error.message), "the sender is told plainly");
  assert.equal(app.trunks.messages.receipts().length, receipts, "no receipt is left queued for ever");
  assert.deepEqual(app.runtime.queued(trunk.chatSessionId), [], "nothing waits in its conversation");
  assert.equal(provider.requests.length, asked, "nothing ran here");
  app.trunks.edit(trunk.id, { startsIn: null });
  assert.equal(app.trunks.messages.send(context, { to: "scout", message: "hello" }).queued, true, "this computer takes it");
});

test("a computer removed after it was chosen is refused, not swapped for this one", async (t) => {
  const { app, provider, trunk } = await fixture(t);
  app.trunks.edit(trunk.id, { startsIn: tower });
  seedDevices(app, [device(phone, "Pixel", "android")]);
  const asked = provider.requests.length;
  app.trunks.startElsewhere = async () => assert.fail("a removed computer is never started");
  await assert.rejects(app.trunks.say(trunk.id, "hello"), /no longer paired/);
  assert.equal(provider.requests.length, asked);
  assert.equal(app.trunks.edit(trunk.id, { title: "Still here" }).startsIn, tower, "other edits keep it without re-checking an unchanged value");
});

test("rollback: a record without the field loads, and an older build's edit keeps the field", async (t) => {
  const { app, trunk } = await fixture(t);
  const key = `trunk:${trunk.id}`, owner = app.runtime.owner;
  const stored = app.store.get("governance", owner, key).data;
  assert.equal("startsIn" in stored, false, "a Trunk made without a choice saves no field at all");
  assert.equal((await app.trunks.say(trunk.id, "hello")).status, "completed", "and starts here");
  app.trunks.edit(trunk.id, { startsIn: tower });
  // What an older build does on an edit: picks the fields its own strict schema knows, parses, lays them over the record.
  const Older = TrunkSchema.omit({ startsIn: true });
  const record = app.store.get("governance", owner, key).data;
  const known = Object.fromEntries(Object.keys(Older.shape).filter((k) => record[k] !== undefined).map((k) => [k, record[k]]));
  const edited = { ...record, ...Older.parse({ ...known, name: "Renamed" }) };
  app.store.save("governance", owner, key, edited);
  assert.equal(app.trunks.records.get(trunk.id).startsIn, tower, "the older build carried it over");
  assert.equal(app.trunks.records.get(trunk.id).name, "Renamed");
});

test("rollback: an exported Trunk never carries where it starts, so an older build reads the file", async (t) => {
  const { app, trunk } = await fixture(t);
  app.trunks.edit(trunk.id, { startsIn: tower });
  const file = app.trunks.exportFile(trunk.id);
  assert.equal("startsIn" in file.trunk, false);
  const olderFile = TrunkFileSchema.extend({ trunk: TrunkSchema.omit({ keys: true, reach: true, hidden: true, section: true, pinned: true, order: true, startsIn: true }) });
  assert.doesNotThrow(() => olderFile.parse(JSON.parse(JSON.stringify(file))));
});
