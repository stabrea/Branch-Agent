/**
 * A checked request whose fetch did not keep to the checked addresses is reported. The network
 * policy holds a checked request to the addresses its check judged by handing them, with the
 * request's options, to Branch's own sender (src/pinned-fetch.ts). A fetch placed under the check
 * that does not hand those options on, for instance one that builds a new request from them, never
 * reaches that sender. Such a request is not refused: its answer, or its failure, is passed on
 * exactly as that fetch gave it. Branch says so in one warning line for each such fetch, naming the
 * site and nothing of the path or the query. A request left unheld on purpose (one a proxy carries,
 * an address written out, or any request while private addresses are allowed) is never reported.
 *
 * Nothing here reaches the network. The policy's own lookup answers the check from a table, a
 * stand-in for this computer's name lookups answers anything that would look a name up a second
 * time, and every site is a local server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { createServer } from "node:http";
import { once } from "node:events";
import { NetworkPolicy } from "../dist/network-policy.js";
import { pinnedFetch } from "../dist/pinned-fetch.js";
import { processNetworkHooks } from "../dist/comfort/network.js";

/** A local server that notes the path of every request that reaches it and answers `words`. */
async function localServer(t, words = "local") {
  const seen = [];
  const server = createServer((request, response) => { seen.push(request.url); response.end(words); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { seen, port: server.address().port };
}

/** Stands in for this computer's own name lookups while a test runs: it answers only the names in `answers` and never asks a name server. */
function systemLookups(t, answers) {
  const real = dns.lookup;
  dns.lookup = function lookupStandIn(hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    const address = answers[hostname];
    if (!address) {
      process.nextTick(callback, Object.assign(new Error(`${hostname} was not meant to be looked up`), { code: "ENOTFOUND" }));
      return;
    }
    if (options?.all) process.nextTick(callback, null, [{ address, family: 4 }]);
    else process.nextTick(callback, null, address, 4);
  };
  t.after(() => { dns.lookup = real; });
}

/** A policy whose check answers names from `names`, and whose dialling seam notes each judged address and sends it to a local server. */
function policyWith(names, config = {}) {
  const dialled = [];
  const resolve = async (host) => {
    if (!names[host]) throw new Error(`${host} was not meant to be looked up by the check`);
    return names[host];
  };
  const dial = (address) => { dialled.push(address); return "127.0.0.1"; };
  return { policy: new NetworkPolicy(config, resolve, dial), dialled };
}

/** Keeps every warning line written while the test runs instead of printing it; call the result to read them. */
function warnings(t) {
  const warn = t.mock.method(console, "warn", () => undefined);
  return () => warn.mock.calls.map((call) => call.arguments.join(" "));
}

const { setGlobalProxyFromEnv } = await import("node:http");

test("a fetch that builds a new request without the checked addresses is reported once, and each answer is passed on as it came", async (t) => {
  const site = await localServer(t, "answered by that fetch");
  systemLookups(t, { "site.test": "127.0.0.1" });
  const { policy, dialled } = policyWith({ "site.test": ["93.184.216.34"] });
  const warned = warnings(t);
  const given = [];
  const rebuilds = async (input, init) => {
    const response = await fetch(new Request(input, { method: init?.method, headers: init?.headers }));
    given.push(response);
    return response;
  };
  const guarded = policy.guard(rebuilds);
  const answers = [
    await guarded(`http://site.test:${site.port}/inbox/letters?token=kept-out-of-the-record`),
    await guarded(`http://site.test:${site.port}/second`),
    await policy.guard(rebuilds)(`http://site.test:${site.port}/third`),
  ];
  assert.equal(answers.length, given.length);
  for (const [at, answer] of answers.entries()) {
    assert.equal(answer, given[at], "the answer is the very one that fetch gave");
    assert.equal(await answer.text(), "answered by that fetch");
  }
  assert.deepEqual(dialled, [], "the addresses the check judged were never used");
  const lines = warned();
  assert.equal(lines.length, 1, "one warning for that fetch, not one for each request");
  assert.match(lines[0], /did not keep to the checked addresses/);
  assert.match(lines[0], /site\.test/, "the warning names the site");
  assert.doesNotMatch(lines[0], /inbox|letters|token|kept-out|second|third/, "and never the path or the query");
});

test("each fetch that does not keep to the checked addresses is reported on its own", async (t) => {
  const { policy } = policyWith({ "one.test": ["93.184.216.34"], "two.test": ["93.184.216.35"] });
  const warned = warnings(t);
  const answersItself = (words) => async () => new Response(words);
  const first = answersItself("first"), second = answersItself("second");
  assert.equal(await (await policy.guard(first)("https://one.test/")).text(), "first");
  assert.equal(await (await policy.guard(first)("https://two.test/")).text(), "first");
  assert.equal(await (await policy.guard(second)("https://two.test/")).text(), "second");
  const lines = warned();
  assert.equal(lines.length, 2, "one warning for each fetch");
  assert.match(lines[0], /one\.test/);
  assert.match(lines[1], /two\.test/);
});

test("a fetch that fails without keeping to the checked addresses is reported, and its own failure is passed on", async (t) => {
  const { policy } = policyWith({ "site.test": ["93.184.216.34"] });
  const warned = warnings(t);
  const refused = new TypeError("fetch failed");
  const rejects = async () => { throw refused; };
  const thrown = new Error("thrown before any answer");
  const throws = () => { throw thrown; };
  await assert.rejects(policy.guard(rejects)("https://site.test/"), (error) => error === refused);
  await assert.rejects(policy.guard(throws)("https://site.test/"), (error) => error === thrown);
  const lines = warned();
  assert.equal(lines.length, 2, "one warning for each fetch");
  assert.ok(lines.every((line) => /did not keep to the checked addresses/.test(line)), lines.join("\n"));
});

test("the platform's fetch and fetches that hand their options on are never reported", async (t) => {
  const site = await localServer(t);
  systemLookups(t, {});
  const { policy, dialled } = policyWith({ "site.test": ["93.184.216.34"] });
  const warned = warnings(t);
  const handsOn = (input, init) => pinnedFetch(input, { ...init });
  const handsOnLater = async (input, init) => {
    await new Promise((resolve) => setImmediate(resolve));
    return pinnedFetch(input, init);
  };
  for (const base of [globalThis.fetch, handsOn, handsOnLater])
    assert.equal(await (await policy.guard(base)(`http://site.test:${site.port}/`)).text(), "local");
  assert.deepEqual(dialled, ["93.184.216.34", "93.184.216.34", "93.184.216.34"], "each request went to the address its check judged");
  const moved = (_input, init) => pinnedFetch(`http://127.0.0.1:${site.port}/`, init);
  await assert.rejects(policy.guard(moved)(`http://site.test:${site.port}/`), /fetch failed/);
  assert.equal(site.seen.length, 3, "a request whose address was changed is refused by the sender before anything is sent");
  assert.deepEqual(warned(), []);
});

test("a request left unheld on purpose is never reported: one a proxy carries, an address written out, any while private addresses are allowed",
  { skip: typeof setGlobalProxyFromEnv !== "function" && "this Node cannot be given a proxy at all" }, async (t) => {
  const { policy, dialled } = policyWith({ "site.test": ["93.184.216.34"] });
  const { policy: open } = policyWith({ "site.test": ["93.184.216.34"] }, { allowPrivateAddresses: true });
  const warned = warnings(t);
  const asked = [];
  const answersItself = async (input) => { asked.push(String(input)); return new Response("answered"); };
  assert.equal(await (await policy.guard(answersItself)("http://93.184.216.34/")).text(), "answered");
  assert.equal(await (await open.guard(answersItself)("http://site.test/")).text(), "answered");
  const undo = processNetworkHooks().setProxy({ HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" });
  try {
    assert.equal(await (await policy.guard(answersItself)("http://site.test/")).text(), "answered");
  } finally { undo(); }
  assert.deepEqual(asked, ["http://93.184.216.34/", "http://site.test/", "http://site.test/"], "each request reached the fetch");
  assert.deepEqual(dialled, [], "none was held to a judged address");
  assert.deepEqual(warned(), []);
});

test("a warning that cannot be written changes nothing: the answer or the failure is passed on as it came", async (t) => {
  const { policy } = policyWith({ "site.test": ["93.184.216.34"] });
  const warn = t.mock.method(console, "warn", () => { throw new Error("the console is gone"); });
  const answer = new Response("as it came");
  assert.equal(await policy.guard(async () => answer)("https://site.test/"), answer);
  const refused = new TypeError("fetch failed");
  await assert.rejects(policy.guard(async () => { throw refused; })("https://site.test/"), (error) => error === refused);
  assert.equal(warn.mock.callCount(), 2, "a warning was tried for each fetch");
});
