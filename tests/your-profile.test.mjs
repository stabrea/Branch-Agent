/**
 * your-profile: each person's own name, picture and (the owner's) time zone (src/person-about.ts).
 * Only you change your own: a household person is refused the owner's and anybody else's, the owner is refused a
 * person's, and a short-lived key is refused all of them. A picture is a PNG, JPEG, WebP or GIF, checked by its bytes.
 * A scripted model; no provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { householdRefusal } from "../dist/household-routes.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };

async function open(root) {
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = (method, path, body, key = server.token) => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${key}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  return { app, server, call, close: async () => { await server.close(); await app.close(); } };
}

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-your-profile-"));
  let now = await open(root);
  t.after(async () => { await now.close(); await discardTemp(root); });
  const sam = (await now.call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  const kim = (await now.call("POST", "/api/profiles", { name: "Kim", pin: "1357" })).body;
  return {
    get call() { return now.call; }, get app() { return now.app; }, sam, kim,
    toSam: async () => assert.equal((await now.call("POST", "/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200),
    back: async () => assert.equal((await now.call("POST", "/api/profiles/switch", { profileId: null })).status, 200),
    restart: async () => { await now.close(); now = await open(root); },
  };
}

test("the owner names themselves, picks a face and a time zone, and every tile reads them, after a restart too", async (t) => {
  const f = await served(t);
  const before = (await f.call("GET", "/api/profiles")).body;
  assert.equal(before.owner.name, null, "nobody has asked the owner's name yet");
  assert.deepEqual(before.owner.avatar, { face: "initial", color: null, emoji: null, picture: null });
  const saved = await f.call("POST", "/api/profiles/owner/about", { name: "Robin", face: "emoji", emoji: "🦊", color: "#2f8c86", timezone: "Europe/Paris" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.name, "Robin");
  await f.restart();
  const after = (await f.call("GET", "/api/profiles")).body;
  assert.equal(after.owner.name, "Robin");
  assert.deepEqual(after.owner.avatar, { face: "emoji", color: "#2f8c86", emoji: "🦊", picture: null });
  assert.equal((await f.call("GET", "/api/profiles/owner/about")).body.timezone, "Europe/Paris");
  // Schedules proposed without a time zone are proposed in the owner's.
  const proposed = await f.call("POST", "/api/schedules/propose", { edit: { prompt: "Water the plants", dailyAt: "08:00" } });
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  assert.equal(proposed.body.proposal.schedule.timezone, "Europe/Paris");
  // A name can be forgotten again, and a wrong zone or face is refused.
  assert.equal((await f.call("POST", "/api/profiles/owner/about", { name: null })).body.name, null);
  assert.equal((await f.call("POST", "/api/profiles/owner/about", { timezone: "Mars/Olympus" })).status, 400);
  assert.equal((await f.call("POST", "/api/profiles/owner/about", { face: "photo" })).status, 400, "no photo to show yet");
  assert.equal((await f.call("POST", "/api/profiles/owner/about", { emoji: "hi" })).status, 400);
});

test("a picture goes through the engine: only real PNG, JPEG, WebP or GIF bytes, a quarter of a megabyte at most", async (t) => {
  const f = await served(t);
  const put = await f.call("POST", "/api/profiles/owner/picture", { picture: PNG });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.face, "photo");
  assert.ok(put.body.picture, "the stamp says a picture is there");
  assert.equal((await f.call("GET", "/api/profiles/owner/picture")).body.picture, PNG);
  assert.equal((await f.call("GET", "/api/profiles")).body.owner.avatar.face, "photo");
  const svg = `data:image/svg+xml;base64,${Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64")}`;
  assert.equal((await f.call("POST", "/api/profiles/owner/picture", { picture: svg })).status, 400);
  const lying = `data:image/jpeg;base64,${PNG.split(",")[1]}`;
  assert.equal((await f.call("POST", "/api/profiles/owner/picture", { picture: lying })).status, 400, "the bytes decide, not the label");
  const text = `data:image/png;base64,${Buffer.from("not a picture at all").toString("base64")}`;
  assert.equal((await f.call("POST", "/api/profiles/owner/picture", { picture: text })).status, 400);
  const big = Buffer.concat([Buffer.from(PNG.split(",")[1], "base64"), Buffer.alloc(300 * 1024)]);
  assert.notEqual((await f.call("POST", "/api/profiles/owner/picture", { picture: `data:image/png;base64,${big.toString("base64")}` })).status, 200);
  const removed = await f.call("POST", "/api/profiles/owner/picture/remove");
  assert.equal(removed.body.face, "initial");
  assert.equal((await f.call("GET", "/api/profiles/owner/picture")).body.picture, null);
});

test("a household person edits only their own profile, never the owner's or anybody else's", async (t) => {
  const f = await served(t);
  await f.toSam();
  // The owner's: the household sentence, at the one place src/server.ts answers it.
  for (const path of ["/api/profiles/owner/about", "/api/profiles/owner/picture", "/api/profiles/owner/picture/remove"]) {
    const answer = await f.call("POST", path, { name: "Mallory", picture: PNG });
    assert.equal(answer.status, 400, path);
    assert.equal(answer.body.error, householdRefusal, path);
  }
  // Somebody else's.
  for (const part of ["about", "picture", "picture/remove"]) {
    const answer = await f.call("POST", `/api/profiles/${f.kim.id}/${part}`, part === "about" ? { name: "Mallory" } : { picture: PNG });
    assert.equal(answer.status, 400, part);
    assert.match(answer.body.error, /Only that person can change their own profile/);
  }
  // Their own: a new name (never one somebody here has), a face and a picture.
  assert.match((await f.call("POST", `/api/profiles/${f.sam.id}/about`, { name: "kim" })).body.error, /already uses that name/);
  assert.equal((await f.call("POST", `/api/profiles/${f.sam.id}/about`, { name: null })).status, 400, "a person always has a name");
  assert.equal((await f.call("POST", `/api/profiles/${f.sam.id}/about`, { timezone: "Europe/Paris" })).status, 400, "the time zone is the owner's");
  const mine = await f.call("POST", `/api/profiles/${f.sam.id}/about`, { name: "Samira", face: "initial", color: "#d8612a" });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal((await f.call("POST", `/api/profiles/${f.sam.id}/picture`, { picture: PNG })).status, 200);
  const list = (await f.call("GET", "/api/profiles")).body;
  const me = list.profiles.find((p) => p.id === f.sam.id);
  assert.equal(me.name, "Samira");
  assert.equal(me.avatar.face, "photo");
  assert.equal(list.active.name, "Samira");
  assert.equal(list.owner.name, null, "the owner's profile is untouched");
  assert.equal(list.profiles.find((p) => p.id === f.kim.id).name, "Kim");
  // The owner, switched back, may not change Samira's either.
  await f.back();
  const theirs = await f.call("POST", `/api/profiles/${f.sam.id}/about`, { name: "Sam" });
  assert.match(theirs.body.error, /Only that person can change their own profile/);
  assert.equal((await f.call("POST", `/api/profiles/${f.sam.id}/picture/remove`)).status, 400);
  // Removing somebody takes their face and picture with them.
  assert.equal((await f.call("POST", `/api/profiles/${f.sam.id}/remove`)).body.removed, true);
  assert.equal((await f.call("GET", `/api/profiles/${f.sam.id}/picture`)).body.picture, null);
});

test("a short-lived key may read a profile but never change one", async (t) => {
  const f = await served(t);
  const made = await f.call("POST", "/api/tokens", { name: "script", scope: "read", minutes: 5 });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const key = made.body.token ?? made.body.key;
  assert.equal((await f.call("GET", "/api/profiles/owner/about", undefined, key)).status, 200);
  for (const path of ["/api/profiles/owner/about", "/api/profiles/owner/picture", `/api/profiles/${f.sam.id}/about`, `/api/profiles/${f.sam.id}/picture/remove`])
    assert.equal((await f.call("POST", path, { name: "Mallory" }, key)).status, 401, path);
});
