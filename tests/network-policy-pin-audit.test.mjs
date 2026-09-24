/**
 * A checked request whose fetch did not keep to the checked addresses is refused. The network
 * policy holds a checked request to the addresses its check judged by handing them, with the
 * request's options, to Branch's own sender (src/pinned-fetch.ts). A fetch placed under the check
 * that does not hand those options on, for instance one that builds a new request from them, never
 * reaches that sender. Whatever such a fetch does (answers, fails or throws), the check refuses the
 * request with a plain reason that names the site and nothing of the path or the query, and lets go
 * of any answer it gave. The platform's fetch and fetches that hand their options on are unchanged,
 * and a request left unheld on purpose (one a proxy carries, an address written out, or any request
 * while private addresses are allowed) goes to its fetch as before.
 *
 * Nothing here reaches the network. The policy's own lookup answers the check from a table, a
 * stand-in for this computer's name lookups refuses every name and notes it, and the one site is a
 * local server that stands for the address the check judged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { createServer } from "node:http";
import { once } from "node:events";
import { NetworkPolicy } from "../dist/network-policy.js";
import { pinnedFetch } from "../dist/pinned-fetch.js";
import { processNetworkHooks } from "../dist/comfort/network.js";

/** A local server that stands for the address the check judged. It notes the path of every request that reaches it and answers "local". */
async function checkedSite(t) {
  const seen = [];
  const server = createServer((request, response) => { seen.push(request.url); response.end("local"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { seen, port: server.address().port };
}

/** Stands in for this computer's own name lookups while a test runs: it refuses every name, never asks a name server, and notes each name asked. */
function systemLookups(t) {
  const real = dns.lookup;
  const asked = [];
  dns.lookup = function lookupStandIn(hostname, options, callback) {
    if (typeof options === "function") callback = options;
    asked.push(hostname);
    process.nextTick(callback, Object.assign(new Error(`${hostname} was not meant to be looked up`), { code: "ENOTFOUND" }));
  };
  t.after(() => { dns.lookup = real; });
  return asked;
}

/** A policy whose check answers names from `names`, and whose dialling seam notes each judged address and sends it to the local server. */
function policyWith(names, config = {}) {
  const dialled = [];
  const resolve = async (host) => {
    if (!names[host]) throw new Error(`${host} was not meant to be looked up by the check`);
    return names[host];
  };
  const dial = (address) => { dialled.push(address); return "127.0.0.1"; };
  return { policy: new NetworkPolicy(config, resolve, dial), dialled };
}

const settle = (promise) => promise.then((value) => value, (error) => error);
const unkept = /did not keep to the checked addresses/;
const { setGlobalProxyFromEnv } = await import("node:http");

test("a fetch that builds a new request without the checked addresses is refused, and nothing reaches the checked address", async (t) => {
  const checked = await checkedSite(t);
  const asked = systemLookups(t);
  const { policy, dialled } = policyWith({ "site.test": ["93.184.216.34"] });
  const rebuilds = (input, init) => fetch(new Request(input, { method: init?.method, headers: init?.headers }));
  const refusal = await settle(policy.guard(rebuilds)(`http://site.test:${checked.port}/inbox/letters?token=kept-out-of-the-record`));
  assert.ok(refusal instanceof Error, "the request is refused");
  assert.match(refusal.message, unkept);
  assert.match(refusal.message, /site\.test/, "the refusal names the site");
  assert.doesNotMatch(refusal.message, /inbox|letters|token|kept-out/, "and never the path or the query");
  assert.deepEqual(checked.seen, [], "nothing reached the checked address");
  assert.deepEqual(dialled, [], "the addresses the check judged were never used");
  assert.ok(asked.includes("site.test"), "that fetch looked the name up again on its own");
});

test("an answer from a fetch that did not keep to the checked addresses is refused every time, and each answer is let go", async (t) => {
  const checked = await checkedSite(t);
  const { policy, dialled } = policyWith({ "site.test": ["93.184.216.34"] });
  const letGo = [];
  // The body stays open, as an answer still arriving would, so letting it go is seen.
  const answersItself = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("an answer from somewhere else")); },
    cancel(reason) { letGo.push(reason); },
  }));
  const guarded = policy.guard(answersItself);
  await assert.rejects(guarded(`http://site.test:${checked.port}/first`), unkept);
  await assert.rejects(guarded(`http://site.test:${checked.port}/second`), unkept, "the same fetch is refused again");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(letGo.length, 2, "each answer's body was let go");
  assert.deepEqual(checked.seen, []);
  assert.deepEqual(dialled, []);
});

