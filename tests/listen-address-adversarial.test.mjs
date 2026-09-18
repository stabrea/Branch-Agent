/**
 * mac7/bind, integration review: the adversarial pass over the widest change in the product.
 *
 * Every other setting decides what Branch may do; this one decides who can reach Branch at all. So
 * these are the attacks rather than the happy paths: a page on another port of the same computer
 * claiming to be Branch's own page, a computer that answers on no address at all, Lockdown switched
 * on while the wide door is already open, and everything that can read where the door is without
 * being the owner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer, hostAllowed, offLimitsToShortLivedKeys } from "../dist/server.js";
import { decideListen, fromThisComputer, listenReadRefusal, saveListenSettings } from "../dist/listen-address.js";
import { tunnelMark } from "../dist/auth-limits.js";
import { tokenFromProtocol } from "../dist/ws.js";
import { setLockdown } from "../dist/lockdown.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { asPerson } from "../dist/people/context.js";
import { ROUTES } from "./short-lived-key-routes.mjs";

const key = "a".repeat(64);
const url = "http://127.0.0.1:3210";
const privateHome = [{ address: "127.0.0.1", internal: true }, { address: "192.168.1.40", internal: false }];
const wideHere = { where: "private-network", lockdown: false, token: key, addresses: privateHome };

async function fixture(t, { where } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-bind-adv-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  if (where) saveListenSettings(app.store, app.runtime.owner, { where });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  return { app, server, root };
}

function ask(server, { host, origin, token, tunnel, path = "/api/state", method = "GET" } = {}) {
  const at = new URL(server.url);
  return new Promise((resolve, reject) => {
    const call = request({
      hostname: "127.0.0.1", port: Number(at.port), path, method,
      headers: {
        ...(host ? { host } : {}), ...(origin ? { origin } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(tunnel ? { [tunnelMark]: "1" } : {}),
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    call.on("error", reject);
    call.end();
  });
}

/* ---------- X1 a page on another port of this same computer is not Branch's own page ---------- */

test("X1 the wider door does not trust an Origin from another port of the same computer", () => {
  const wide = decideListen(wideHere);
  // The container case that the portless entry exists for: Branch's own page, served by Branch,
  // always arrives with an Origin whose port is the very port the request was sent to.
  assert.equal(hostAllowed("127.0.0.1:8080", "http://127.0.0.1:8080", url, wide.extraHosts), true,
    "Branch's own page on a published port still works");
  assert.equal(hostAllowed("localhost:8080", "http://localhost:8080", url, wide.extraHosts), true);
  // The attack: anything else listening on this computer — a development server, another app's
  // dashboard, a plugin's own page — is a different origin and must be refused.
  assert.equal(hostAllowed("127.0.0.1:3210", "http://127.0.0.1:8080", url, wide.extraHosts), false,
    "a page on another port of this computer is not Branch's own page");
  assert.equal(hostAllowed("192.168.1.40:3210", "http://192.168.1.40:9999", url, wide.extraHosts), false,
    "nor is one on another port of this computer's network address");
  assert.equal(hostAllowed("localhost:3210", "http://localhost:8080", url, wide.extraHosts), false);
  // A name this computer does not answer to is refused whatever it does with ports.
  assert.equal(hostAllowed("127.0.0.1:3210", "http://elsewhere.example", url, wide.extraHosts), false);
  assert.equal(hostAllowed("127.0.0.1:3210", "http://127.0.0.1.elsewhere.example", url, wide.extraHosts), false);
});

test("X1 the paired door's own names are still exactly their own port", () => {
  const paired = ["100.64.1.2:3210", "mac.tail-abc.ts.net:3210"];
  assert.equal(hostAllowed("100.64.1.2:9999", undefined, url, paired), false);
  assert.equal(hostAllowed("100.64.1.2:3210", "http://100.64.1.2:9999", url, paired), false);
  assert.equal(hostAllowed("mac.tail-abc.ts.net:3210", "http://mac.tail-abc.ts.net:3210", url, paired), true);
  // And a wider door beside the paired one does not widen it.
  const both = [...paired, ...decideListen(wideHere).extraHosts];
  assert.equal(hostAllowed("100.64.1.2:9999", undefined, url, both), false,
    "the wider door's any-port rule must not leak onto the paired door's names");
});

test("X1 a name that is not one of ours is refused, so a rebinding page gets nowhere", async (t) => {
  const { server } = await fixture(t, { where: "private-network" });
  for (const host of ["attacker.example", "attacker.example:3210", "rebind.attacker.example:8080"]) {
    const { status } = await ask(server, { host, token: server.token });
    assert.equal(status, 403, `${host} must be refused`);
  }
  // "localhost" is the only name in the list, and it is not one anybody else's DNS can hand out.
  const { status } = await ask(server, { host: "localhost:8080", token: server.token });
  assert.equal(status, 200);
});

