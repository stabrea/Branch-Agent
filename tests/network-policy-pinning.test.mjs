/**
 * A checked request connects to the addresses its check judged. The check looks a name up once and
 * judges every address that came back; the connection then goes to those addresses and nowhere
 * else, and keeps the site's name for the secure handshake and the Host line. Each redirect hop is
 * checked and held the same way. A request a proxy carries (the owner's, or one Node was started
 * with) goes to the proxy by name, and only when the platform's fetch really sends it there; an
 * address written out in the web address is left as it is.
 *
 * Nothing here reaches the network. The policy's own lookup answers the check from a table. A
 * stand-in for this computer's name lookups answers anything that would look a name up a second
 * time, and notes that it was asked. The policy's dialling seam sends a judged address to a local
 * server, or refuses it, instead of the internet; the app never sets it. The proxies are local
 * servers, and a Node started for a test refuses every name lookup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NetworkPolicy } from "../dist/network-policy.js";
import { fetchChecked } from "../dist/web-page-fetch.js";
import { boundedFetch } from "../dist/integrations/bounded-fetch.js";
import { WebAccess } from "../dist/integrations/web.js";
import { OutboundNetwork, processNetworkHooks } from "../dist/comfort/network.js";
import { restoreConnections, connectionsSetting } from "../dist/connections-preset.js";
import { ModelRouter } from "../dist/models.js";
import { Store } from "../dist/store.js";

/** A local server that counts what reaches it: the path and the Host line of every request. */
async function localServer(t, answer = (request, response) => response.end("local")) {
  const seen = [];
  const server = createServer((request, response) => { seen.push({ path: request.url, host: request.headers.host }); answer(request, response); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { seen, port: server.address().port };
}

/**
 * Stands in for this computer's own name lookups while a test runs. It answers only the names in
 * `answers`, refuses every other one, never asks a real name server, and notes each name asked.
 */
function systemLookups(t, answers) {
  const real = dns.lookup;
  const asked = [];
  dns.lookup = function lookupStandIn(hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    asked.push(hostname);
    const address = answers[hostname];
    if (!address) {
      process.nextTick(callback, Object.assign(new Error(`${hostname} was not meant to be looked up`), { code: "ENOTFOUND" }));
      return;
    }
    const family = address.includes(":") ? 6 : 4;
    if (options?.all) process.nextTick(callback, null, [{ address, family }]);
    else process.nextTick(callback, null, address, family);
  };
  t.after(() => { dns.lookup = real; });
  return asked;
}

/**
 * A policy whose check answers names from `names`, and whose dialling seam notes every address a
 * connection goes for and then sends it where `to` says (a local address), or refuses it.
 */
function policyWith(names, to, config = {}) {
  const dialled = [];
  const resolve = async (host) => {
    const found = names[host];
    if (!found) throw new Error(`${host} was not meant to be looked up by the check`);
    return found;
  };
  const dial = (address) => {
    dialled.push(address);
    const target = to(address);
    if (!target) throw new Error(`${address} stands for a site on the internet, which this test never reaches`);
    return target;
  };
  return { policy: new NetworkPolicy(config, resolve, dial), dialled };
}
const nowhere = () => null;
const here = () => "127.0.0.1";
const settle = (promise) => promise.then((value) => value, (error) => error);

test("a checked name is connected to at the address its check judged, and never looked up again", async (t) => {
  const local = await localServer(t);
  const asked = systemLookups(t, { "site.test": "127.0.0.1" });
  const { policy, dialled } = policyWith({ "site.test": ["93.184.216.34"] }, nowhere);
  const outcome = await settle(policy.guard(globalThis.fetch)(`http://site.test:${local.port}/private`));
  assert.equal(local.seen.length, 0, "nothing reached the local server that a second lookup points at");
  assert.deepEqual(dialled, ["93.184.216.34"], "the connection went for the address the check judged");
  assert.deepEqual(asked, [], "the name was not looked up a second time");
  assert.ok(outcome instanceof Error, "with the judged address unreachable here, the request fails rather than going elsewhere");
});

test("a name the check judged is reached at that address, with its own name kept on the Host line", async (t) => {
  const local = await localServer(t);
  const asked = systemLookups(t, { "site.test": "127.0.0.1" });
  const { policy, dialled } = policyWith({ "site.test": ["93.184.216.34"] }, here);
  const response = await policy.guard(globalThis.fetch)(`http://site.test:${local.port}/page?q=1`, { method: "POST", body: "hello" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "local");
  assert.equal(response.url, `http://site.test:${local.port}/page?q=1`);
  assert.deepEqual(local.seen, [{ path: "/page?q=1", host: `site.test:${local.port}` }]);
  assert.deepEqual(dialled, ["93.184.216.34"]);
  assert.deepEqual(asked, [], "one lookup, by the check");
});

/** The site name a TLS hello carries (its server_name extension), null when it has none, undefined until it has all arrived. */
function helloName(bytes) {
  if (bytes.length < 5 || bytes.length < 5 + bytes.readUInt16BE(3)) return undefined;
  let at = 5 + 4 + 2 + 32;
  at += 1 + bytes[at];
  at += 2 + bytes.readUInt16BE(at);
  at += 1 + bytes[at];
  const end = at + 2 + bytes.readUInt16BE(at);
  for (at += 2; at + 4 <= end; at += 4 + bytes.readUInt16BE(at + 2)) {
    if (bytes.readUInt16BE(at) !== 0) continue;
    const length = bytes.readUInt16BE(at + 7);
    return bytes.subarray(at + 9, at + 9 + length).toString("latin1");
  }
  return null;
}

/** A local listener that reads the opening TLS hello of each connection, notes the site name it carries, and hangs up. */
async function helloListener(t) {
  const names = [];
  const listener = createNetServer((socket) => {
    let bytes = Buffer.alloc(0);
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      const name = helloName(bytes);
      if (name !== undefined) { names.push(name); socket.destroy(); }
    });
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  return { names, port: listener.address().port };
}

test("the secure handshake of a checked connection names the site, not the address", async (t) => {
  const hello = await helloListener(t);
  const asked = systemLookups(t, { "site.test": "127.0.0.1" });
  const { policy, dialled } = policyWith({ "site.test": ["93.184.216.34"] }, here);
  await settle(policy.guard(globalThis.fetch)(`https://site.test:${hello.port}/`));
  assert.deepEqual(hello.names, ["site.test"], "the hello carried the site's name, so its certificate is checked against it");
  assert.deepEqual(dialled, ["93.184.216.34"]);
  assert.deepEqual(asked, []);
});

test("every redirect hop of a page read is checked and connected to at its own judged address", async (t) => {
  const local = await localServer(t, (request, response) => {
    if (request.url === "/start") response.writeHead(302, { location: `http://second.test:${local.port}/next` }).end();
    else response.end("second page");
  });
  const asked = systemLookups(t, { "first.test": "127.0.0.1", "second.test": "127.0.0.1" });
  const { policy, dialled } = policyWith({ "first.test": ["93.184.216.34"], "second.test": ["93.184.216.35"] },
    (address) => address === "93.184.216.34" ? "127.0.0.1" : null);
  const deps = { policy, fetch: globalThis.fetch, timeoutMs: 5000, maxBytes: 100000, userAgent: "BranchAgent" };
  const outcome = await settle(fetchChecked(deps, `http://first.test:${local.port}/start`, new AbortController().signal));
  assert.deepEqual(local.seen.map((entry) => entry.path), ["/start"], "the second hop never reached the local server");
  assert.deepEqual(dialled, ["93.184.216.34", "93.184.216.35"], "each hop went for the address its own check judged");
  assert.deepEqual(asked, []);
  assert.ok(outcome instanceof Error);
});

test("both hops are reached when each judged address leads to the page, each with its own name", async (t) => {
  const local = await localServer(t, (request, response) => {
    if (request.url === "/start") response.writeHead(302, { location: `http://second.test:${local.port}/next` }).end();
    else response.writeHead(200, { "content-type": "text/plain" }).end("second page");
  });
  systemLookups(t, {});
  const { policy, dialled } = policyWith({ "first.test": ["93.184.216.34"], "second.test": ["93.184.216.35"] }, here);
  const deps = { policy, fetch: globalThis.fetch, timeoutMs: 5000, maxBytes: 100000, userAgent: "BranchAgent" };
  const page = await fetchChecked(deps, `http://first.test:${local.port}/start`, new AbortController().signal);
  assert.equal(page.body, "second page");
  assert.equal(page.hops, 1);
  assert.deepEqual(local.seen, [{ path: "/start", host: `first.test:${local.port}` }, { path: "/next", host: `second.test:${local.port}` }]);
  assert.deepEqual(dialled, ["93.184.216.34", "93.184.216.35"]);
});

test("with fakeIpProxy on, a name wholly in 198.18.0.0/15 is reached at that address and a mixed answer is refused", async (t) => {
  const local = await localServer(t);
  const asked = systemLookups(t, { "whole.test": "127.0.0.1", "mixed.test": "127.0.0.1" });
  const { policy, dialled } = policyWith({ "whole.test": ["198.18.0.5"], "mixed.test": ["198.18.0.6", "93.184.216.34"] }, here,
    { fakeIpProxy: true });
  const guarded = policy.guard(globalThis.fetch);
  assert.equal(await (await guarded(`http://whole.test:${local.port}/`)).text(), "local");
  await assert.rejects(guarded(`http://mixed.test:${local.port}/`), /alongside addresses outside it/);
  assert.deepEqual(dialled, ["198.18.0.5"], "only the whole-pool answer was dialled");
  assert.equal(local.seen.length, 1);
  assert.deepEqual(asked, []);
});

test("a checked answer reads like any fetch answer: compressed bodies undone, repeated headers kept, a stop ends it with its own reason", async (t) => {
  const { gzipSync } = await import("node:zlib");
  const local = await localServer(t, (request, response) => {
    if (request.url === "/packed") {
      response.writeHead(200, [["content-encoding", "gzip"], ["set-cookie", "a=1"], ["set-cookie", "b=2"], ["content-type", "text/plain"]]);
      response.end(gzipSync("unpacked words"));
    } else if (request.url === "/empty") response.writeHead(204).end();
    else { response.writeHead(200, { "content-type": "text/plain" }); response.write("first part"); }
  });
  systemLookups(t, {});
  const { policy } = policyWith({ "site.test": ["93.184.216.34"] }, here);
  const guarded = policy.guard(globalThis.fetch);
  const packed = await guarded(`http://site.test:${local.port}/packed`);
  assert.equal(await packed.text(), "unpacked words");
  assert.deepEqual(packed.headers.getSetCookie(), ["a=1", "b=2"]);
  assert.equal((await guarded(`http://site.test:${local.port}/empty`)).status, 204);
  await assert.rejects(guarded(`http://site.test:${local.port}/`, { signal: AbortSignal.abort(new Error("stopped before sending")) }), /stopped before sending/);
  const stopper = new AbortController();
  const slow = await guarded(`http://site.test:${local.port}/slow`, { signal: stopper.signal });
  const reader = slow.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first part");
  stopper.abort(new Error("stopped part way"));
  await assert.rejects(reader.read(), /stopped part way/);
});

test("an address written out is connected to as written, with nothing looked up", async (t) => {
  const local = await localServer(t);
  const asked = systemLookups(t, {});
  const { policy, dialled } = policyWith({}, nowhere, { allowPrivateAddresses: true });
  assert.equal(await (await policy.guard(globalThis.fetch)(`http://127.0.0.1:${local.port}/`)).text(), "local");
  assert.deepEqual(dialled, [], "nothing to hold it to: the address is the one written");
  assert.deepEqual(asked, []);
});

test("a checked request does not follow a redirect on its own", async (t) => {
  let calls = 0;
  const { policy } = policyWith({ "site.test": ["93.184.216.34"] }, here);
  const counted = policy.guard(async () => { calls += 1; return new Response("followed"); });
  await assert.rejects(counted("https://site.test/", { redirect: "follow" }), /redirect/);
  assert.equal(calls, 0, "nothing was sent");
  const local = await localServer(t, (request, response) => {
    if (request.url === "/moved") response.writeHead(302, { location: `http://site.test:${local.port}/elsewhere` }).end();
    else response.end("elsewhere");
  });
  systemLookups(t, {});
  const guarded = policy.guard(globalThis.fetch);
  const refused = await settle(guarded(`http://site.test:${local.port}/moved`));
  assert.match(String(refused?.cause?.message), /unexpected redirect/, "a redirect nobody asked to handle is refused");
  assert.equal((await guarded(`http://site.test:${local.port}/moved`, { redirect: "manual" })).status, 302, "a caller that handles it gets it");
  assert.deepEqual(local.seen.map((entry) => entry.path), ["/moved", "/moved"], "and the next address was never asked for");
});

test("a request whose address changed after its check is not sent", async (t) => {
  const local = await localServer(t);
  systemLookups(t, {});
  const { policy, dialled } = policyWith({ "site.test": ["93.184.216.34"] }, here);
  const { pinnedFetch } = await import("../dist/pinned-fetch.js");
  const swapped = policy.guard((_input, init) => pinnedFetch(`http://127.0.0.1:${local.port}/`, init));
  const outcome = await settle(swapped(`http://site.test:${local.port}/`));
  assert.equal(local.seen.length, 0, "nothing reached the address it was changed to");
  assert.deepEqual(dialled, []);
  assert.match(String(outcome?.cause?.message), /site\.test was checked, not 127\.0\.0\.1/);
});

test("the size-limited fetch the tool servers use is held to the judged address too", async (t) => {
  const local = await localServer(t);
  const asked = systemLookups(t, { "tools.test": "127.0.0.1" });
  const { policy, dialled } = policyWith({ "tools.test": ["93.184.216.34"] }, nowhere);
  await settle(policy.guard(boundedFetch)(`http://tools.test:${local.port}/mcp`));
  assert.equal(local.seen.length, 0);
  assert.deepEqual(dialled, ["93.184.216.34"]);
  assert.deepEqual(asked, []);
});

test("reading a page through web access is held to the judged address", async (t) => {
  const local = await localServer(t);
  const asked = systemLookups(t, { "page.test": "127.0.0.1" });
  const { policy, dialled } = policyWith({ "page.test": ["93.184.216.34"] }, nowhere);
  const web = new WebAccess({});
  Object.defineProperty(web, "policy", { value: policy });
  await settle(web.fetchPage(`http://page.test:${local.port}/`));
  assert.equal(local.seen.length, 0);
  assert.deepEqual(dialled, ["93.184.216.34"]);
  assert.deepEqual(asked, []);
});

test("a saved model connection's calls are held to the judged address", async (t) => {
  const hello = await helloListener(t);
  const asked = systemLookups(t, { "models.test": "127.0.0.1" });
  const { policy, dialled } = policyWith({ "models.test": ["93.184.216.34"] }, here);
  const store = new Store(":memory:");
  t.after(() => store.close?.());
  store.save("settings", "owner", connectionsSetting, { connections: [
    { id: "custom", name: "Custom", catalogId: "custom", model: "m", extras: { baseUrl: `https://models.test:${hello.port}/v1` } },
  ] });
  const demo = { id: "demo", name: "Demo", model: "demo", provider: { name: "offline-demo-fixture", complete: async () => ({ content: "", toolCalls: [] }) } };
  const models = new ModelRouter(store, [demo]);
  const locker = { exists: () => true, resolve: async (_owner, _project, names) => Object.fromEntries(names.map((name) => [name, "k"])) };
  assert.deepEqual(await restoreConnections({ models, locker, owner: "owner", policy, store }), ["custom"]);
  await settle(models.presets.get("custom").provider.complete({
    messages: [{ role: "user", content: "hello" }], tools: [], maxTokens: 16, signal: AbortSignal.timeout(10000) }));
  assert.deepEqual(dialled, ["93.184.216.34"], "the call went for the address the check judged");
  assert.deepEqual(asked, [], "and not through a second lookup");
  assert.deepEqual(hello.names, ["models.test"], "with the service's own name in the secure handshake");
});

/** A proxy that answers every request itself and notes what it was asked for. */
async function localProxy(t) {
  const reached = [];
  const proxy = createServer((request, response) => { reached.push(`request ${request.url}`); response.end("through the proxy"); });
  proxy.on("connect", (request, socket) => { reached.push(`CONNECT ${request.url}`); socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => new Promise((resolve) => { proxy.closeAllConnections(); proxy.close(resolve); }));
  return { address: `http://127.0.0.1:${proxy.address().port}`, reached };
}
const { setGlobalProxyFromEnv } = await import("node:http");

test("with the owner's proxy on, the proxy is asked for the site by name; a site it is told to leave alone is held to its judged address",
  { skip: typeof setGlobalProxyFromEnv !== "function" && "this Node cannot be given a proxy at all" }, async (t) => {
  const local = await localServer(t);
  const { address, reached } = await localProxy(t);
  systemLookups(t, { "direct.test": "127.0.0.1" });
  const { policy, dialled } = policyWith({ "proxied.test": ["93.184.216.34"], "direct.test": ["93.184.216.35"] },
    (judged) => judged === "93.184.216.35" ? "127.0.0.1" : null);
  const outbound = new OutboundNetwork(processNetworkHooks());
  t.after(() => outbound.reset());
  outbound.apply({ proxy: address, noProxy: ["direct.test"], caCertificates: [] });
  const guarded = policy.guard(globalThis.fetch);
  assert.equal(await (await guarded("http://proxied.test/hello")).text(), "through the proxy");
  assert.ok(reached.includes("request http://proxied.test/hello") || reached.includes("CONNECT proxied.test:80"), JSON.stringify(reached));
  assert.deepEqual(dialled, [], "the proxy does the lookup for what it carries; nothing was dialled here");
  assert.equal(await (await guarded(`http://direct.test:${local.port}/`)).text(), "local");
  assert.deepEqual(dialled, ["93.184.216.35"], "a site the proxy leaves alone goes straight to its judged address");
  assert.equal(reached.length, 1, "and the proxy was not asked for it");
  outbound.reset();
  await settle(guarded("http://proxied.test/hello"));
  assert.deepEqual(dialled, ["93.184.216.35", "93.184.216.34"], "with the proxy off, the same site is held to its judged address");
  assert.equal(reached.length, 1);
});

/**
 * Leave-alone entries a proxy can be given, and for each site whether a checked request is held to
 * its judged address or handed to the proxy by name. A site the platform's fetch would send straight
 * out is always held. The last two are held although that fetch would use the proxy: a port is not
 * read here, and "*" among other entries is taken to cover everything.
 */
const leaveAlone = [
  [".", { "site.test": "proxy", "site.test.": "held" }],
  ["*.", { "site.test": "proxy", "site.test.": "held" }],
  ["test", { "site.test": "held", "site.test.": "proxy" }],
  [".test", { "site.test": "held", "site.test.": "proxy" }],
  ["*.test", { "site.test": "held", "site.test.": "proxy" }],
  ["*test", { "site.test": "proxy", "site.test.": "proxy" }],
  ["SITE.TEST", { "site.test": "held", "site.test.": "proxy" }],
  ["*", { "site.test": "held", "site.test.": "held" }],
  ["site.test:81", { "site.test": "held", "site.test.": "proxy" }],
  ["other.test,*", { "site.test": "held", "site.test.": "held" }],
];

test("with the owner's proxy on, every form of leave-alone entry keeps a checked request from being looked up a second time",
  { skip: typeof setGlobalProxyFromEnv !== "function" && "this Node cannot be given a proxy at all" }, async (t) => {
  const { address, reached } = await localProxy(t);
  const asked = systemLookups(t, {});
  const { policy, dialled } = policyWith({ "site.test": ["93.184.216.34"], "site.test.": ["93.184.216.34"] }, nowhere);
  const guarded = policy.guard(globalThis.fetch);
  const hooks = processNetworkHooks();
  for (const [entry, expected] of leaveAlone) {
    const undo = hooks.setProxy({ HTTP_PROXY: address, HTTPS_PROXY: address, NO_PROXY: entry });
    try {
      const outcome = {};
      for (const host of Object.keys(expected)) {
        const before = { dialled: dialled.length, reached: reached.length, asked: asked.length };
        await settle(guarded(`http://${host}/`));
        outcome[host] = dialled.length > before.dialled ? "held" : reached.length > before.reached ? "proxy"
          : asked.length > before.asked ? "looked up a second time" : "went nowhere";
      }
      assert.deepEqual(outcome, expected, `leave alone "${entry}"`);
    } finally { undo(); }
  }
  assert.deepEqual(asked, [], "no checked request was looked up a second time");
});

/** The variables a fresh Node needs to start on each system, and nothing else from this one. */
const startingVariables = () => Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"].includes(name.toUpperCase())));

/**
 * Starts a fresh Node with `env` and `args` and sends three checked requests in it, through a policy
 * whose dialling seam notes and refuses every address. Every name that Node is asked to look up is
 * noted and refused, so nothing reaches a name server. Returns what was dialled and looked up.
 */
async function startedWith(t, env, args = []) {
  const folder = await mkdtemp(join(tmpdir(), "branch-launch-proxy-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const refuse = join(folder, "refuse-lookups.mjs");
  await writeFile(refuse, [
    'import dns from "node:dns";',
    "globalThis.lookedUp = [];",
    "dns.lookup = (hostname, options, callback) => {",
    '  if (typeof options === "function") callback = options;',
    "  globalThis.lookedUp.push(hostname);",
    '  process.nextTick(callback, Object.assign(new Error("no lookups here"), { code: "ENOTFOUND" }));',
    "};",
  ].join("\n"));
  const program = [
    `const { NetworkPolicy } = await import(${JSON.stringify(new URL("../dist/network-policy.js", import.meta.url).href)});`,
    'const names = { "proxied.test": ["93.184.216.34"], "direct.test": ["93.184.216.35"] }, dialled = [];',
    'const policy = new NetworkPolicy({}, async (host) => names[host] ?? [], (address) => { dialled.push(address); throw new Error("not here"); });',
    "const guarded = policy.guard(globalThis.fetch);",
    'for (const url of ["http://proxied.test/", "https://proxied.test/", "http://direct.test/"])',
    "  await guarded(url).then((response) => response.arrayBuffer(), () => undefined);",
    "process.stdout.write(JSON.stringify({ dialled, lookedUp: globalThis.lookedUp }));",
  ].join("\n");
  const child = spawn(process.execPath, [...args, "--import", pathToFileURL(refuse).href, "--input-type=module", "-e", program],
    { env: { ...startingVariables(), HOME: folder, BRANCH_DATA_DIR: folder, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", errors = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, errors);
  return JSON.parse(out);
}

test("a proxy Node itself was started with carries a checked request by name only when Node's fetch really goes through it", async (t) => {
  const { address, reached } = await localProxy(t);
  const proxyVariables = { HTTP_PROXY: address, NO_PROXY: "direct.test" };
  for (const [how, env, args] of [
    ["NODE_USE_ENV_PROXY=1", { NODE_USE_ENV_PROXY: "1", ...proxyVariables }, []],
    ["--use-env-proxy", proxyVariables, ["--use-env-proxy"]],
    ["NODE_OPTIONS", { NODE_OPTIONS: "--use-env-proxy", ...proxyVariables }, []],
  ]) {
    const before = reached.length;
    const run = await startedWith(t, env, args);
    assert.deepEqual(run.dialled, ["93.184.216.35"], `started with ${how}, only the site the proxy leaves alone is held to its judged address`);
    assert.equal(reached.length - before, 2, `started with ${how}, the proxy was asked for both requests to the other site: ${JSON.stringify(reached)}`);
    assert.deepEqual(run.lookedUp, [], `started with ${how}, nothing was looked up a second time`);
  }
  const asked = reached.length;
  const unused = [
    ["the switch is turned off again on the command line", { NODE_USE_ENV_PROXY: "1", ...proxyVariables }, ["--no-use-env-proxy"]],
    ["the switch is not exactly 1", { NODE_USE_ENV_PROXY: "true", ...proxyVariables }, []],
  ];
  // On Windows both spellings are one variable, so this case exists only on other systems.
  if (process.platform !== "win32")
    unused.push(["an empty http_proxy wins over HTTP_PROXY", { NODE_USE_ENV_PROXY: "1", http_proxy: "", ...proxyVariables }, []]);
  for (const [why, env, args] of unused) {
    const run = await startedWith(t, env, args);
    assert.deepEqual(run.dialled, ["93.184.216.34", "93.184.216.34", "93.184.216.35"], `every request is held when ${why}, since Node's fetch then uses no proxy`);
    assert.deepEqual(run.lookedUp, [], `nothing is looked up a second time when ${why}`);
  }
  assert.equal(reached.length, asked, "and the proxy was not asked when Node's fetch does not use it");
});
