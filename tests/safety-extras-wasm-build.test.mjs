/**
 * FQ-extensions.tool-building: Branch builds a requested WebAssembly tool from a small fixed
 * template catalog (src/safety-extras/wasm-build.ts) and installs it through the existing
 * wasm-add-ons.ts pipeline — capabilities are declared per tool and enforced at install and at run
 * (src/safety-extras/wasm-check.ts), rather than every add-on drawing from one fixed import list.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/* ---------- a tiny assembler, for the one adversarial module this file builds by hand ---------- */
const leb = (n) => { const out = []; do { let byte = n & 0x7f; n >>>= 7; if (n) byte |= 0x80; out.push(byte); } while (n); return out; };
const str = (text) => [...leb(Buffer.byteLength(text)), ...Buffer.from(text)];
const vec = (items) => [...leb(items.length), ...items.flat()];
const section = (id, body) => [id, ...leb(body.length), ...body];
const I32 = 0x7f;
const fn = (params, results) => [0x60, ...vec(params.map((p) => [p])), ...vec(results.map((r) => [r]))];
const limits = (min, max) => (max === undefined ? [0x00, ...leb(min)] : [0x01, ...leb(min), ...leb(max)]);
const body = (locals, code) => { const inner = [...vec(locals), ...code, 0x0b]; return [...leb(inner.length), ...inner]; };
const imp = (name, kind, desc) => [...str("branch"), ...str(name), kind, ...desc];
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
/** Imports branch.log but has no other use for it; used to prove an undeclared capability is refused. */
const logsSomething = module({
  types: [fn([I32, I32], []), fn([], [I32])],
  imports: [imp("log", 0x00, [0])],
  funcs: [1], memory: limits(1, 1),
  exports: [[...str("run"), 0x00, 1], [...str("memory"), 0x02, 0]],
  code: [body([], [0x41, 0, 0x41, 5, 0x10, 0, 0x41, 0])],
});

async function wasmApp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-safety-wasm-build-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.safetyExtras.setMode("wasm-add-ons", { mode: "on" });
  return { app, root, folder: join(root, "data", "wasm-add-ons") };
}

test("build: the echo template gets exactly input and output, never log", async (t) => {
  const { app } = await wasmApp(t);
  const manifest = await app.safetyExtras.wasmBuilder.build({ name: "echo1", template: "echo" });
  assert.deepEqual(manifest.capabilities.slice().sort(), ["input_size", "read_input", "write_output"]);
  const run = await app.safetyExtras.wasm.run({ name: "echo1", input: "round trip" });
  assert.equal(run.ok, true, run.error);
  assert.equal(run.output, "round trip");
});

test("build: the announce template gets only log, never input or output, and bakes in the owner's message", async (t) => {
  const { app } = await wasmApp(t);
  const manifest = await app.safetyExtras.wasmBuilder.build({ name: "announce1", template: "announce", message: "built for the owner" });
  assert.deepEqual(manifest.capabilities, ["log"]);
  const run = await app.safetyExtras.wasm.run({ name: "announce1", input: "ignored, no input capability was given" });
  assert.equal(run.ok, true, run.error);
  assert.equal(run.output, "", "it was never given write_output, so it cannot answer with one");
  assert.equal(run.log, "built for the owner");
  // a second tool, a different template, gets a genuinely different capability set from the same catalog
  const echo = await app.safetyExtras.wasmBuilder.build({ name: "echo2", template: "echo" });
  assert.notDeepEqual(echo.capabilities.slice().sort(), manifest.capabilities.slice().sort());
});

test("build: off, the tool refuses; the built add-on is not offered as wasm.run until switched on", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-safety-wasm-build-off-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  assert.equal(app.registry.names().includes("wasm.build"), false, "off: wasm.build is not offered");
  await assert.rejects(app.safetyExtras.wasmBuilder.build({ name: "nope", template: "echo" }), /switched off|off/i);
});

test("install: a module that imports a capability it was not given is refused, naming what it asked for", async (t) => {
  const { app } = await wasmApp(t);
  await assert.rejects(
    app.safetyExtras.wasm.install({ name: "sneaky-log", wasm: Buffer.from(logsSomething).toString("base64"), capabilities: ["input_size"] }),
    /asks for branch\.log, which this tool was not given/);
  // declaring it correctly installs and runs fine
  const manifest = await app.safetyExtras.wasm.install({ name: "ok-log", wasm: Buffer.from(logsSomething).toString("base64"), capabilities: ["log"] });
  assert.deepEqual(manifest.capabilities, ["log"]);
});

test("run: the capability record kept in the store wins over the note beside the file, in both directions", async (t) => {
  const { app, folder } = await wasmApp(t);
  await app.safetyExtras.wasmBuilder.build({ name: "guarded", template: "announce", message: "hi" });
  // widening the file on disk changes nothing: the store record still governs what is wired in
  const file = join(folder, "guarded.json");
  const note = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...note, capabilities: [] }));
  const stillWorks = await app.safetyExtras.wasm.run({ name: "guarded", input: "" });
  assert.equal(stillWorks.ok, true, stillWorks.error);
  assert.equal(stillWorks.log, "hi");
  // narrowing the store record (its actual source of truth) does take hold, and the run is refused
  const key = "safety-wasm-add-on:guarded";
  const kept = app.store.get("settings", app.runtime.owner, key).data;
  app.store.save("settings", app.runtime.owner, key, { ...kept, capabilities: [] });
  await assert.rejects(app.safetyExtras.wasm.run({ name: "guarded", input: "" }), /branch\.log, which this tool was not given/);
});

test("an add-on installed before capabilities existed still runs: it keeps whatever it already imports", async (t) => {
  const { app } = await wasmApp(t);
  // capabilities omitted entirely, as every install before this feature did
  const manifest = await app.safetyExtras.wasm.install({ name: "legacy-log", wasm: Buffer.from(logsSomething).toString("base64") });
  assert.deepEqual(manifest.capabilities, ["log"], "derived from what the module itself imports");
  const run = await app.safetyExtras.wasm.run({ name: "legacy-log", input: "" });
  assert.equal(run.ok, true, run.error);
});

test("api: the owner can build a tool through the HTTP route, and use it as wasm.run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-safety-wasm-build-api-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (path, body) => {
    const response = await fetch(server.url + path, { method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  await api("/api/safety-extras/switch", { part: "wasm-add-ons", mode: "on" });
  const built = await api("/api/safety-extras/wasm/build", { name: "web-echo", template: "echo" });
  assert.equal(built.status, 200, JSON.stringify(built.body));
  assert.deepEqual(built.body.addOn.capabilities.slice().sort(), ["input_size", "read_input", "write_output"]);
  const ran = await api("/api/safety-extras/wasm/run", { name: "web-echo", input: "through the http route" });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(ran.body.run.output, "through the http route");
  assert.ok(app.store.audit.list(app.runtime.owner).some((entry) => entry.subject === "WebAssembly add-on web-echo" && /capabilities: input_size, read_input, write_output/.test(entry.reason)));
});
