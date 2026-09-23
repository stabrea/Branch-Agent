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
  "198.18.0.1", "198.19.255.254", "192.0.0.8", "192.0.0.170", "[::ffff:198.18.0.1]", "[::ffff:192.0.0.9]",
  "0177.0.0.1", "127.1", "2130706433", "0x7f000001",
];
const allowedHosts = [
  "93.184.216.34", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.32.0.1",
  "198.17.255.255", "198.20.0.1", "192.0.1.1", "191.255.255.255",
  "[2606:2800:220:1::]", "[2001:4860:4860::8888]", "[::ffff:93.184.216.34]", "[64:ff9b::5db8:d822]",
  "[2002:5db8:d822::]", "[2001:0:4136:e378:8000:63bf:a247:27dd]",
];
/** What a name server could hand back, spellings included that a web address would have tidied. */
const refusedLookups = [
  "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::127.0.0.1", "64:ff9b::7f00:1", "::ffff:0:7f00:1",
  "2002:7f00:1::", "2001:0:4136:e378:8000:63bf:80ff:fffe", "::", "::1", "fc00::1", "fe80::1%eth0", "ff02::1",
  "0.0.0.0", "100.100.100.100", "0177.0.0.1", "127.1", "2130706433", "0x7f.0.0.1",
  "198.18.0.1", "198.19.0.1", "192.0.0.8", "::ffff:c612:1", "64:ff9b::192.0.0.1",
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

/* ------------------------------------------------------------------ fake-IP proxies (198.18.0.0/15) */

/** A name server that answers the way a fake-IP proxy (Clash, Mihomo, Surge, Stash, sing-box) does. */
const fakeAnswers = { "fake.test": ["198.18.0.5"], "edge.test": ["198.19.255.254"], "home.test": ["127.0.0.1"],
  "both.test": ["198.18.0.5", "127.0.0.1"], "mapped.test": ["::ffff:198.18.0.5"], "lan.test": ["192.168.1.1"],
  "mixed.test": ["198.18.0.5", "93.184.216.34"], "public-first.test": ["93.184.216.34", "198.18.0.5"],
  "pool.test": ["198.18.0.5", "198.19.0.7"] };
const fakeResolve = async (host) => fakeAnswers[host] ?? ["93.184.216.34"];

test("by default a name that resolves into 198.18.0.0/15 is refused, and the refusal names the range and the setting", async () => {
  const policy = new NetworkPolicy({}, fakeResolve);
  const refusal = await policy.assertAllowed(new URL("https://fake.test/")).then(() => null, (error) => error.message);
  assert.match(refusal ?? "", /private or local address/);
  assert.match(refusal ?? "", /198\.18\.0\.0\/15/, "the range is named");
  assert.match(refusal ?? "", /fake-IP proxy/, "the kind of setup that causes it is named in plain words");
  assert.match(refusal ?? "", /fakeIpProxy/, "the setting that allows it is named");
  assert.equal(new NetworkPolicy({}).settings().fakeIpProxy, undefined, "the setting is left out unless the owner wrote it");
});

test("with fakeIpProxy on, a name that resolves into 198.18.0.0/15 is let through and nothing else changes", async () => {
  const policy = new NetworkPolicy({ fakeIpProxy: true }, fakeResolve);
  await policy.assertAllowed(new URL("https://fake.test/"));
  await policy.assertAllowed(new URL("https://edge.test/"));
  // A literal address in the range is still refused, however it is spelled, and never points at the setting.
  for (const literal of ["198.18.0.5", "198.19.255.254", "[::ffff:198.18.0.5]", "3323068421", "0xc6120005", "198.18.0.5."]) {
    const refusal = await policy.assertAllowed(new URL(`http://${literal}/`)).then(() => null, (error) => error.message);
    assert.match(refusal ?? "allowed", /private or local address/, literal);
    assert.doesNotMatch(refusal ?? "", /switch on/, literal);
  }
  // This computer, the home network, and a range answer mixed with one of them stay refused.
  for (const name of ["home.test", "both.test", "lan.test", "mapped.test"])
    await assert.rejects(policy.assertAllowed(new URL(`https://${name}/`)), /private or local address/, name);
  await assert.rejects(policy.assertAllowed(new URL("http://localhost/")), /this computer or a private network/);
  // Host and path rules still apply to a name the proxy answers.
  const listed = new NetworkPolicy({ fakeIpProxy: true, allowedHosts: ["example.com"] }, fakeResolve);
  await assert.rejects(listed.assertAllowed(new URL("https://fake.test/")), /not on the allowed list/);
});

test("with fakeIpProxy on, a redirect to a literal 198.18 address is refused before anything is sent to it", async () => {
  const policy = new NetworkPolicy({ fakeIpProxy: true }, fakeResolve);
  const sent = [];
  const fakeFetch = async (url) => {
    sent.push(String(url));
    return new Response("", { status: 302, headers: { location: "http://198.18.0.9/inside" } });
  };
  const deps = { policy, fetch: fakeFetch, timeoutMs: 5000, maxBytes: 100000, userAgent: "BranchAgent" };
  await assert.rejects(fetchChecked(deps, "https://fake.test/start", new AbortController().signal), /private or local address/);
  assert.deepEqual(sent, ["https://fake.test/start"], "the named site was asked, the literal hop never was");
});

test("with fakeIpProxy on, only an answer wholly inside 198.18.0.0/15 is let through; a mix with a public address is refused", async () => {
  const policy = new NetworkPolicy({ fakeIpProxy: true }, fakeResolve);
  await policy.assertAllowed(new URL("https://pool.test/"));
  // A real fake-IP proxy answers only from its own pool, so a mixed answer is not one of its answers.
  for (const name of ["mixed.test", "public-first.test"]) {
    const refusal = await policy.assertAllowed(new URL(`https://${name}/`)).then(() => null, (error) => error.message);
    assert.match(refusal ?? "allowed", /private or local address/, name);
    assert.doesNotMatch(refusal ?? "", /switch on/, `${name}: the setting is already on and would not help`);
  }
});

test("the refusal points at the fake-IP setting only when every address is in 198.18.0.0/15", async () => {
  const policy = new NetworkPolicy({}, fakeResolve);
  const reason = (name) => policy.assertAllowed(new URL(`https://${name}/`)).then(() => null, (error) => error.message);
  assert.match(await reason("pool.test") ?? "", /fakeIpProxy/, "every address is in the range, so the setting would help");
  for (const name of ["both.test", "mixed.test", "public-first.test"]) {
    const refusal = await reason(name);
    assert.match(refusal ?? "allowed", /private or local address/, name);
    assert.doesNotMatch(refusal ?? "", /fakeIpProxy|switch on/, `${name}: the setting would not make it reachable`);
  }
  assert.match(await reason("both.test") ?? "", /127\.0\.0\.1/, "the address that is really refused is named");
});
