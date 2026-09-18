/**
 * mac7/bind: where Branch's own door listens.
 *
 * The default is the whole point of this branch, so it is the first thing checked: an install that
 * says nothing listens on 127.0.0.1 and nowhere else, exactly as every version before it. Then the
 * refusals — Lockdown, a computer with a public address, no local key — then the wider door itself,
 * which still asks every caller for the local key, and then who may move it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer, hostAllowed, offLimitsToShortLivedKeys } from "../dist/server.js";
import {
  decideListen, fromThisComputer, listenAsked, listenChangeRefusal, listenEnvName, listenKey,
  listenSettings, saveListenSettings,
} from "../dist/listen-address.js";
import { setLockdown } from "../dist/lockdown.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { asPerson } from "../dist/people/context.js";
import { settingsCatalogue } from "../dist/settings-kit/catalogue.js";
import { ROUTES } from "./short-lived-key-routes.mjs";

const key = "a".repeat(64);
const privateHome = [{ address: "127.0.0.1", internal: true }, { address: "192.168.1.40", internal: false }];

async function fixture(t, { where, lockdown } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-bind-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  if (where) saveListenSettings(app.store, app.runtime.owner, { where });
  if (lockdown) setLockdown(app.store, app.runtime.owner, { on: true });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  return { app, server, root };
}

/** One request with a Host header of our choosing, the way a published port sends one. */
function ask(server, { host, token, path = "/api/state" } = {}) {
  const url = new URL(path, server.url);
  return new Promise((resolve, reject) => {
    const call = request({
      hostname: "127.0.0.1", port: Number(url.port), path: url.pathname, method: "GET",
      headers: { ...(host ? { host } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    call.on("error", reject);
    call.end();
  });
}

/* ---------- B1 the default never changes ---------- */

test("B1 an install that says nothing listens on this computer and nowhere else", async (t) => {
  const { app, server } = await fixture(t);
  assert.equal(listenSettings(app.store, app.runtime.owner).where, "this-computer");
  assert.equal(listenAsked(app.store, app.runtime.owner, {}), "this-computer");
  assert.equal(app.store.get("settings", app.runtime.owner, listenKey), undefined, "nothing was written to say so");
  assert.equal(server.url.startsWith("http://127.0.0.1:"), true);
  assert.equal(decideListen({ where: "this-computer", lockdown: false, token: key, addresses: privateHome }).address, "127.0.0.1");
  // Even a computer with a public address is untouched by this branch when nobody asked for more.
  const publicBox = [{ address: "203.0.113.7", internal: false }];
  assert.equal(decideListen({ where: "this-computer", lockdown: false, token: key, addresses: publicBox }).beyond, false);
});

/* ---------- B2 a wider address is refused while the protections are off ---------- */

test("B2 Lockdown, a public address and a missing key each keep the door on this computer", () => {
  const wide = { where: "private-network", lockdown: false, token: key, addresses: privateHome };

  const locked = decideListen({ ...wide, lockdown: true });
  assert.equal(locked.address, "127.0.0.1");
  assert.equal(locked.beyond, false);
  assert.match(locked.refusal, /Lockdown is on/);

  const exposed = decideListen({ ...wide, addresses: [...privateHome, { address: "203.0.113.7", internal: false }] });
  assert.equal(exposed.address, "127.0.0.1");
  assert.match(exposed.refusal, /203\.0\.113\.7.*not a private address/s);

  const keyless = decideListen({ ...wide, token: "" });
  assert.equal(keyless.address, "127.0.0.1");
  assert.match(keyless.refusal, /no local key/);

  // Something that is not an address at all is not taken for a private one.
  assert.equal(decideListen({ ...wide, addresses: [{ address: "not-an-address", internal: false }] }).beyond, false);
});

test("B2 a Tailscale address is private here, as it already is for the phone door", () => {
  const onTailnet = decideListen({
    where: "private-network", lockdown: false, token: key,
    addresses: [{ address: "127.0.0.1", internal: true }, { address: "100.101.102.103", internal: false }],
  });
  assert.equal(onTailnet.address, "0.0.0.0");
  assert.equal(onTailnet.refusal, null);
  assert.ok(onTailnet.extraHosts.includes("100.101.102.103"));
});

/* ---------- B3 with them on it listens, and the door still asks ---------- */

test("B3 the wider door is really wider, and still refuses a caller with no key", async (t) => {
  const { app, server } = await fixture(t, { where: "private-network" });
  assert.equal(server.url.startsWith("http://127.0.0.1:"), true, "what everything else is told never changes");
  assert.equal(listenAsked(app.store, app.runtime.owner, {}), "private-network");

  const port = Number(new URL(server.url).port);
  assert.equal(await ask(server, { host: `127.0.0.1:${port}` }), 401, "no key, no answer");
  assert.equal(await ask(server, { host: `127.0.0.1:${port}`, token: "x".repeat(64) }), 401, "a wrong key is no better");
  assert.equal(await ask(server, { host: `127.0.0.1:${port}`, token: server.token }), 200);
});

test("B3 a published port reaches Branch, and a name this computer does not answer to does not", async (t) => {
  const { server } = await fixture(t, { where: "private-network" });
  // A container publishes Branch on whatever port the host chose, so the port the caller names is
  // not the port Branch listens on. The name still has to be one this computer answers to.
  assert.equal(await ask(server, { host: "127.0.0.1:8080", token: server.token }), 200);
  assert.equal(await ask(server, { host: "localhost:8080", token: server.token }), 200);
  assert.equal(await ask(server, { host: "branch.example:8080", token: server.token }), 403);
  assert.equal(await ask(server, { host: "192.0.2.9:3210", token: server.token }), 403);
});

test("B3 while the door is on this computer a published port's Host is refused, as before", async (t) => {
  const { server } = await fixture(t);
  assert.equal(await ask(server, { host: "127.0.0.1:8080", token: server.token }), 403);
  assert.equal(await ask(server, { host: "localhost:" + new URL(server.url).port, token: server.token }), 403);
});

test("B3 hostAllowed: a portless entry is any port, a paired entry is still exactly its own", () => {
  const url = "http://127.0.0.1:3210";
  assert.equal(hostAllowed("127.0.0.1:3210", undefined, url), true);
  assert.equal(hostAllowed("127.0.0.1:8080", undefined, url), false, "no wider door, no wider names");
  assert.equal(hostAllowed("127.0.0.1:8080", undefined, url, ["localhost", "127.0.0.1"]), true);
  assert.equal(hostAllowed("localhost:8080", "http://localhost:8080", url, ["localhost"]), true);
  assert.equal(hostAllowed("localhost:8080", "https://elsewhere.example", url, ["localhost"]), false);
  assert.equal(hostAllowed("[fd00::1]:9", undefined, url, ["[fd00::1]"]), true);
  // The paired address keeps its port, so a phone's door is not widened by this.
  assert.equal(hostAllowed("100.64.1.2:9999", undefined, url, ["100.64.1.2:3210"]), false);
});

test("B3 a caller who is not on this computer is not on this computer", () => {
  for (const near of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.53"]) assert.equal(fromThisComputer(near), true);
  for (const far of ["192.168.1.40", "172.17.0.1", undefined, ""]) assert.equal(fromThisComputer(far), false);
});

/* ---------- B4 who may move it ---------- */

test("B4 a chat, a key, a household person, a Trunk and Lockdown are each refused", async (t) => {
  const { app } = await fixture(t);
  const store = app.store, owner = app.runtime.owner;
  assert.equal(listenChangeRefusal(store, owner), null, "the owner may");

  assert.match(listenChangeRefusal(store, owner, { source: "channel" }), /message from a chat app/);
  assert.match(underShortLivedKey(() => listenChangeRefusal(store, owner)), /short-lived key/);
  // A Trunk's message from another computer arrives at POST /api/reach/trunks/inbox with a
  // short-lived key, so the key refusal is what a Trunk meets; work another program started is
  // refused by name as well.
  assert.match(offLimitsToShortLivedKeys("POST", "/api/listen"), /short-lived key cannot change where Branch listens/);
  assert.equal(offLimitsToShortLivedKeys("GET", "/api/listen"), null, "looking is not moving");
  for (const source of ["mcp", "a2a", "acp"])
    assert.match(listenChangeRefusal(store, owner, { source }), /another assistant or program/);

  const profile = store.profiles.create({ name: "Sam", pin: "2468" });
  store.profiles.switch({ profileId: profile.id, pin: "2468" });
  assert.throws(() => listenChangeRefusal(store, owner), /belongs to the owner/);
  store.profiles.switch({ profileId: null });
  assert.throws(() => asPerson({ profileId: profile.id, keyId: "k" }, () => listenChangeRefusal(store, owner)),
    /belongs to the owner/, "a signed-in person is refused too");

  setLockdown(store, owner, { on: true });
  assert.match(listenChangeRefusal(store, owner), /Lockdown is on/);
  // And a setting saved before Lockdown reads as this computer while it is on.
  setLockdown(store, owner, { on: false });
  saveListenSettings(store, owner, { where: "private-network" });
  setLockdown(store, owner, { on: true });
  assert.equal(listenSettings(store, owner).where, "this-computer");
  assert.equal(listenAsked(store, owner, { [listenEnvName]: "private-network" }), "private-network",
    "the container's name says what was asked for; decideListen is what refuses it");
  assert.equal(decideListen({ where: "private-network", lockdown: true, token: key, addresses: privateHome }).beyond, false);
});

test("B4 over HTTP: the owner may look and move it; a household person may not", async (t) => {
  const { app, server } = await fixture(t);
  const call = (method, body) => fetch(`${server.url}/api/listen`, {
    method, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));

  const seen = await call("GET");
  assert.equal(seen.status, 200);
  assert.equal(seen.body.where, "this-computer");
  assert.equal(seen.body.listeningOn, "127.0.0.1");
  assert.equal(seen.body.beyondThisComputer, false);

  const saved = await call("POST", { where: "private-network" });
  assert.equal(saved.status, 200, saved.body.error);
  assert.match(saved.body.note, /next time Branch starts/);
  assert.equal(listenSettings(app.store, app.runtime.owner).where, "private-network");

  const profile = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: profile.id, pin: "2468" });
  const refused = await call("POST", { where: "this-computer" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /belongs to the owner/);
  assert.equal(listenSettings(app.store, app.runtime.owner).where, "private-network", "nothing was written");
});

/* ---------- B5 it is written down where settings are written down ---------- */

test("B5 the setting is in the catalogue as one that reaches further, and the route is classified", async () => {
  const spec = settingsCatalogue.find((entry) => entry.key === "listen-address");
  assert.ok(spec, "where Branch listens is not in the settings catalogue");
  assert.equal(spec.fields.length, 1);
  assert.equal(spec.fields[0].field, "where");
  assert.equal(spec.fields[0].guard, "reach", "moving the door off this computer reaches further");
  assert.deepEqual(spec.fields[0].kind.options, ["this-computer", "private-network"], "most careful first");
  assert.equal(spec.fields[0].initial, "this-computer");
  assert.equal(ROUTES["/api/listen"], "owner POST");

  const docs = await readFile(new URL("../docs/configuration.md", import.meta.url), "utf8");
  assert.match(docs, /## Where Branch listens/, "the reference never says what this is");
  assert.match(docs, /`listen-address`/);
  const dockerfile = await readFile(new URL("../packaging/docker/Dockerfile", import.meta.url), "utf8");
  assert.equal(dockerfile.includes("--network host"), false, "the container no longer needs the host's network");
  assert.match(dockerfile, /-p 3210:3210/);
  assert.match(dockerfile, /BRANCH_LISTEN=private-network/);
});
