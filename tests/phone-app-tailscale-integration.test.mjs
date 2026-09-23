/**
 * PhoneApp address filtering with Tailscale verification.
 *
 * 100.64.0.0/10 addresses must be filtered out of the candidate list when Tailscale
 * does not report them. This is the source-level filter that keeps unconfirmed
 * addresses from appearing on the card and prevents 500 errors in share().
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { noAddressRefusal, PhoneApp, PhoneAppRefusal, pickedAddressRefusal } from "../dist/phone-app/index.js";
import { PhoneDoor } from "../dist/phone-app/door.js";
import { filterTailnetAddresses } from "../dist/phone-app/address.js";

const running = (address) => ({ present: true, running: true, address, hostname: "desk.tail1234.ts.net", message: "" });
const notRunning = { present: true, running: false, address: null, hostname: null, message: "Tailscale is installed but not signed in." };
const missing = { present: false, running: false, address: null, hostname: null, message: "Tailscale is not installed on this computer." };

function tailscale(answer) {
  const probe = async () => {
    probe.calls += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  probe.calls = 0;
  return probe;
}

/* ---------- filterTailnetAddresses directly ---------- */

test("(a) unconfirmed 100.64 is filtered out", async () => {
  const probe = tailscale(running("100.101.102.103"));
  const filtered = await filterTailnetAddresses(["100.99.1.2"], probe);
  assert.deepEqual(filtered, [], "unconfirmed 100.64 is filtered out");
});

test("(b) confirmed 100.64 is kept", async () => {
  const addr = "100.101.102.103";
  const probe = tailscale(running(addr));
  const filtered = await filterTailnetAddresses([addr], probe);
  assert.deepEqual(filtered, [addr], "confirmed 100.64 is kept");
  assert.equal(probe.calls, 1, "Tailscale was probed");
});

test("(c) when Tailscale probe fails, 100.64 is filtered out", async () => {
  const answers = [notRunning, missing, new Error("timeout")];
  for (const answer of answers) {
    const probe = tailscale(answer);
    const filtered = await filterTailnetAddresses(["100.99.1.2"], probe);
    assert.deepEqual(filtered, [], `100.64 filtered when probe returns: ${answer?.message || answer}`);
  }
});

test("(d) home address + unconfirmed 100.64 filters the 100.64", async () => {
  const probe = tailscale(running("100.101.102.103"));
  const filtered = await filterTailnetAddresses(["192.168.1.100", "100.99.1.2"], probe);
  assert.deepEqual(filtered, ["192.168.1.100"], "home kept, 100.64 filtered");
  assert.equal(probe.calls, 1, "Tailscale probed for the 100.64");
});

/* ---------- PhoneApp: the card and the share go through the same check ---------- */

/** A phone app on disk, so share() gets as far as choosing an address. */
async function fakeApp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-phone-ts-"));
  t.after(() => discardTemp(root));
  await mkdir(join(root, "phone"));
  const path = join(root, "phone", "Branch-Agent-android.apk");
  const bytes = Buffer.concat([Buffer.from("PK"), randomBytes(2_000)]);
  await writeFile(path, bytes);
  await writeFile(`${path}.sha256`, `${createHash("sha256").update(bytes).digest("hex")}  Branch-Agent-android.apk\n`);
  return root;
}

test("a 100.64 address Tailscale does not report is never offered, and sharing on it is refused plainly", async (t) => {
  const root = await fakeApp(t);
  const probe = tailscale(running("100.101.102.103"));
  const phone = new PhoneApp({ root, env: {}, addresses: async () => ["100.99.1.2"], tailscale: probe });
  assert.deepEqual((await phone.overview()).addresses, []);
  await assert.rejects(phone.share({}), (error) => error instanceof PhoneAppRefusal && error.status === 409 && error.message === noAddressRefusal);
  await assert.rejects(phone.share({ address: "100.99.1.2" }), (error) => error instanceof PhoneAppRefusal && error.status === 400 && error.message === pickedAddressRefusal);
  assert.equal(phone.door.view(), null);
});

test("with Tailscale stopped, missing or failing, a 100.64 address is not offered but the home address is", async (t) => {
  const root = await fakeApp(t);
  for (const answer of [notRunning, missing, new Error("tailscale did not answer")]) {
    const phone = new PhoneApp({ root, env: {}, addresses: async () => ["192.168.1.100", "100.99.1.2"], tailscale: tailscale(answer) });
    assert.deepEqual((await phone.overview()).addresses, ["192.168.1.100"], String(answer?.message ?? answer));
  }
});

test("the address Tailscale reports is offered", async (t) => {
  const root = await fakeApp(t);
  const phone = new PhoneApp({ root, env: {}, addresses: async () => ["100.101.102.103"], tailscale: tailscale(running("100.101.102.103")) });
  assert.deepEqual((await phone.overview()).addresses, ["100.101.102.103"]);
});

test("Tailscale that stops between the list and the share is refused at the door, in plain words", async (t) => {
  const root = await fakeApp(t);
  let calls = 0;
  const probe = async () => (++calls === 1 ? running("100.101.102.103") : notRunning);
  const phone = new PhoneApp({ root, env: {}, addresses: async () => ["100.101.102.103"], tailscale: probe });
  await assert.rejects(phone.share({}), (error) => error instanceof PhoneAppRefusal && error.status === 409 && error.message === noAddressRefusal);
  assert.ok(calls >= 2, "Tailscale was asked again at the door");
  assert.equal(phone.door.view(), null);
});

test("PhoneDoor.start itself refuses a 100.64 address Tailscale does not report", async () => {
  const probe = tailscale(running("100.101.102.103"));
  const door = new PhoneDoor();
  await assert.rejects(door.start({ file: { size: 4 }, bytes: Buffer.from("test"), address: "100.99.1.2", dictionaries: {}, tailscale: probe }), /does not report/);
  assert.equal(door.view(), null);
});

test("sharing asks Tailscale once for the door, so the door cannot refuse later without saying why", async (t) => {
  const root = await fakeApp(t);
  let calls = 0;
  // Running on the first two asks (the list, then the door), stopped after: a third ask would refuse.
  const probe = async () => (++calls <= 2 ? running("100.101.102.103") : notRunning);
  const phone = new PhoneApp({ root, env: {}, addresses: async () => ["100.101.102.103"], tailscale: probe });
  // The address is not this machine's, so opening the door fails at listen; what matters is that
  // Tailscale was asked twice, never a third time, and no plain "not running" came back.
  await phone.share({}).then(() => phone.stop(), (error) => assert.doesNotMatch(String(error), /Tailscale is not running/));
  assert.equal(calls, 2);
});

test("share is cancelled if stop() is called during the share awaits", async (t) => {
  const root = await fakeApp(t);
  // A Tailscale probe that takes 400 ms to respond, simulating a slow network or probing delay.
  const probe = async () => {
    await new Promise(resolve => setTimeout(resolve, 400));
    return running("100.101.102.103");
  };
  const phone = new PhoneApp({ root, env: {}, addresses: async () => ["100.101.102.103"], tailscale: probe });

  // Start the share, then call stop() after 150 ms (before the Tailscale probe completes).
  const sharePromise = phone.share({});
  await new Promise(resolve => setTimeout(resolve, 150));
  phone.stop();

  // The share should be rejected because stop() was called during the awaits.
  await assert.rejects(sharePromise, (error) => error instanceof PhoneAppRefusal && error.status === 409 && error.message === "Share was cancelled");

  // The door should not be open.
  assert.equal(phone.door.view(), null);
});
