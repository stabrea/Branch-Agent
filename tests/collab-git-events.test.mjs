import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, ownerMember, publishGitPatch, gitPatchKind } from "../dist/index.js";
import { startServer } from "../dist/server.js";

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
