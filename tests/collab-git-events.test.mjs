import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, ownerMember, publishGitPatch, gitPatchKind } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { canonical } from "../dist/receipts.js";
import { createHmac } from "node:crypto";

const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
/** One app with two repositories (Branch projects) and one more person, Ada. */
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "branch-collab-git-"));
  const app = await createBranch({ workspace: join(base, "workspace"), dataDir: join(base, "data"), provider });
  t.after(async () => { await app.close().catch(() => undefined); await discardTemp(base).catch(() => undefined); });
  const owner = app.runtime.owner;
  for (const id of ["garden-app", "tax-tools"]) app.store.projects.save(owner, { id, name: id });
  const ada = app.store.profiles.create({ name: "Ada", pin: "1234" });
  const exists = (repository) => app.store.projects.list(owner).some((project) => project.id === repository);
  const publish = (member, input) => publishGitPatch(app.store.collabEvents, owner, member, input, exists);
  return { app, owner, ada, events: app.store.collabEvents, publish };
}
const status = (changed) => ({ branch: "main", head: "a".repeat(40), clean: false, changed });
const patch = (repository, title, body) => ({ repository, title, patch: `--- a/x\n+++ b/x\n@@\n+${body}\n`, status: status(["x"]) });

test("a patch event carries its repository and status, is found by search and verifies", async (t) => {
  const { owner, ada, events, publish } = await fixture(t);
  const made = await publish(ada.id, patch("garden-app", "Water the tomatoes", "watering schedule"));
  assert.equal(made.kind, gitPatchKind);
  assert.equal(made.member, ada.id);
  assert.equal(made.payload.repository, "garden-app");
  assert.deepEqual(made.payload.status, status(["x"]));
  assert.deepEqual(await events.verify(made), { valid: true });
  const found = await events.list(owner, { kind: gitPatchKind, repository: "garden-app", text: "watering" });
  assert.deepEqual(found.events.map((e) => e.id), [made.id]);
  assert.deepEqual((await events.list(owner, { repository: "garden-app", text: "nothing like this" })).events, []);
});

test("search by repository matches the linked repository, not a mention of it", async (t) => {
  const { owner, events, publish } = await fixture(t);
  const garden = await publish(ownerMember, patch("garden-app", "Garden fix", "one"));
  // A patch in another repository whose text names garden-app must not come back for garden-app.
  await publish(ownerMember, patch("tax-tools", "Port the garden-app helper", "garden-app"));
  const found = await events.list(owner, { repository: "garden-app" });
  assert.deepEqual(found.events.map((e) => e.id), [garden.id]);
});

test("an unknown repository or a malformed status is refused", async (t) => {
  const { publish } = await fixture(t);
  await assert.rejects(publish(ownerMember, patch("not-here", "x", "y")), /Repository not found/);
  await assert.rejects(publish(ownerMember, { ...patch("garden-app", "x", "y"), status: { branch: "main", head: "abc", clean: true, changed: [] } }));
});

test("moving a patch to another repository, or changing its status, breaks its signature", async (t) => {
  const { app, owner, events, publish } = await fixture(t);
  const made = await publish(ownerMember, patch("garden-app", "Garden fix", "one"));
  assert.equal((await events.verify({ ...made, payload: { ...made.payload, repository: "tax-tools" } })).valid, false);
  assert.equal((await events.verify({ ...made, payload: { ...made.payload, status: status(["y"]) } })).valid, false);
  app.store.sqlite.prepare("UPDATE collab_events SET payload=json_set(payload, '$.repository', 'tax-tools') WHERE id=?").run(made.id);
  const moved = await events.list(owner, { repository: "tax-tools" });
  assert.deepEqual(moved.events, []);
  assert.deepEqual(moved.rejected, [made.id]);
});

