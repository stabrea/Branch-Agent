/**
 * profile-audit: the app window switched to a household profile is that person.
 *
 * Every route tests/short-lived-key-routes.mjs calls "owner" (and every read it calls a secret) is
 * driven here with the window switched to somebody else's profile, and must meet the one sentence
 * src/server.ts answers at one place. The owner, switched back, must never meet it. A route added
 * later has to be put in that table first (tests/short-lived-keys.test.mjs fails until it is), and
 * then this file decides for it: "owner" is refused here without anybody writing a check, and
 * "other" fails here until src/household-routes.ts lists it as a person's own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer, offLimitsToHousehold, offLimitsToShortLivedKeys } from "../dist/server.js";
import { householdOwnRoutes, householdRefusal, householdRefusalFor } from "../dist/household-routes.js";
import { runOrigin } from "../dist/key-context.js";
import { removalGuard, removePersonRefusal } from "../dist/remove-branch.js";
import { ROUTES, SAMPLE_ID, entry } from "./short-lived-key-routes.mjs";

const concrete = (path) => path.replaceAll(":id", SAMPLE_ID);
const rows = Object.entries(ROUTES).map(([path, value]) => ({ path, ...entry(value) }));
/** The two ways out of a profile: they are "owner" rows, and a household person must still reach them. */
const WAYS_OUT = new Set(["POST /api/profiles/switch", "POST /api/lock"]);
/** Reads a short-lived key is refused that answer a household person with a thinned view of their own. */
const VIEWS = new Set(["/api/voice/wake", "/api/voice/dictation", "/api/voice/dictation/listen"]);
/** Asked of the owner only through the rule, never over HTTP: they quit, restart, restore or remove Branch. */
const NOT_PRESSED_AS_OWNER = /quit|close|restart|remove-branch|restore|daemon|autostart|updates?\//;

/** Every change and secret read the table gives to the owner alone, as "METHOD path". */
function ownerOnly() {
  const found = [];
  for (const { path, kind, methods } of rows) {
    if (kind === "owner") for (const method of methods) found.push({ method, path });
    if (kind === "secret-read" && !VIEWS.has(path)) found.push({ method: "GET", path });
  }
  return found.filter(({ method, path }) => !WAYS_OUT.has(`${method} ${path}`));
}

test("the rule: every owner-only route in the table is refused to a household profile, in one sentence", () => {
  const through = ownerOnly().filter(({ method, path }) => offLimitsToHousehold(method, concrete(path)) !== householdRefusalFor(path))
    .map(({ method, path }) => `${method} ${path}`);
  assert.deepEqual(through, [], "these owner-only routes are open to a household profile");
  for (const way of WAYS_OUT) {
    const [method, path] = way.split(" ");
    assert.equal(offLimitsToHousehold(method, path), null, `${way} is how a household person gets out`);
  }
  // A route nobody has written yet is the owner's too: the rule fails closed.
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(offLimitsToHousehold(method, "/api/some-new-settings"), householdRefusal);
});

test("the rule: a household person keeps their own things, the task routes and every plain read", () => {
  const refused = [];
  for (const { path, kind, methods } of rows) {
    const at = concrete(path);
    if (kind === "other" || kind === "task") for (const method of methods)
      if (offLimitsToHousehold(method, at) !== null && (kind === "other" || offLimitsToShortLivedKeys(method, at) === null))
        refused.push(`${method} ${path} (${kind})`);
    if (kind === "look" && offLimitsToHousehold("GET", at) !== null) refused.push(`GET ${path} (look)`);
  }
  for (const path of VIEWS) if (offLimitsToHousehold("GET", path) !== null) refused.push(`GET ${path} (view)`);
  assert.deepEqual(refused, [], "a household person's own things are refused; list them in src/household-routes.ts");
});

test("the list: nothing in src/household-routes.ts is an owner-only route, and nothing in it is stale", () => {
  const owners = ownerOnly();
  for (const route of householdOwnRoutes) {
    const theirs = rows.filter(({ path, kind, methods }) => route.pattern.test(concrete(path)) && methods.includes(route.method)
      && (kind === "other" || WAYS_OUT.has(`${route.method} ${path}`)));
    assert.ok(theirs.length, `${route.method} ${route.pattern} matches no "other" row in the table`);
    const owner = owners.find(({ method, path }) => method === route.method && route.pattern.test(concrete(path)));
    assert.equal(owner, undefined, `${route.method} ${route.pattern} lets a household person reach an owner-only route`);
  }
});

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-household-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, body) => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${server.token}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const sam = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  const toSam = async () => assert.equal((await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  const back = async () => assert.equal((await call("POST", "/api/profiles/switch", { profileId: null })).status, 200);
  return { app, call, sam, toSam, back };
}

test("generated over HTTP: the window switched to a household profile meets the one sentence on every owner-only route", async (t) => {
  const { app, call, toSam, back } = await served(t);
  await toSam();
  const through = [];
  for (const { method, path } of ownerOnly()) {
    const answer = await call(method, concrete(path));
    if (answer.status !== 400 || answer.body.error !== householdRefusalFor(path)) through.push(`${method} ${path} → ${answer.status} ${answer.body.error ?? ""}`.slice(0, 160));
  }
  assert.deepEqual(through, [], "a household profile got through");
  assert.equal(app.store.profiles.isOwner(), false, "something switched the window back on the way");
  // The way out still works, with no PIN, and locking the window is still theirs.
  assert.equal((await call("POST", "/api/lock")).status, 200);
  await back();
  assert.equal(app.store.profiles.isOwner(), true);
});

test("generated over HTTP: the owner, switched back, never meets the household sentence", async (t) => {
  const { call, toSam, back } = await served(t);
  await toSam();
  await back();
  const refused = [];
  for (const { method, path } of ownerOnly()) {
    if (NOT_PRESSED_AS_OWNER.test(path)) continue;
    const answer = await call(method, concrete(path));
    if (/belongs to the owner/.test(answer.body.error ?? "")) refused.push(`${method} ${path}`);
  }
  assert.deepEqual(refused, [], "the owner was refused their own routes");
});

test("a task the window starts for a household profile is written down as theirs, and removing Branch refuses it", async (t) => {
  const { app, call, sam, toSam, back } = await served(t);
  await toSam();
  const started = await call("POST", "/api/run", { prompt: "say hello" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await back();
  // Switching back does not make Sam's task the owner's: tools that ask where a task came from see Sam.
  assert.equal(runOrigin(app.store, started.body.id).personProfileId, sam.id);
  assert.equal(removalGuard(app.store, { runId: started.body.id }), removePersonRefusal);
  // The owner's own task is nobody else's.
  const own = await call("POST", "/api/run", { prompt: "say hello" });
  assert.equal(runOrigin(app.store, own.body.id).personProfileId, null);
  assert.equal(removalGuard(app.store, { source: "owner" }), null);
  // The window's switch, handed to the removal guard the way the server hands it, refuses.
  assert.equal(removalGuard(app.store, { source: "owner", person: sam.id }), removePersonRefusal);
});
