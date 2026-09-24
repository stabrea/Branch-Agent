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
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer, hostAllowed, offLimitsToShortLivedKeys } from "../dist/server.js";
import { decideListen, fromThisComputer, listenReadRefusal, ownAddresses, saveListenSettings } from "../dist/listen-address.js";
import { isTailnetAddress } from "../dist/remote/tailscale.js";
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

/**
 * Tailscale as it would answer on this computer, without running it: this computer's own 100.64
 * address, when it has one. These tests are about the door, so they keep what it meant before.
 */
async function tailscaleHere() {
  const address = ownAddresses().find((entry) => !entry.internal && isTailnetAddress(entry.address))?.address ?? null;
  return { present: true, running: address !== null, address, hostname: null, message: "" };
}

async function fixture(t, { where } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-bind-adv-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  if (where) saveListenSettings(app.store, app.runtime.owner, { where });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, tailscale: tailscaleHere });
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
        for (const tailnet of [[], ["100.101.102.103"]]) {
          const decision = decideListen({ where: "private-network", lockdown, token, addresses, tailnet });
          // Wide and silent is the one combination that must not exist.
          assert.equal(decision.beyond && decision.refusal !== null, false);
          assert.equal(decision.beyond, decision.address === "0.0.0.0");
          assert.equal(decision.beyond || decision.refusal !== null, true,
            "either it is wide, or it says why it is not");
        }
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

