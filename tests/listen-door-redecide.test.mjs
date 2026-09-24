/**
 * The private-network door decides again when this computer's addresses change while Branch runs.
 *
 * The door is decided on the addresses this computer has when Branch starts. A computer can gain an
 * address later that would have kept the door on this computer at the start: a public IPv4 address,
 * a 100.64 address Tailscale does not report, or a global IPv6 address with no private IPv4 network
 * to stay on. While the door is open wider, Branch reads its addresses again, and when they change it
 * decides again. A narrower answer closes the wider door at once and keeps 127.0.0.1 answering. A
 * wider one never opens anything: the door says a restart would.
 *
 * On Linux the whole of 127.0.0.0/8 is this computer: a socket on 0.0.0.0 is reached at 127.0.0.2,
 * and a socket on 127.0.0.1 is not. So a connection to 127.0.0.2 is one that reaches the wider door.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { request } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { setLockdown } from "../dist/lockdown.js";
import { saveListenSettings } from "../dist/listen-address.js";

const tick = 40;
const loopback = { address: "127.0.0.1", internal: true };
const loopback6 = { address: "::1", internal: true };
const home = { address: "192.168.1.40", internal: false };
const outward = (address) => ({ address, internal: false });
const publicV4 = "203.0.113.7";
const global6 = "2001:db8::5";
/** The 100.64 address Tailscale reports as this computer's, and one it does not. */
const ours = "100.101.102.103";
const other = "100.99.1.2";
const linux = process.platform === "linux";

/** Addresses the door reads while Branch runs: `set` changes them, and `fail` makes a reading throw. */
function addressReader(initial) {
  let current = initial;
  const read = () => {
    read.reads += 1;
    if (read.fail) { read.throws += 1; throw new Error("the addresses could not be read"); }
    return current;
  };
  Object.assign(read, { reads: 0, throws: 0, fail: false, set: (next) => { current = next; } });
  return read;
}

/** Tailscale as a stand-in: `answer` is what it says, and it counts how often it was asked. */
function tailscale(answer) {
  const probe = async () => { probe.calls += 1; return typeof answer === "function" ? answer() : answer; };
  probe.calls = 0;
  return probe;
}
const reports = (address) => ({ present: true, running: true, address, hostname: "this-computer", message: "" });
const notAsked = tailscale(() => { throw new Error("Tailscale is not asked in this test"); });

