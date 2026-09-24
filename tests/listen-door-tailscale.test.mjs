/**
 * The private-network door and Tailscale's own word for this computer's address.
 *
 * 100.64.0.0/10 is shared address space: Tailscale hands its addresses out of it, and so do other
 * networks. So being in that range does not make an address Tailscale's. The door counts such an
 * address as private only when Tailscale itself reports it as this computer's tailnet address, and
 * Tailscale missing, not running or not answering confirms nothing.
 *
 * Tailscale is never run here: every answer comes from a double handed to the door.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import * as door from "../dist/listen-address.js";

const key = "a".repeat(64);
const wide = { where: "private-network", lockdown: false, token: key };
const loopback = { address: "127.0.0.1", internal: true };
const home = { address: "192.168.1.40", internal: false };
/** The address Tailscale reports as this computer's. */
const ours = "100.101.102.103";
/** Another address in the same range, which Tailscale does not report. */
const other = "100.99.1.2";
const outward = (address) => ({ address, internal: false });

/** A stand-in for `probeTailscale` that gives one answer and counts how often it was asked. */
function tailscale(answer) {
  const probe = async () => {
    probe.calls += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  probe.calls = 0;
  return probe;
}
const running = (address) => ({ present: true, running: true, address, hostname: "desk.tail1234.ts.net", message: "" });
const notRunning = { present: true, running: false, address: null, hostname: null, message: "Tailscale is installed but not signed in." };
const missing = { present: false, running: false, address: null, hostname: null, message: "Tailscale is not installed on this computer." };

function staysHere(decision, address) {
  assert.equal(decision.address, "127.0.0.1", `${address}: the door stays on this computer`);
  assert.equal(decision.beyond, false, address);
  assert.deepEqual(decision.extraHosts, [], address);
  assert.ok(decision.refusal?.includes(address), `the refusal names ${address}: ${decision.refusal}`);
}

/* ---------- the decision itself ---------- */

test("a 100.64 address Tailscale does not report as this computer's keeps the door on this computer", () => {
  for (const tailnet of [undefined, [], [ours]]) {
    const decision = door.decideListen({ ...wide, addresses: [loopback, home, outward(other)], ...(tailnet ? { tailnet } : {}) });
    staysHere(decision, other);
    assert.match(decision.refusal, /Tailscale does not report/, "the refusal says why a 100.64 address is not private");
  }
});

test("the address Tailscale reports as this computer's opens the door", () => {
  const decision = door.decideListen({ ...wide, addresses: [loopback, home, outward(ours)], tailnet: [ours] });
  assert.equal(decision.address, "0.0.0.0");
  assert.equal(decision.beyond, true);
  assert.equal(decision.refusal, null);
  assert.ok(decision.extraHosts.includes(ours));
});

test("Tailscale's word counts only for an address in Tailscale's own range", () => {
  // A report is never a way to count some other address as private.
  staysHere(door.decideListen({ ...wide, addresses: [home, outward("203.0.113.7")], tailnet: ["203.0.113.7"] }), "203.0.113.7");
  // Nor is the IPv6 spelling of a 100.64 address one Tailscale reports, whichever way it is written.
  for (const tailnet of [[ours], [`::ffff:${ours}`]])
    staysHere(door.decideListen({ ...wide, addresses: [home, outward(`::ffff:${ours}`)], tailnet }), `::ffff:${ours}`);
});

/* ---------- asking Tailscale ---------- */

test("the door asks Tailscale, and a 100.64 address Tailscale does not report stays refused", async () => {
  const probe = tailscale(running(ours));
  const decision = await door.decideListenHere({ ...wide, addresses: [loopback, home, outward(other)], tailscale: probe });
  staysHere(decision, other);
  assert.equal(probe.calls, 1, "Tailscale was asked once");
});

test("the door asks Tailscale, and the address Tailscale reports opens the door", async () => {
  const probe = tailscale(running(ours));
  const decision = await door.decideListenHere({ ...wide, addresses: [loopback, home, outward(ours)], tailscale: probe });
  assert.equal(decision.address, "0.0.0.0");
  assert.equal(decision.refusal, null);
  assert.ok(decision.extraHosts.includes(ours));
  assert.equal(probe.calls, 1);
});

test("Tailscale missing, not running or not answering confirms nothing", async () => {
  const addresses = [loopback, home, outward(ours)];
  const answers = [missing, notRunning, { ...running(ours), running: false }, new Error("tailscale did not answer in time")];
  for (const answer of answers) {
    const probe = tailscale(answer);
    staysHere(await door.decideListenHere({ ...wide, addresses, tailscale: probe }), ours);
    assert.equal(probe.calls, 1);
  }
  // A probe that throws before it even returns a promise confirms nothing either.
  const thrown = () => { throw new Error("tailscale is not on the path"); };
  staysHere(await door.decideListenHere({ ...wide, addresses, tailscale: thrown }), ours);
});

test("Tailscale is asked only when the wider door is asked for and a 100.64 address is here", async () => {
  const probe = tailscale(running(ours));
  const here = await door.decideListenHere({ ...wide, where: "this-computer", addresses: [loopback, outward(ours)], tailscale: probe });
  assert.equal(here.address, "127.0.0.1");
  const plain = await door.decideListenHere({ ...wide, addresses: [loopback, home], tailscale: probe });
  assert.equal(plain.address, "0.0.0.0", "a computer with no 100.64 address is decided as before");
  assert.equal(probe.calls, 0, "nothing was run to find out what did not matter");
});

/* ---------- Branch starting ---------- */

async function started(t, { addresses, probe }) {
  const root = await mkdtemp(join(tmpdir(), "branch-door-tailscale-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  door.saveListenSettings(app.store, app.runtime.owner, { where: "private-network" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, listenAddresses: addresses, tailscale: probe });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  return server;
}

const view = (server) => fetch(`${server.url}/api/listen`, { headers: { authorization: `Bearer ${server.token}` } })
  .then((response) => response.json());

test("Branch started where Tailscale does not report the 100.64 address listens on this computer only", async (t) => {
  const probe = tailscale(running(ours));
  const server = await started(t, { addresses: [loopback, home, outward(other)], probe });
  assert.equal(server.listeningOn(), "127.0.0.1");
  assert.equal(probe.calls, 1, "Branch asked Tailscale as it started");
  const seen = await view(server);
  assert.equal(seen.beyondThisComputer, false);
  assert.match(seen.refusal, /100\.99\.1\.2.*Tailscale does not report/s);
});

test("Branch started where Tailscale reports the 100.64 address listens on the private network", async (t) => {
  const probe = tailscale(running(ours));
  const server = await started(t, { addresses: [loopback, home, outward(ours)], probe });
  assert.equal(server.listeningOn(), "0.0.0.0");
  assert.equal(probe.calls, 1);
  const seen = await view(server);
  assert.equal(seen.beyondThisComputer, true);
  assert.equal(seen.refusal, null);
});

test("Branch started with Tailscale not running keeps a 100.64 address from opening the door", async (t) => {
  const server = await started(t, { addresses: [loopback, home, outward(ours)], probe: tailscale(notRunning) });
  assert.equal(server.listeningOn(), "127.0.0.1");
});