test("X6 a wrong key tells an attacker nothing by how long it takes to be refused", async () => {
  // On a wider door the key is the only thing between the network and everything Branch can do, so
  // a comparison that stops at the first wrong character would let it be guessed one character at a
  // time. The guarantee is in how the comparison is written, so that is what is checked: a
  // constant-time compare over the whole key, with the length checked first. A wall-clock
  // measurement was tried here and had to go — on a shared machine the scheduler's own pauses are
  // far larger than the difference being looked for, so it failed on honest code.
  const source = await readFile(new URL("../src/ws.ts", import.meta.url), "utf8");
  assert.match(source, /supplied\.length === token\.length && timingSafeEqual\(/,
    "the length is checked first, then the whole key is compared in constant time");
  assert.equal(/\bsupplied === token\b/.test(source), false, "the key is never compared with ===");
  // And it still answers correctly, whichever character is wrong.
  const real = "c".repeat(64);
  for (const wrong of ["d" + "c".repeat(63), "c".repeat(63) + "d"])
    assert.equal(tokenFromProtocol({ headers: { "sec-websocket-protocol": `bearer, ${wrong}` } }, real), false);
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

/* ---------- X7 the wider door is not the paired door ---------- */

test("X7 the paired door's own exemptions are not on the wider door", async (t) => {
  const { server } = await fixture(t, { where: "private-network" });
  const host = new URL(server.url).host;
  // `viaRemote` is a literal false for this computer's own server and a literal true only for the
  // paired listener's own handler, so everything written behind `viaRemote &&` — the phone's
  // pairing exchange, the widget's cross-origin permission, the sign-in gateway's chain — is
  // unreachable here. The wider door is this same server, so it inherits none of them.
  // Redeeming a pairing code is the paired door's alone: here it is just another address that
  // wants the local key.
  const paired = await ask(server, { host, path: "/api/pair", method: "POST" });
  assert.equal(paired.status, 401, "the phone's pairing exchange is not answered on the wider door");
  assert.equal(/deviceKey|deviceId/.test(paired.body), false, "and hands out no phone secret");
  // The widget's cross-origin permission is a paired-door answer too: nothing here grants a page
  // elsewhere the right to read what Branch says.
  const preflight = await ask(server, { host, origin: "https://a-site-the-owner-listed.example", method: "OPTIONS" });
  assert.notEqual(preflight.status, 204, "no cross-origin permission is given on this door");
});

/**
 * X8: "private" for the door means a real address on this computer's own network. The outbound rules
 * count an IPv6 address as private when the IPv4 address it carries is private, which is right for
 * refusing to reach it and wrong for opening a door on it: 6to4, Teredo, NAT64 and compatible
 * addresses route across the internet, and site-local and multicast are not a home network either.
 */
const notTheLan = [
  "fec0::5", "fedc::1", "ff02::1", "ff05::2", "2002:c0a8:105::1", "2002:6440:1::1",
  "2001:0:a00:1::f7f7:f7f7", "2001:0:808:808::f5ff:fffe", "64:ff9b::a00:1", "64:ff9b::10.0.0.1",
  "64:ff9b:1::5", "::a00:1", "::10.0.0.1", "::ffff:0:a00:1", "::ffff:0:192.168.1.40",
  // Were allowed by the old classifier, and are no address a home network hands out.
  "::", "0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
  "::ffff:224.0.0.1", "fc::1", "fd::1", "fe8::1",
  // Public, either side of the private ranges.
  "172.32.0.1", "100.128.0.1", "192.169.0.1", "169.255.0.1", "::ffff:8.8.8.8",
  // Tailscale reports a plain IPv4 address, never this spelling of one.
  "::ffff:100.101.102.103",
];
const onTheLan = [
  "10.0.0.1", "10.255.255.254", "172.16.0.9", "172.31.255.254", "192.168.1.40", "169.254.10.20",
  "127.0.0.2",
  "fc00::1", "fd12:3456::1", "fdff:ffff::1", "fe80::1", "fe80::1c2b:3cff:fe4d:5e6f", "febf::1", "::1",
  "::ffff:192.168.1.40", "::ffff:10.0.0.1", "::ffff:c0a8:128", "0:0:0:0:0:ffff:c0a8:128",
];
/** Addresses in the range Tailscale hands out: private here only when Tailscale reports them. */
const inTailscaleRange = ["100.64.0.1", "100.101.102.103", "100.127.255.254"];
/**
 * Of `notTheLan`, the ones a connection reaches over IPv6 only. The door is the IPv4 wildcard, which
 * IPv6 never reaches, so beside a private IPv4 network these leave the door on IPv4 rather than
 * keeping it on this computer. The IPv4-mapped spellings are IPv4 and are not among them.
 */
const onlyOverIPv6 = [
  "fec0::5", "fedc::1", "ff02::1", "ff05::2", "2002:c0a8:105::1", "2002:6440:1::1",
  "2001:0:a00:1::f7f7:f7f7", "2001:0:808:808::f5ff:fffe", "64:ff9b::a00:1", "64:ff9b::10.0.0.1",
  "64:ff9b:1::5", "::a00:1", "::10.0.0.1", "::ffff:0:a00:1", "::ffff:0:192.168.1.40",
  "::", "fc::1", "fd::1", "fe8::1",
];

test("X8 an address that is not on this computer's own network keeps the door on this computer", () => {
  for (const address of notTheLan) {
    const beside = onlyOverIPv6.includes(address) ? [] : [[...privateHome, { address, internal: false }]];
    for (const addresses of [[{ address, internal: false }], ...beside]) {
      const decision = decideListen({ ...wideHere, addresses });
      assert.equal(decision.beyond, false, address);
      assert.equal(decision.address, "127.0.0.1", address);
      assert.deepEqual(decision.extraHosts, [], address);
      assert.ok(decision.refusal?.includes(address), `${address}: ${decision.refusal}`);
    }
  }
});

test("X8 every address a private network really hands out still opens the door", () => {
  for (const address of onTheLan) {
    const decision = decideListen({ ...wideHere, addresses: [...privateHome, { address, internal: false }] });
    assert.equal(decision.refusal, null, address);
    assert.equal(decision.beyond, true, address);
    assert.equal(decision.address, "0.0.0.0", address);
  }
});

test("X8 beside a private IPv4 network, an IPv6-only address that is not private leaves the door on IPv4 only", () => {
  for (const address of onlyOverIPv6) {
    const decision = decideListen({ ...wideHere, addresses: [...privateHome, { address, internal: false }] });
    assert.equal(decision.address, "0.0.0.0", address);
    assert.equal(decision.refusal, null, address);
    assert.ok(decision.ipv4Only?.includes(address), `${address}: ${decision.ipv4Only}`);
    assert.deepEqual(decision.extraHosts, ["localhost", "127.0.0.1", "[::1]", "192.168.1.40"], address);
  }
});

test("X8 an address in Tailscale's range opens the door only when Tailscale reports it as this computer's", () => {
  for (const address of inTailscaleRange) {
    const addresses = [...privateHome, { address, internal: false }];
    const reported = decideListen({ ...wideHere, addresses, tailnet: [address] });
    assert.equal(reported.refusal, null, address);
    assert.equal(reported.address, "0.0.0.0", address);
    for (const tailnet of [undefined, [], ["100.64.0.2"]]) {
      const unreported = decideListen({ ...wideHere, addresses, ...(tailnet ? { tailnet } : {}) });
      assert.equal(unreported.beyond, false, address);
      assert.equal(unreported.address, "127.0.0.1", address);
      assert.deepEqual(unreported.extraHosts, [], address);
      assert.ok(unreported.refusal?.includes(address), `${address}: ${unreported.refusal}`);
    }
  }
});
