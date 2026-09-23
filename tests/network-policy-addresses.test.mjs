/**
 * Which addresses the network rules count as this computer or a private network. An IPv4 address
 * can be written as an IPv6 one (mapped, compatible, translated, NAT64, 6to4, Teredo) and can be
 * spelled in octal, hex or as one number; every spelling is judged by the IPv4 address it carries.
 * Checked through a web address, through a name that resolves to it, and straight on the classifier.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { NetworkPolicy, isPrivateAddress } from "../dist/network-policy.js";
import { fetchChecked } from "../dist/web-page-fetch.js";

const refusedHosts = [
  "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:a9fe:a9fe]", "[::ffff:169.254.169.254]", "[::ffff:10.1.2.3]",
  "[::ffff:100.64.0.1]", "[::127.0.0.1]", "[::a9fe:a9fe]", "[::ffff:0:7f00:1]", "[::ffff:0:192.168.0.1]",
  "[64:ff9b::7f00:1]", "[64:ff9b::10.0.0.1]", "[64:ff9b:1::5db8:d822]",
  "[2002:7f00:0001::]", "[2002:c0a8:0101::1]", "[2002:a9fe:a9fe::]",
  "[2001:0000:4136:e378:8000:63bf:80ff:fffe]", "[2001:0:a9fe:a9fe::f7ff:f7ff]",
  "[::]", "[::1]", "[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[febf::1]", "[ff02::1]", "[ff05::2]",
  "0.0.0.0", "0.1.2.3", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.9", "192.168.1.1",
  "100.64.0.1", "100.100.100.100", "100.127.255.254", "224.0.0.1", "255.255.255.255",
  "0177.0.0.1", "127.1", "2130706433", "0x7f000001",
];
const allowedHosts = [
  "93.184.216.34", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.32.0.1",
  "[2606:2800:220:1::]", "[2001:4860:4860::8888]", "[::ffff:93.184.216.34]", "[64:ff9b::5db8:d822]",
  "[2002:5db8:d822::]", "[2001:0:4136:e378:8000:63bf:a247:27dd]",
];
/** What a name server could hand back, spellings included that a web address would have tidied. */
const refusedLookups = [
  "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::127.0.0.1", "64:ff9b::7f00:1", "::ffff:0:7f00:1",
  "2002:7f00:1::", "2001:0:4136:e378:8000:63bf:80ff:fffe", "::", "::1", "fc00::1", "fe80::1%eth0", "ff02::1",
  "0.0.0.0", "100.100.100.100", "0177.0.0.1", "127.1", "2130706433", "0x7f.0.0.1",
];

const strict = () => new NetworkPolicy({}, async () => { throw new Error("nothing here should be looked up"); });

test("every private spelling of an address is refused when written in the web address", async () => {
  const policy = strict();
  for (const host of refusedHosts)
    await assert.rejects(policy.assertAllowed(new URL(`http://${host}/x`)), /private or local address/, host);
});

test("public addresses, including public IPv4 carried inside IPv6, are still reachable", async () => {
  const policy = strict();
  for (const host of allowedHosts) await policy.assertAllowed(new URL(`http://${host}/x`));
  // Dotted spellings a name server may return untidied are decoded too, not refused by accident.
  for (const address of ["93.184.216.34", "2606:2800:220:1::", "::ffff:93.184.216.34", "::93.184.216.34",
    "64:ff9b::93.184.216.34", "::ffff:0:93.184.216.34", "2002:5db8:d822::"])
    assert.equal(isPrivateAddress(address), false, address);
});

test("a name that resolves to any private spelling is refused, alone or among public answers", async () => {
  for (const address of refusedLookups) {
    assert.equal(isPrivateAddress(address), true, address);
    const policy = new NetworkPolicy({}, async () => [address]);
    await assert.rejects(policy.assertAllowed(new URL("https://example.com/")), /private or local address/, address);
    const mixed = new NetworkPolicy({}, async () => ["93.184.216.34", address]);
    await assert.rejects(mixed.assertAllowed(new URL("https://example.com/")), /private or local address/, address);
  }
  const plain = new NetworkPolicy({}, async () => ["93.184.216.34", "2606:2800:220:1::"]);
  await plain.assertAllowed(new URL("https://example.com/"));
});

test("allowing private addresses still lets every private spelling through", async () => {
  const policy = new NetworkPolicy({ allowPrivateAddresses: true }, async () => ["::ffff:127.0.0.1"]);
  for (const host of refusedHosts) await policy.assertAllowed(new URL(`http://${host}/x`));
  await policy.assertAllowed(new URL("https://example.com/"));
});

test("reading a page at [::ffff:127.0.0.1] never reaches the local server", async (t) => {
  let hits = 0;
  const server = createServer((_request, response) => { hits += 1; response.writeHead(200, { "content-type": "text/plain" }); response.end("local"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const target = `http://[::ffff:127.0.0.1]:${server.address().port}/secret`;
  const deps = (policy) => ({ policy, fetch: (url, init) => fetch(url, init), timeoutMs: 5000, maxBytes: 100000, userAgent: "BranchAgent" });
  await assert.rejects(fetchChecked(deps(new NetworkPolicy({})), target, new AbortController().signal), /private or local address/);
  assert.equal(hits, 0, "the refused address was never sent a request");
  // The same address is reachable once private addresses are allowed, so the 0 above means something.
  const page = await fetchChecked(deps(new NetworkPolicy({ allowPrivateAddresses: true })), target, new AbortController().signal);
  assert.equal(page.body, "local");
  assert.equal(hits, 1);
});
