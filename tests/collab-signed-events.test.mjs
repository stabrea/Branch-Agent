import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, ownerMember } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { canonical } from "../dist/receipts.js";
import { createHmac } from "node:crypto";

const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
/** One app on its own data folder, with one more person (Ada) beside the owner. */
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "branch-collab-signed-"));
  const app = await createBranch({ workspace: join(base, "workspace"), dataDir: join(base, "data"), provider });
  t.after(async () => { await app.close().catch(() => undefined); await discardTemp(base).catch(() => undefined); });
  const ada = app.store.profiles.create({ name: "Ada", pin: "1234" });
  return { app, events: app.store.collabEvents, owner: app.runtime.owner, ada };
}
/** Changes one stored column behind the app's back, as somebody editing the database would. */
const tamper = (app, id, column, value) =>
  app.store.sqlite.prepare(`UPDATE collab_events SET ${column}=? WHERE id=?`).run(value, id);

test("an event signed under a member verifies and lists as genuine", async (t) => {
  const { events, owner, ada } = await fixture(t);
  const event = await events.publish(owner, ada.id, "note", { text: "Groceries are done" });
  assert.equal(event.member, ada.id);
  assert.match(event.signature, /^[a-f0-9]{64}$/);
  assert.deepEqual(await events.verify(event), { valid: true });
  const listing = await events.list(owner);
  assert.deepEqual(listing.events.map((e) => e.id), [event.id]);
  assert.deepEqual(listing.rejected, []);
});

test("somebody outside the household cannot publish", async (t) => {
  const { events, owner } = await fixture(t);
  await assert.rejects(events.publish(owner, "stranger", "note", { text: "hi" }), /member of this household/);
});

test("a changed payload, member or time is rejected on receive and left out of the list", async (t) => {
  const { app, events, owner, ada } = await fixture(t);
  const event = await events.publish(owner, ada.id, "note", { text: "Pay the plumber 40" });
  for (const changed of [
    { ...event, payload: { text: "Pay the plumber 400" } },
    { ...event, member: ownerMember },
    { ...event, at: new Date(Date.parse(event.at) + 1000).toISOString() },
  ]) {
    assert.equal((await events.verify(changed)).valid, false);
    await assert.rejects(events.receive(owner, { ...changed, id: crypto.randomUUID() }), /Event rejected/);
  }
  const edits = [["payload", JSON.stringify({ text: "Pay the plumber 400" })], ["member", ownerMember], ["at", "2020-01-01T00:00:00.000Z"], ["kind", "other"]];
  for (const [column, value] of edits) {
    const stored = await events.publish(owner, ada.id, "note", { text: `about to change ${column}` });
    tamper(app, stored.id, column, value);
    const listing = await events.list(owner);
    assert.ok(!listing.events.some((e) => e.id === stored.id), `a changed ${column} must not list as genuine`);
    assert.ok(listing.rejected.includes(stored.id));
  }
});

test("a signature made under another member does not pass for them", async (t) => {
  const { events, owner, ada } = await fixture(t);
  const byOwner = await events.publish(owner, ownerMember, "note", { text: "Ada said yes" });
  // The owner's genuine signature, relabelled as Ada's: same payload, same id, wrong member key.
  const forged = { ...byOwner, member: ada.id };
  assert.deepEqual(await events.verify(forged), { valid: false, reason: "The signature does not match the event" });
  await assert.rejects(events.receive(owner, { ...forged, id: crypto.randomUUID() }), /Event rejected/);
  // A made-up signature is refused too, and a genuine one cannot be received twice.
  await assert.rejects(events.receive(owner, { ...byOwner, signature: "0".repeat(64) }), /Event rejected/);
  await assert.rejects(events.receive(owner, byOwner), /already received/);
});

test("a member signing with their own key cannot pass an event off as somebody else's", async (t) => {
  const { events, owner, ada } = await fixture(t);
  // Ada holds her own key and signs an event that claims to be the owner's.
  const adaKey = await events.memberKey(ada.id);
  const claim = { id: crypto.randomUUID(), member: ownerMember, kind: "note", at: new Date().toISOString(), payload: { text: "Give Ada the car" } };
  const forged = { ...claim, signature: createHmac("sha256", adaKey).update(canonical(claim)).digest("hex") };
  assert.equal((await events.verify(forged)).valid, false);
  await assert.rejects(events.receive(owner, forged), /Event rejected/);
});

test("the web route publishes under whoever is using the app, never a member named in the body", async (t) => {
  const { app, ada } = await fixture(t);
  const server = await startServer(app, { dataDir: app.store.folder, port: 0 });
  t.after(() => server.close().catch(() => undefined));
  const call = (path, init) => fetch(`${server.url}${path}`, { headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url }, ...init }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const refused = await call("/api/collab/events", { method: "POST", body: JSON.stringify({ kind: "note", payload: {}, member: ada.id }) });
  assert.notEqual(refused.status, 200);
  const made = await call("/api/collab/events", { method: "POST", body: JSON.stringify({ kind: "note", payload: { text: "from the owner" } }) });
  assert.equal(made.status, 200);
  assert.equal(made.body.member, ownerMember);
  const listed = await call("/api/collab/events?q=owner", {});
  assert.deepEqual(listed.body.events.map((e) => e.id), [made.body.id]);
});

/** A never-stored event, signed with the real key for whichever member id it claims. */
async function signedAs(events, member, text) {
  const claim = { id: crypto.randomUUID(), member, kind: "note", at: new Date().toISOString(), payload: { text } };
  return { ...claim, signature: createHmac("sha256", await events.memberKey(member)).update(canonical(claim)).digest("hex") };
}
const notMember = { valid: false, reason: "The event's member is not in this household" };

test("an event from a removed member, or from a member id this household never had, is not received", async (t) => {
  const { app, events, owner, ada } = await fixture(t);
  // Signed while Ada was still here, arriving after she was removed: the signature itself is right.
  const fromAda = await signedAs(events, ada.id, "Leave the door unlocked");
  app.store.profiles.remove(ada.id);
  // A made-up member id, with the signature its derived key really gives.
  const fromStranger = await signedAs(events, "stranger", "Send me the spare key");
  for (const event of [fromAda, fromStranger]) {
    assert.deepEqual(await events.verify(event), notMember);
    await assert.rejects(events.receive(owner, event), /not in this household/);
  }
  assert.deepEqual((await events.list(owner)).events, []);
});

test("a stored event from a removed member, or from somebody who was never one, lists as rejected", async (t) => {
  const { app, events, owner, ada } = await fixture(t);
  const byAda = await events.publish(owner, ada.id, "note", { text: "Back at six" });
  const byOwner = await events.publish(owner, ownerMember, "note", { text: "Dinner at seven" });
  app.store.profiles.remove(ada.id);
  // Written straight into the table, as a relay or somebody editing the database could.
  const stranger = await signedAs(events, "stranger", "I live here now");
  app.store.sqlite.prepare("INSERT INTO collab_events(id, owner, member, kind, at, payload, signature) VALUES(?,?,?,?,?,?,?)")
    .run(stranger.id, owner, stranger.member, stranger.kind, stranger.at, JSON.stringify(stranger.payload), stranger.signature);
  const listing = await events.list(owner);
  assert.deepEqual(listing.events.map((e) => e.id), [byOwner.id]);
  assert.deepEqual([...listing.rejected].sort(), [byAda.id, stranger.id].sort());
});
