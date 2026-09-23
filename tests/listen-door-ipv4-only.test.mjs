/**
 * The private-network door on a computer that also has an IPv6 address that is not private.
 *
 * The wider door listens on 0.0.0.0, the IPv4 wildcard, and a socket there is reached on this
 * computer's IPv4 addresses only: an IPv6 connection never arrives at it. So an IPv6 address that is
 * not private does not put the door on the internet, as long as every IPv4 address is private. Then
 * the door opens on private IPv4 networks only and says so, and the names it answers to leave out
 * the IPv6 addresses. Any IPv4 address that is not private still keeps it on this computer.
 *
 * The first test checks the claim everything else rests on, with real sockets on this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { request } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { setLockdown } from "../dist/lockdown.js";
import { decideListen, saveListenSettings } from "../dist/listen-address.js";

const key = "a".repeat(64);
const wide = { where: "private-network", lockdown: false, token: key };
const loopback = { address: "127.0.0.1", internal: true };
const loopback6 = { address: "::1", internal: true };
const home = { address: "192.168.1.40", internal: false };
const outward = (address) => ({ address, internal: false });
/** A global IPv6 address, of the documentation range. */
const global6 = "2001:db8::5";

/* ---------- the claim: a socket on 0.0.0.0 is never reached over IPv6 ---------- */

/** A TCP server on `host`, port 0, that counts the connections it accepts. */
async function counting(t, host) {
  const server = createServer((socket) => { server.accepted += 1; socket.destroy(); });
  server.accepted = 0;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => { server.off("error", reject); resolve(); });
  });
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return server;
}

/** Opens a TCP connection and closes it again: "connected", the error code, or "timeout". */
function knock(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(3000, () => { socket.destroy(); resolve("timeout"); });
    socket.once("connect", () => { socket.destroy(); resolve("connected"); });
    socket.once("error", (error) => resolve(error.code ?? String(error)));
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/** This computer's own IPv6 addresses beyond loopback, global or link-local, written so they can be dialled. */
function ownIPv6() {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries ?? [])
    .filter((entry) => entry.family === "IPv6" && !entry.internal)
    .map((entry) => (/^fe[89ab]/i.test(entry.address) ? `${entry.address}%${name}` : entry.address)));
}

test("a server on the IPv4 wildcard never accepts a connection made over IPv6", async (t) => {
  const v4 = await counting(t, "0.0.0.0");
  const port = v4.address().port;
  // IPv6 loopback, and every IPv6 address this computer has: a global one where it has one.
  for (const host of ["::1", ...ownIPv6()]) {
    const overV6 = await knock(host, port);
    await settle();
    assert.equal(v4.accepted, 0, `a connection to [${host}]:${port} reached the IPv4 wildcard (${overV6})`);
  }
  t.diagnostic(`IPv6 addresses tried beyond loopback: ${ownIPv6().length}`);
  assert.equal(await knock("127.0.0.1", port), "connected", "the same server is reached over IPv4");
  await settle();
  assert.equal(v4.accepted, 1);
  // IPv6 itself works on this computer, so the refusal above is the wildcard's and not a missing IPv6.
  let v6;
  try {
    v6 = await counting(t, "::1");
  } catch (error) {
    t.diagnostic(`this computer has no IPv6 loopback (${error.code}), so only the IPv4 side was checked`);
    return;
  }
  assert.equal(await knock("::1", v6.address().port), "connected");
  await settle();
  assert.equal(v6.accepted, 1, "IPv6 loopback reaches a server that listens on it");
  // And so does this computer's own IPv6 address, a global one first, for a server that listens on it.
  const own = [...ownIPv6()].sort((a, b) => Number(a.includes("%")) - Number(b.includes("%")))[0];
  if (!own) return;
  let onOwn;
  try {
    onOwn = await counting(t, own);
  } catch (error) {
    t.diagnostic(`[${own}] cannot be listened on here (${error.code}), so its own control was not run`);
    return;
  }
  assert.equal(await knock(own, onOwn.address().port), "connected", `[${own}] is reachable over IPv6 here`);
  await settle();
  assert.equal(onOwn.accepted, 1);
});

/* ---------- the decision ---------- */

test("a global IPv6 address beside private IPv4 networks opens the door on private IPv4 only", () => {
  const decision = decideListen({ ...wide, addresses: [loopback, loopback6, home, outward(global6)] });
  assert.equal(decision.address, "0.0.0.0", "the IPv4 wildcard, which IPv6 never reaches");
  assert.equal(decision.beyond, true);
  assert.equal(decision.refusal, null);
  assert.match(decision.ipv4Only, /private IPv4 networks only/);
  assert.ok(decision.ipv4Only.includes(global6), `it names the address: ${decision.ipv4Only}`);
  assert.deepEqual(decision.extraHosts, ["localhost", "127.0.0.1", "[::1]", "192.168.1.40"]);
});

test("the names the IPv4-only door answers to leave out every IPv6 address", () => {
  const decision = decideListen({
    ...wide, addresses: [loopback, home, outward("fd00::5"), outward("fe80::1"), outward(global6), outward("10.0.0.7")],
  });
  assert.equal(decision.address, "0.0.0.0");
  assert.match(decision.ipv4Only, /private IPv4 networks only/);
  assert.deepEqual(decision.extraHosts, ["localhost", "127.0.0.1", "[::1]", "192.168.1.40", "10.0.0.7"]);
});

