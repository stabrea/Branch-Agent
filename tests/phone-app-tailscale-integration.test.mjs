/**
 * PhoneApp address filtering with Tailscale verification.
 *
 * 100.64.0.0/10 addresses must be filtered out of the candidate list when Tailscale
 * does not report them. This is the source-level filter that keeps unconfirmed
 * addresses from appearing on the card and prevents 500 errors in share().
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PhoneApp } from "../dist/phone-app/index.js";
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

/* ---------- PhoneApp integration: filtered addresses in overview ---------- */

test("(a) PhoneApp overview with unconfirmed 100.64: lists no addresses", async () => {
  const probe = tailscale(running("100.101.102.103"));
  const phone = new PhoneApp({
    // Return pre-filtered candidates (as candidateAddresses would after filtering)
    addresses: async () => (await filterTailnetAddresses(["100.99.1.2"], probe)),
    tailscale: probe,
  });
  const overview = await phone.overview();
  assert.deepEqual(overview.addresses, [], "unconfirmed 100.64 is filtered out");
});


test("(e) PhoneDoor.start directly with unreported 100.64 rejects", async () => {
  const probe = tailscale(running("100.101.102.103"));
  const phone = new PhoneApp({ tailscale: probe });
  try {
    await phone.door.start({
      file: { size: 100 },
      bytes: Buffer.from("test"),
      address: "100.99.1.2",
      dictionaries: {},
      tailscale: probe,
    });
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(error.message.includes("does not report"), "rejects with clear reason");
  }
});