test("a fetch that fails or throws without keeping to the checked addresses is refused, with its own failure kept as the cause", async () => {
  const { policy, dialled } = policyWith({ "site.test": ["93.184.216.34"] });
  const failed = new TypeError("fetch failed");
  const thrown = new Error("thrown before any answer");
  for (const [base, cause] of [[async () => { throw failed; }, failed], [() => { throw thrown; }, thrown]]) {
    const refusal = await settle(policy.guard(base)("https://site.test/"));
    assert.ok(refusal instanceof Error && unkept.test(refusal.message), `refused with the plain reason, not ${refusal}`);
    assert.equal(refusal.cause, cause, "the fetch's own failure is kept as the cause");
  }
  assert.deepEqual(dialled, []);
});

test("the platform's fetch and fetches that hand their options on are unchanged: each is held to the judged address and answered", async (t) => {
  const checked = await checkedSite(t);
  const asked = systemLookups(t);
  const { policy, dialled } = policyWith({ "site.test": ["93.184.216.34"] });
  const handsOn = (input, init) => pinnedFetch(input, { ...init });
  const handsOnLater = async (input, init) => {
    await new Promise((resolve) => setImmediate(resolve));
    return pinnedFetch(input, init);
  };
  for (const base of [globalThis.fetch, handsOn, handsOnLater])
    assert.equal(await (await policy.guard(base)(`http://site.test:${checked.port}/`)).text(), "local");
  assert.equal(checked.seen.length, 3);
  assert.deepEqual(dialled, ["93.184.216.34", "93.184.216.34", "93.184.216.34"], "each request went to the address its check judged");
  assert.deepEqual(asked, [], "and none looked the name up again");
  // A request the checked sender took keeps the sender's own answer, a refusal included.
  const moved = (_input, init) => pinnedFetch(`http://127.0.0.1:${checked.port}/`, init);
  const refused = await settle(policy.guard(moved)(`http://site.test:${checked.port}/`));
  assert.match(String(refused?.message), /fetch failed/);
  assert.match(String(refused?.cause?.message), /site\.test was checked, not 127\.0\.0\.1/);
  assert.equal(checked.seen.length, 3, "a request whose address was changed is not sent");
});

test("a request left unheld on purpose goes to its fetch as before: one a proxy carries, an address written out, any while private addresses are allowed",
  { skip: typeof setGlobalProxyFromEnv !== "function" && "this Node cannot be given a proxy at all" }, async () => {
  const { policy, dialled } = policyWith({ "site.test": ["93.184.216.34"] });
  const { policy: open } = policyWith({ "site.test": ["93.184.216.34"] }, { allowPrivateAddresses: true });
  const asked = [];
  const answersItself = async (input) => { asked.push(String(input)); return new Response("answered"); };
  assert.equal(await (await policy.guard(answersItself)("http://93.184.216.34/")).text(), "answered");
  assert.equal(await (await open.guard(answersItself)("http://site.test/")).text(), "answered");
  const undo = processNetworkHooks().setProxy({ HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" });
  try {
    assert.equal(await (await policy.guard(answersItself)("http://site.test/")).text(), "answered");
  } finally { undo(); }
  assert.deepEqual(asked, ["http://93.184.216.34/", "http://site.test/", "http://site.test/"], "each request reached its fetch");
  assert.deepEqual(dialled, [], "none was held to a judged address");
});