test("the web route publishes a patch under whoever is using the app and lists it by repository", async (t) => {
  const { app } = await fixture(t);
  const server = await startServer(app, { dataDir: app.store.folder, port: 0 });
  t.after(() => server.close().catch(() => undefined));
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url };
  const made = await fetch(`${server.url}/api/collab/git-patches`, { method: "POST", headers, body: JSON.stringify(patch("tax-tools", "Round up", "rounding")) });
  assert.equal(made.status, 200);
  const event = await made.json();
  assert.equal(event.member, ownerMember);
  const listed = await (await fetch(`${server.url}/api/collab/events?kind=git.patch&repository=tax-tools&q=rounding`, { headers })).json();
  assert.deepEqual(listed.events.map((e) => e.id), [event.id]);
});

test("the repository filter only returns patches, never another kind that names a repository", async (t) => {
  const { owner, events, publish } = await fixture(t);
  const garden = await publish(ownerMember, patch("garden-app", "Garden fix", "one"));
  // A note is free-form: a repository field in it is just text, not a link to the repository.
  const note = await events.publish(owner, ownerMember, "note", { repository: "garden-app", text: "Looked at the garden" });
  const found = await events.list(owner, { repository: "garden-app" });
  assert.deepEqual(found.events.map((e) => e.id), [garden.id]);
  assert.ok((await events.list(owner)).events.some((e) => e.id === note.id), "the note is still listed without the filter");
});

/** The app's web routes, called as the window calls them. */
async function web(t, app) {
  const server = await startServer(app, { dataDir: app.store.folder, port: 0 });
  t.after(() => server.close().catch(() => undefined));
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url };
  return (path, body) => fetch(`${server.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
}

test("the general events route refuses a patch and points to the patch route", async (t) => {
  const { app, owner, events } = await fixture(t);
  const post = await web(t, app);
  // Neither a well-formed patch nor a made-up one may skip the patch route's checks.
  for (const payload of [patch("garden-app", "Garden fix", "one"), { repository: "not-here", anything: true }]) {
    const refused = await post("/api/collab/events", { kind: gitPatchKind, payload });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /\/api\/collab\/git-patches/);
  }
  assert.deepEqual((await events.list(owner)).events, []);
  // Other kinds still go through.
  assert.equal((await post("/api/collab/events", { kind: "note", payload: { text: "hi" } })).status, 200);
});

test("a received patch must have the shape of a patch, even with a correct signature", async (t) => {
  const { app, owner, events } = await fixture(t);
  const post = await web(t, app);
  const key = await events.memberKey(ownerMember);
  const signed = (payload) => {
    const claim = { id: crypto.randomUUID(), member: ownerMember, kind: gitPatchKind, at: new Date().toISOString(), payload };
    return { ...claim, signature: createHmac("sha256", key).update(canonical(claim)).digest("hex") };
  };
  const bad = signed({ repository: "garden-app", title: "No patch or status here" });
  assert.deepEqual(await events.verify(bad), { valid: true });
  const refused = await post("/api/collab/events/receive", bad);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /not a valid git\.patch event/);
  const good = signed(patch("garden-app", "Garden fix", "one"));
  const kept = await post("/api/collab/events/receive", good);
  assert.equal(kept.status, 200);
  assert.deepEqual((await events.list(owner)).events.map((e) => e.id), [good.id]);
});

test("one patch row with an unreadable payload does not break the repository search for everyone", async (t) => {
  const { app, owner, events, publish } = await fixture(t);
  const garden = await publish(ownerMember, patch("garden-app", "Garden fix", "one"));
  const broken = await publish(ownerMember, patch("tax-tools", "Tax fix", "two"));
  /* Only an edit to the database itself can leave a patch row that is not JSON. */
  app.store.sqlite.prepare("UPDATE collab_events SET payload='{not json' WHERE id=?").run(broken.id);
  const found = await events.list(owner, { repository: "garden-app" });
  assert.deepEqual(found.events.map((e) => e.id), [garden.id]);
});

test("the patch route itself refuses a repository that is not one of the owner's projects", async (t) => {
  const { app, owner, events } = await fixture(t);
  const post = await web(t, app);
  const refused = await post("/api/collab/git-patches", patch("no-such-project", "Stray fix", "one"));
  assert.equal(refused.status, 400);
  assert.deepEqual((await events.list(owner)).events, [], "nothing was signed or stored");
  assert.equal((await post("/api/collab/git-patches", patch("garden-app", "Garden fix", "one"))).status, 200);
});