test("an IPv4 address that is not private still keeps the door on this computer", () => {
  const refused = (addresses, named) => {
    const decision = decideListen({ ...wide, addresses });
    assert.equal(decision.address, "127.0.0.1", named);
    assert.equal(decision.beyond, false, named);
    assert.deepEqual(decision.extraHosts, [], named);
    assert.equal(decision.ipv4Only ?? null, null, named);
    assert.ok(decision.refusal?.includes(named), `the refusal names ${named}: ${decision.refusal}`);
  };
  // The IPv4 address is what keeps the door here, so it is the one named, whichever comes first.
  refused([home, outward(global6), outward("203.0.113.7")], "203.0.113.7");
  refused([outward("203.0.113.7"), home, outward(global6)], "203.0.113.7");
  // An IPv4 address written the IPv6 way is still an IPv4 address.
  refused([home, outward(global6), outward("::ffff:8.8.8.8")], "::ffff:8.8.8.8");
  // An address in Tailscale's range that Tailscale does not report is not private either.
  refused([home, outward(global6), outward("100.99.1.2")], "100.99.1.2");
});

test("the address Tailscale reports counts as a private IPv4 network beside a global IPv6 address", () => {
  const decision = decideListen({ ...wide, addresses: [loopback, outward("100.101.102.103"), outward(global6)], tailnet: ["100.101.102.103"] });
  assert.equal(decision.address, "0.0.0.0");
  assert.match(decision.ipv4Only, /private IPv4 networks only/);
  assert.deepEqual(decision.extraHosts, ["localhost", "127.0.0.1", "[::1]", "100.101.102.103"]);
});

test("with no IPv4 network to be reached on, a global IPv6 address keeps the door on this computer", () => {
  for (const addresses of [[loopback, outward(global6)], [loopback, outward("fd00::5"), outward(global6)]]) {
    const decision = decideListen({ ...wide, addresses });
    assert.equal(decision.address, "127.0.0.1");
    assert.equal(decision.beyond, false);
    assert.ok(decision.refusal?.includes(global6), decision.refusal);
  }
});

test("private IPv6 addresses beside private IPv4 networks open the door as they always have", () => {
  const decision = decideListen({ ...wide, addresses: [loopback, loopback6, home, outward("fd00::5"), outward("fe80::1")] });
  const { ipv4Only, ...rest } = decision;
  assert.deepEqual(rest, {
    address: "0.0.0.0", beyond: true, refusal: null,
    extraHosts: ["localhost", "127.0.0.1", "[::1]", "192.168.1.40", "[fd00::5]", "[fe80::1]"],
  });
  assert.equal(ipv4Only ?? null, null, "nothing is left out, so nothing says so");
});

/* ---------- Branch starting on such a computer ---------- */

async function started(t, addresses) {
  const root = await mkdtemp(join(tmpdir(), "branch-door-ipv4-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  saveListenSettings(app.store, app.runtime.owner, { where: "private-network" });
  const tailscale = async () => { throw new Error("Tailscale is not asked in these tests"); };
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, listenAddresses: addresses, tailscale });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  return { app, server };
}

const view = (server) => fetch(`${server.url}/api/listen`, { headers: { authorization: `Bearer ${server.token}` } })
  .then((response) => response.json());

/** Asks for the door's own card over IPv6 loopback: Branch's answer, or null when it is not Branch that answers. */
function askOverV6(server) {
  const port = Number(new URL(server.url).port);
  return new Promise((resolve) => {
    const call = request({
      host: "::1", port, path: "/api/listen", method: "GET",
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${server.token}` },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve(/listeningOn/.test(body) ? body : null));
    });
    call.on("error", () => resolve(null));
    call.end();
  });
}

test("Branch on a computer with a global IPv6 address listens on private IPv4 only, and says so", async (t) => {
  const { app, server } = await started(t, [loopback, loopback6, home, outward(global6)]);
  assert.equal(server.listeningOn(), "0.0.0.0");
  const seen = await view(server);
  assert.equal(seen.beyondThisComputer, true);
  assert.equal(seen.refusal, null);
  assert.match(seen.ipv4Only, /private IPv4 networks only/);
  assert.equal(await askOverV6(server), null, "Branch does not answer over IPv6");

  // Lockdown takes the door back to this computer, and the card stops saying what no longer holds.
  setLockdown(app.store, app.runtime.owner, { on: true });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(server.listeningOn(), "127.0.0.1");
  const locked = await view(server);
  assert.match(locked.refusal, /Lockdown is on/);
  assert.equal(locked.ipv4Only, null);
});

test("Branch on a computer with a public IPv4 address beside a global IPv6 one stays on this computer", async (t) => {
  const { server } = await started(t, [loopback, home, outward(global6), outward("203.0.113.7")]);
  assert.equal(server.listeningOn(), "127.0.0.1");
  const seen = await view(server);
  assert.match(seen.refusal, /203\.0\.113\.7/);
  assert.equal(seen.ipv4Only ?? null, null);
});
