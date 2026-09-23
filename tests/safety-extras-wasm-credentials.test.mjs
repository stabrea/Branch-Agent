/**
 * security.credentials: the host-side credential path for a WebAssembly add-on. The module used
 * here is the same hand-assembled "echo" module the sealed-box tests use — it only ever writes back
 * exactly the bytes it was given as input — so any credential that reached it would come straight
 * back out in its answer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/* ---------- the same tiny assembler the sealed-box tests use ---------- */
const leb = (n) => { const out = []; do { let byte = n & 0x7f; n >>>= 7; if (n) byte |= 0x80; out.push(byte); } while (n); return out; };
const str = (text) => [...leb(Buffer.byteLength(text)), ...Buffer.from(text)];
const vec = (items) => [...leb(items.length), ...items.flat()];
const section = (id, body) => [id, ...leb(body.length), ...body];
const I32 = 0x7f;
const fn = (params, results) => [0x60, ...vec(params.map((p) => [p])), ...vec(results.map((r) => [r]))];
const limits = (min, max) => (max === undefined ? [0x00, ...leb(min)] : [0x01, ...leb(min), ...leb(max)]);
const body = (locals, code) => { const inner = [...vec(locals), ...code, 0x0b]; return [...leb(inner.length), ...inner]; };
function module({ types, imports = [], funcs = [], memory, exports, code }) {
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...(imports.length ? section(2, vec(imports)) : []),
    ...section(3, vec(funcs.map((type) => leb(type)))),
    ...(memory ? section(5, vec([memory])) : []),
    ...section(7, vec(exports)),
    ...section(10, vec(code)),
  ]);
}
const imp = (name, kind, desc) => [...str("branch"), ...str(name), kind, ...desc];
/** Echoes exactly what it was given as input, and also writes it to the log. */
const echo = module({
  types: [fn([], [I32]), fn([I32], []), fn([I32, I32], [])],
  imports: [imp("memory", 0x02, limits(1, 2)), imp("input_size", 0x00, [0]), imp("read_input", 0x00, [1]), imp("write_output", 0x00, [2]), imp("log", 0x00, [2])],
  funcs: [0],
  exports: [[...str("run"), 0x00, 4]],
  // size = input_size(); read_input(0); write_output(0, size); log(0, size); return 0.
  code: [body([[1, I32]],
    [0x10, 0, 0x21, 0, 0x41, 0, 0x10, 1, 0x41, 0, 0x20, 0, 0x10, 2, 0x41, 0, 0x20, 0, 0x10, 3, 0x41, 0])],
});

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-safety-wasm-cred-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } },
    web: { allowPrivateAddresses: true }, ...options });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (path, body) => {
    const response = await fetch(server.url + path, { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { app, api, root };
}

test("a WASM add-on's declared credential call is made by the host, and the module never receives the credential", async (t) => {
  const secret = "sk-live-h0st-only-9f3e7c";
  const seen = [];
  // A server that (adversarially) echoes the credential straight back in its answer, so this
  // proves the scrub, not merely that a well-behaved server withheld it.
  const server = createServer((request, response) => {
    seen.push(request.headers["x-api-key"]);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, echoed: request.headers["x-api-key"] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/data`;

  const { app, api } = await fixture(t);
  await app.store.locker.set("local", "default", "ADDON_KEY", secret);

  const installed = await api("/api/safety-extras/wasm",
    { name: "fetcher", wasm: Buffer.from(echo).toString("base64"), call: { url, header: "X-Api-Key", secret: "ADDON_KEY" } });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  assert.equal(installed.body.addOn.call.secret, "ADDON_KEY", "the manifest keeps which secret to use");
  assert.equal(JSON.stringify(installed.body.addOn).includes(secret), false, "installing never returns the secret's value");

  await api("/api/safety-extras/switch", { part: "wasm-add-ons", mode: "on" });
  // Whatever the caller sends as `input` is ignored once a credential call is declared: the host
  // decides what the module runs on, precisely so a caller cannot ask the sealed module to hand the
  // credential back to them by supplying it as the "input" the module is told to echo.
  const ran = await api("/api/safety-extras/wasm/run", { name: "fetcher", input: secret });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));

  assert.equal(seen.at(-1), secret, "the real request really carried the credential, so the host-side path is exercised, not skipped");

  const output = ran.body.run.output, log = ran.body.run.log;
  assert.equal(output.includes(secret), false, "the credential is absent from the module's output");
  assert.equal(log.includes(secret), false, "the credential is absent from the module's log");
  assert.match(output, /\[secret ADDON_KEY\]/, "the module received the answer with the credential scrubbed, not blanked entirely");
  assert.deepEqual(JSON.parse(output), { ok: true, echoed: "[secret ADDON_KEY]" });

  const whole = JSON.stringify(ran.body);
  assert.equal(whole.includes(secret), false, "the credential is absent from the whole HTTP response, input and output alike");
  // The audit trail must also be silent about it.
  const allEvents = JSON.stringify(app.store.audit.list(app.runtime.owner));
  assert.equal(allEvents.includes(secret), false, "the audit trail never holds the credential either");
});

test("an add-on with no declared call behaves exactly as before: the caller's own input is what the module sees", async (t) => {
  const { app, api } = await fixture(t);
  await api("/api/safety-extras/wasm", { name: "plain", wasm: Buffer.from(echo).toString("base64") });
  await api("/api/safety-extras/switch", { part: "wasm-add-ons", mode: "on" });
  const ran = await api("/api/safety-extras/wasm/run", { name: "plain", input: "hi there" });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(ran.body.run.output, "hi there");
});

test("a WASM add-on cannot declare a call to an address the network rules would refuse", async (t) => {
  const { app, api } = await fixture(t, { web: { allowPrivateAddresses: false } });
  const blocked = await api("/api/safety-extras/wasm",
    { name: "fetcher", wasm: Buffer.from(echo).toString("base64"), call: { url: "https://10.0.0.5/secret", header: "X-Api-Key", secret: "ADDON_KEY" } });
  assert.equal(blocked.status, 200, "installing only keeps the declared address; it is checked when the add-on runs");
  await app.store.locker.set("local", "default", "ADDON_KEY", "whatever");
  await api("/api/safety-extras/switch", { part: "wasm-add-ons", mode: "on" });
  const ran = await api("/api/safety-extras/wasm/run", { name: "fetcher", input: "" });
  assert.match(ran.body.error, /private or local address/);
});