/* ---------- X2 a refusal must never be a wider door ---------- */

test("X2 a computer that answers on no outward address at all does not open the door", () => {
  const nowhere = decideListen({ ...wideHere, addresses: [{ address: "127.0.0.1", internal: true }] });
  assert.equal(nowhere.address, "127.0.0.1", "finding nothing is not a reason to open the door");
  assert.equal(nowhere.beyond, false);
  assert.equal(nowhere.extraHosts.length, 0);
  assert.match(nowhere.refusal, /no address/i);
  // The same with an empty list, which is what a machine with networking off looks like.
  assert.equal(decideListen({ ...wideHere, addresses: [] }).beyond, false);
});

test("X2 every refusal lands on this computer and says so", () => {
  const cases = [
    { ...wideHere, lockdown: true },
    { ...wideHere, token: "" },
    { ...wideHere, token: "A".repeat(64) },
    { ...wideHere, addresses: [...privateHome, { address: "203.0.113.7", internal: false }] },
    { ...wideHere, addresses: [{ address: "2a00:1450:4001:82f::200e", internal: false }] },
    { ...wideHere, addresses: [] },
  ];
  for (const input of cases) {
    const decision = decideListen(input);
    assert.equal(decision.address, "127.0.0.1");
    assert.equal(decision.beyond, false, "a refusal is never beyond this computer");
    assert.deepEqual(decision.extraHosts, [], "a refusal hands out no extra names either");
    assert.ok(decision.refusal, "a refusal always says why");
  }
});

test("X2 there is no state where the door is wide and nothing says so", () => {
  for (const addresses of [privateHome, [{ address: "100.101.102.103", internal: false }], []]) {
    for (const lockdown of [true, false]) {
      for (const token of [key, ""]) {
        const decision = decideListen({ where: "private-network", lockdown, token, addresses });
        // Wide and silent is the one combination that must not exist.
        assert.equal(decision.beyond && decision.refusal !== null, false);
        assert.equal(decision.beyond, decision.address === "0.0.0.0");
        assert.equal(decision.beyond || decision.refusal !== null, true,
          "either it is wide, or it says why it is not");
      }
    }
  }
});

/* ---------- X3 Lockdown must drop the wider socket, not merely refuse new work ---------- */

test("X3 switching Lockdown on while the door is wide drops the wider socket", async (t) => {
  const { app, server } = await fixture(t, { where: "private-network" });
  assert.equal(server.listeningOn(), "0.0.0.0", "the door really is wide to start with");

  setLockdown(app.store, app.runtime.owner, { on: true });
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(server.listeningOn(), "127.0.0.1",
    "Lockdown takes the wider socket away rather than only refusing what arrives on it");
  // And the owner's own app, which reaches Branch here, is untouched.
  const { status } = await ask(server, { host: new URL(server.url).host, token: server.token });
  assert.equal(status, 200);
});

/* ---------- X4 telling somebody where to knock is telling them something ---------- */

test("X4 a short-lived key, a household person and a chat task cannot read where Branch listens", async (t) => {
  const { app } = await fixture(t);
  const store = app.store, owner = app.runtime.owner;
  assert.equal(listenReadRefusal(store, owner), null, "the owner may look");

  assert.match(underShortLivedKey(() => listenReadRefusal(store, owner)) ?? "", /short-lived key/);
  assert.match(listenReadRefusal(store, owner, { source: "channel" }) ?? "", /message from a chat app/);
  for (const source of ["mcp", "a2a", "acp"])
    assert.match(listenReadRefusal(store, owner, { source }) ?? "", /another assistant or program/);

  const profile = store.profiles.create({ name: "Sam", pin: "2468" });
  store.profiles.switch({ profileId: profile.id, pin: "2468" });
  assert.throws(() => listenReadRefusal(store, owner), /belongs to the owner/);
  store.profiles.switch({ profileId: null });
  assert.throws(() => asPerson({ profileId: profile.id, keyId: "k" }, () => listenReadRefusal(store, owner)),
    /belongs to the owner/, "a signed-in person cannot ask where to knock either");

  // Lockdown is the one thing that must NOT stop the owner looking: the card has to be able to say
  // "Lockdown is on, so Branch is listening on this computer only".
  setLockdown(store, owner, { on: true });
  assert.equal(listenReadRefusal(store, owner), null, "the owner still sees their own card under Lockdown");
});

test("X4 the route is closed to a short-lived key for looking as well as for moving", () => {
  assert.equal(ROUTES["/api/listen"], "owner GET,POST",
    "reading it tells a caller where to knock, so it is the owner's alone either way");
  assert.match(offLimitsToShortLivedKeys("GET", "/api/listen") ?? "", /where Branch listens/);
  assert.match(offLimitsToShortLivedKeys("POST", "/api/listen") ?? "", /where Branch listens/);
});