/** Waits for `check`; past `ms` it fails with `what`, or returns quietly when `quietly` is set. */
async function waitFor(check, what, ms = 8000, quietly = false) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) return quietly ? undefined : assert.fail(`${typeof what === "function" ? what() : what} (not within ${ms} ms)`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Waits until the door has read its addresses `count` more times than it had when this was asked. */
function readsMore(reader, count, what, quietly = false) {
  const from = reader.reads;
  return waitFor(() => reader.reads >= from + count,
    () => `${what}: the addresses were read ${reader.reads - from} more times`, 8000, quietly);
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

/** Branch started with the wider door asked for, reading its addresses from `reader` every tick. */
async function started(t, { addresses, probe = notAsked }) {
  const root = await mkdtemp(join(tmpdir(), "branch-door-redecide-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  saveListenSettings(app.store, app.runtime.owner, { where: "private-network" });
  const reader = addressReader(addresses);
  const printed = [];
  t.mock.method(console, "log", (...parts) => { printed.push(parts.join(" ")); });
  const server = await startServer(app, {
    dataDir: join(root, "data"), port: 0, listenAddresses: addresses, tailscale: probe,
    readListenAddresses: reader, listenCheckMs: tick,
  });
  let open = true;
  const close = async () => { if (open) { open = false; await server.close(); } };
  t.after(async () => { await close(); await app.close(); await discardTemp(root); });
  const port = Number(new URL(server.url).port);
  return { app, server, reader, printed, port, close };
}

const view = (server) => fetch(`${server.url}/api/listen`, { headers: { authorization: `Bearer ${server.token}` } })
  .then((response) => response.json());

/** The wider door is open: 0.0.0.0, and on Linux a connection to 127.0.0.2 reaches it. */
async function assertWide(t, server, port, what) {
  assert.equal(server.listeningOn(), "0.0.0.0", what);
  if (!linux) return t.diagnostic("127.0.0.2 is this computer on Linux only, so no connection was tried");
  assert.equal(await knock("127.0.0.2", port), "connected", `${what}: 127.0.0.2 reaches the wider door`);
}

/** The wider door is closed: 127.0.0.1 alone, a connection to 127.0.0.2 is refused, and the app still answers. */
async function assertClosed(t, server, port, what) {
  assert.equal(server.listeningOn(), "127.0.0.1", what);
  if (linux) assert.equal(await knock("127.0.0.2", port), "ECONNREFUSED", `${what}: 127.0.0.2 no longer reaches Branch`);
  else t.diagnostic("127.0.0.2 is this computer on Linux only, so no connection was tried");
  const answer = await fetch(`${server.url}/api/listen`, { headers: { authorization: `Bearer ${server.token}` } });
  assert.equal(answer.status, 200, `${what}: Branch still answers on 127.0.0.1`);
  return answer.json();
}

/**
 * Changes the addresses and waits for the reading after the one that saw the change: one reading is
 * acted on at a time, so by then the door has done whatever that change does. What the door did is
 * for the caller to check, so running out of time here is not a failure of its own.
 */
async function changeTo(reader, addresses, what) {
  reader.set(addresses);
  await readsMore(reader, 2, what, true);
}

/* ---------- a narrower answer closes the wider door at once ---------- */

test("the door closes when this computer gains a public IPv4 address, and 127.0.0.1 still answers", async (t) => {
  const { server, reader, printed, port } = await started(t, { addresses: [loopback, home] });
  await assertWide(t, server, port, "the door is wide to start with");

  await changeTo(reader, [loopback, home, outward(publicV4)], "a public address arrived");
  const seen = await assertClosed(t, server, port, "within one reading of the change the wider door is closed");
  assert.match(seen.refusal, /203\.0\.113\.7, which is not a private address/);
  assert.equal(seen.beyondThisComputer, false);
  assert.equal(seen.closedWhileRunning, true);
  assert.equal(seen.restartOpens, false, "the public address is still here, so a restart would not open it either");

  await readsMore(reader, 3, "the door keeps reading");
  const said = printed.filter((line) => line.includes(publicV4));
  assert.equal(said.length, 1, `why is said once: ${said.join(" | ")}`);
  assert.match(said[0], /^Branch Agent: This computer answers on 203\.0\.113\.7, which is not a private address/);
});

test("the door closes when this computer gains a 100.64 address that Tailscale does not report", async (t) => {
  const probe = tailscale(reports(ours));
  const { server, reader, port } = await started(t, { addresses: [loopback, home], probe });
  await assertWide(t, server, port, "the door is wide to start with");

  // Tailscale's own address arriving keeps the door as it is: Tailscale is asked, and confirms it.
  await changeTo(reader, [loopback, home, outward(ours)], "Tailscale's own address arrived");
  assert.equal(probe.calls, 1, "Tailscale was asked about the new address");
  await assertWide(t, server, port, "an address Tailscale reports keeps the door open");

  await changeTo(reader, [loopback, home, outward(ours), outward(other)], "another 100.64 address arrived");
  assert.equal(probe.calls, 2, "Tailscale was asked again");
  const seen = await assertClosed(t, server, port, "an address Tailscale does not report closes the door");
  assert.match(seen.refusal, /100\.99\.1\.2, which Tailscale does not report/);
});

test("the door closes when a global IPv6 address arrives with no private IPv4 network to stay on", async (t) => {
  const { server, reader, port } = await started(t, { addresses: [loopback, loopback6, outward("fd00::5")] });
  await assertWide(t, server, port, "a private IPv6 address alone opens the door");

  await changeTo(reader, [loopback, loopback6, outward("fd00::5"), outward(global6)], "a global IPv6 address arrived");
  const seen = await assertClosed(t, server, port, "with no private IPv4 network the door cannot stay open on one");
  assert.match(seen.refusal, /2001:db8::5, which is not a private address/);
  assert.equal(seen.ipv4Only, null);
});

test("a global IPv6 address beside a private IPv4 network keeps the door on private IPv4 only, and says so", async (t) => {
  const { server, reader, port } = await started(t, { addresses: [loopback, home, outward("fd00::5")] });
  await assertWide(t, server, port, "the door is wide to start with");
  const namedV6 = { host: `[fd00::5]:${port}`, authorization: `Bearer ${server.token}` };
  assert.equal(await statusFor(port, namedV6), 200, "a request may name the private IPv6 address at first");

  await changeTo(reader, [loopback, home, outward("fd00::5"), outward(global6)], "a global IPv6 address arrived");
  await assertWide(t, server, port, "the IPv4 wildcard is the same door, so it stays");
  const seen = await view(server);
  assert.match(seen.ipv4Only ?? "", /2001:db8::5.*private IPv4 networks only/);
  assert.equal(seen.refusal, null);
  assert.equal(await statusFor(port, namedV6), 403, "the names it answers to now leave out the IPv6 addresses");
  assert.equal(await statusFor(port, { ...namedV6, host: `192.168.1.40:${port}` }), 200, "and keep the private IPv4 one");
});

/** The status Branch answers `/api/listen` with, asked on 127.0.0.1 with these headers. */
function statusFor(port, headers) {
  return new Promise((resolve, reject) => {
    const call = request({ host: "127.0.0.1", port, path: "/api/listen", headers }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    call.on("error", reject);
    call.end();
  });
}

/* ---------- a wider answer never opens anything ---------- */

test("the door stays closed when the public address goes away, and says a restart opens it", async (t) => {
  const { server, reader, printed, port } = await started(t, { addresses: [loopback, home] });
  await changeTo(reader, [loopback, home, outward(publicV4)], "a public address arrived");
  await assertClosed(t, server, port, "the public address closed the door");

  await changeTo(reader, [loopback, home], "the public address went away");
  await readsMore(reader, 3, "the door keeps reading");
  const seen = await assertClosed(t, server, port, "nothing opens the door while Branch runs");
  assert.equal(seen.restartOpens, true, "the card can say that starting Branch again opens it");
  assert.equal(seen.closedWhileRunning, true);
  assert.match(seen.refusal, /203\.0\.113\.7/, "why it was closed is still what it says");
  assert.equal(printed.filter((line) => line.includes(publicV4)).length, 1, "and it was said once");

  await changeTo(reader, [loopback, home, outward(publicV4)], "the public address came back");
  assert.equal((await view(server)).restartOpens, false, "with it back, a restart would not open the door either");
});

test("under Lockdown a change of address opens nothing", async (t) => {
  const { app, server, reader, port } = await started(t, { addresses: [loopback, home] });
  setLockdown(app.store, app.runtime.owner, { on: true });
  await waitFor(() => server.listeningOn() === "127.0.0.1", "Lockdown closed the door");

  const before = reader.reads;
  await changeTo(reader, [loopback, home, outward("10.0.0.7")], "a private address arrived under Lockdown");
  assert.ok(reader.reads >= before + 2, `the door read the change under Lockdown (${reader.reads - before} readings)`);
  const seen = await assertClosed(t, server, port, "the door stays on this computer");
  assert.match(seen.refusal, /Lockdown is on/);
  assert.equal(seen.restartOpens, false, "a restart under Lockdown would not open it either");
});

test("the door never says a restart opens it while Lockdown is on", async (t) => {
  const { app, server, reader, port } = await started(t, { addresses: [loopback, home] });
  await changeTo(reader, [loopback, home, outward(publicV4)], "a public address arrived");
  await changeTo(reader, [loopback, home], "the public address went away");
  assert.equal((await view(server)).restartOpens, true, "the addresses would let a start open the door");

  setLockdown(app.store, app.runtime.owner, { on: true });
  const locked = await assertClosed(t, server, port, "Lockdown keeps the door closed");
  assert.equal(locked.restartOpens, false, "under Lockdown a start would not open it");
  setLockdown(app.store, app.runtime.owner, { on: false });
  assert.equal((await view(server)).restartOpens, true, "with Lockdown off again, a start would");
  await assertClosed(t, server, port, "and turning Lockdown off opens nothing either");
});

test("a door no longer asked for closes at the next change of address", async (t) => {
  const { app, server, reader, printed, port } = await started(t, { addresses: [loopback, home] });
  saveListenSettings(app.store, app.runtime.owner, { where: "this-computer" });
  await assertWide(t, server, port, "changing the setting takes effect at the next start");

  await changeTo(reader, [loopback, home, outward("10.0.0.7")], "a private address arrived");
  const seen = await assertClosed(t, server, port, "deciding again finds the wider door is not asked for");
  assert.match(seen.refusal, /no longer asked to listen beyond this computer/);
  assert.equal(seen.restartOpens, false, "a start would not open it either");
  assert.ok(printed.some((line) => /^Branch Agent: Branch is no longer asked to listen beyond this computer/.test(line)),
    `and says so: ${printed.join(" | ")}`);
});

test("a decision still under way when Lockdown comes on opens nothing either", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const probe = tailscale(() => held);
  const { app, server, reader, port } = await started(t, { addresses: [loopback, home], probe });
  reader.set([loopback, home, outward(ours)]);
  await waitFor(() => probe.calls === 1, "the door asked Tailscale about the new address");

  setLockdown(app.store, app.runtime.owner, { on: true });
  await waitFor(() => server.listeningOn() === "127.0.0.1", "Lockdown closed the door");
  release(reports(ours)); // decided before Lockdown, this answer would open the door
  await readsMore(reader, 2, "the decision finished");
  const seen = await assertClosed(t, server, port, "the door stays on this computer");
  assert.equal(seen.restartOpens, false, "Lockdown is on, so a restart would not open it");
});

/* ---------- the reading itself ---------- */

test("closing Branch stops reading this computer's addresses", async (t) => {
  const { reader, close } = await started(t, { addresses: [loopback, home] });
  await readsMore(reader, 3, "the door reads its addresses while it is open");
  await close();
  const after = reader.reads;
  await new Promise((resolve) => setTimeout(resolve, tick * 8));
  assert.equal(reader.reads, after, "nothing reads them once Branch is closed");
});

test("a reading that fails leaves the door as it is", async (t) => {
  const { server, reader, port } = await started(t, { addresses: [loopback, home] });
  reader.fail = true;
  await waitFor(() => reader.throws >= 3, "the door tried to read its addresses");
  await assertWide(t, server, port, "a reading that fails changes nothing");
  assert.equal((await view(server)).refusal, null);

  // And the door keeps reading: a later reading that finds a public address still closes it.
  reader.fail = false;
  await changeTo(reader, [loopback, home, outward(publicV4)], "a public address arrived");
  await assertClosed(t, server, port, "the door closed after the failed readings");
});

test("a decision that does not finish leaves the door as it is, and no second one starts beside it", async (t) => {
  const probe = tailscale(() => new Promise(() => {}));
  const { server, reader, port } = await started(t, { addresses: [loopback, home], probe });
  reader.set([loopback, home, outward(other)]);
  await waitFor(() => probe.calls === 1, "the door asked Tailscale");
  await new Promise((resolve) => setTimeout(resolve, tick * 8));
  assert.equal(probe.calls, 1, "one decision at a time");
  await assertWide(t, server, port, "the door is as it was");
});

/* ---------- the reading, on its own ---------- */

test("the reading never keeps Branch running by itself, and stops when told", async () => {
  const { watchAddresses } = await import("../dist/listen-address.js");
  const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
  const before = timers();
  let reads = 0;
  const stop = watchAddresses({
    read: () => { reads += 1; return [loopback, home]; }, everyMs: 10, first: [loopback, home], changed: async () => {},
  });
  try {
    assert.equal(timers(), before, "the timer does not hold the process open");
    await waitFor(() => reads >= 2, "it reads");
  } finally {
    stop();
  }
  const after = reads;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(reads, after, "and reads nothing once stopped");
});

test("a change the door could not act on is tried again at the next reading, and only until it is", async () => {
  const { watchAddresses } = await import("../dist/listen-address.js");
  const acted = [];
  let fail = true;
  const stop = watchAddresses({
    read: () => [loopback, home, outward(publicV4)], everyMs: 10, first: [loopback, home],
    changed: async (addresses) => {
      acted.push(addresses.length);
      if (fail) { fail = false; throw new Error("the decision could not be made"); }
    },
  });
  try {
    await waitFor(() => acted.length >= 2, () => `the change was acted on ${acted.length} times`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(acted.length, 2, "once it was acted on, the same addresses are not acted on again");
  } finally {
    stop();
  }
});

test("the addresses are compared as the door sees them", async () => {
  const { outwardAddressKey } = await import("../dist/listen-address.js");
  const key = outwardAddressKey([loopback, outward("fe80::1%eth0"), home, outward("2001:DB8::5")]);
  assert.equal(key, outwardAddressKey([outward(global6), home, outward("fe80::1"), loopback6]),
    "the order, this computer's own addresses, a zone and the case of a letter change nothing");
  assert.notEqual(key, outwardAddressKey([loopback, home]), "an address arriving or leaving is a change");
  assert.notEqual(outwardAddressKey([home]), outwardAddressKey([{ ...home, internal: true }]),
    "an address that stops being this computer's own is a change");
});