test("X4 over HTTP a short-lived key is refused the answer", async (t) => {
  const { server } = await fixture(t, { where: "private-network" });
  const host = new URL(server.url).host;
  const owner = await ask(server, { host, token: server.token, path: "/api/listen" });
  assert.equal(owner.status, 200);
  assert.match(owner.body, /listeningOn/);
  // Nothing that is not the owner's own key gets the address out of it.
  const guessed = await ask(server, { host, token: "b".repeat(64), path: "/api/listen" });
  assert.equal(guessed.status, 401);
  assert.equal(/0\.0\.0\.0|listeningOn/.test(guessed.body), false, "and learns nothing from the refusal");
});

/* ---------- X5 "this computer" must mean this computer, not the door that dials it ---------- */

test("X5 a request the webhook door passed on from the internet is not on this computer", () => {
  assert.equal(fromThisComputer("127.0.0.1"), true);
  assert.equal(fromThisComputer("127.0.0.1", {}), true);
  // The webhook door dials 127.0.0.1, so what it passes on wears a loopback address. It always
  // sets this mark and always strips one a caller sent, so reading it here is what stops the
  // internet counting as this computer if that door is ever widened.
  assert.equal(fromThisComputer("127.0.0.1", { [tunnelMark]: "1" }), false);
  assert.equal(fromThisComputer("::1", { [tunnelMark]: "" }), false);
});

test("X5 a page whose whole secret is its address is served to this computer only", async (t) => {
  const { server } = await fixture(t, { where: "private-network" });
  const host = new URL(server.url).host;
  // Both of these are reusable addresses with no key on them. Neither may be served to a caller
  // beyond this computer now that the door can be wide; an unknown one must look the same as a
  // real one, which is what falling through to the key check gives.
  // The test client is on this computer, so the gate is exercised with the mark the webhook door
  // sets — the one way a request that is really from elsewhere reaches this handler.
  for (const path of ["/artifact/" + "a".repeat(32), "/asks-surface/" + "b".repeat(32)]) {
    const near = await ask(server, { host, path });
    assert.equal(near.status, 404, `${path} is looked up for a caller on this computer`);
    const far = await ask(server, { host, path, tunnel: true });
    assert.equal(far.status, 401, `${path} must not be answered to a caller from beyond this computer`);
  }
});

/* ---------- X6 the key the whole wider door rests on ---------- */

/** The middle value, which a busy machine's occasional long pause cannot drag around. */
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test("X6 a wrong key tells an attacker nothing by how long it takes to be refused", () => {
  // On a wider door the key is the only thing between the network and everything Branch can do, so
  // a comparison that stops at the first wrong character would let it be guessed one character at a
  // time. The two guesses below are both wrong; one is wrong in the first character and one only in
  // the last, which is the shape that separates a constant-time comparison from `===`.
  const real = "c".repeat(64);
  const wrongFirst = "d" + "c".repeat(63);
  const wrongLast = "c".repeat(63) + "d";
  const timeOf = (guess) => {
    const at = process.hrtime.bigint();
    for (let i = 0; i < 2000; i += 1)
      assert.equal(tokenFromProtocol({ headers: { "sec-websocket-protocol": `bearer, ${guess}` } }, real), false);
    return Number(process.hrtime.bigint() - at);
  };
  const first = [], last = [];
  for (let round = 0; round < 9; round += 1) { first.push(timeOf(wrongFirst)); last.push(timeOf(wrongLast)); }
  const [a, b] = [median(first), median(last)];
  // Generously wide on purpose: this must catch a comparison that gives the answer away, not
  // measure this Mac. An early-exit comparison separates these by orders of magnitude.
  assert.ok(Math.abs(a - b) / Math.max(a, b) < 0.5,
    `refusing a key wrong in the first character (${a}ns) and in the last (${b}ns) must take alike`);
  // The right key is still the right key, and nothing reads it from the address.
  assert.equal(tokenFromProtocol({ headers: { "sec-websocket-protocol": `bearer, ${real}` } }, real), true);
});

test("X6 a wrong key is refused the same way whatever its length, and is counted", async (t) => {
  const { server } = await fixture(t, { where: "private-network" });
  const host = new URL(server.url).host;
  const sameLength = await ask(server, { host, token: "d".repeat(64) });
  const shorter = await ask(server, { host, token: "d" });
  assert.equal(sameLength.status, 401);
  assert.equal(shorter.status, 401);
  assert.equal(sameLength.body, shorter.body, "the refusal says the same thing either way");
  // Five in a row from one place and that place is made to wait, so the key cannot be guessed at speed.
  let last = shorter;
  for (let i = 0; i < 6; i += 1) last = await ask(server, { host, token: "e".repeat(64) });
  assert.equal(last.status, 429, "wrong keys on the wider door are counted and then made to wait");
});
