/**
 * FQ-security.wasm: each WebAssembly add-on now gets its own capability manifest, not just the one
 * fixed allow-list every add-on used to share (`allowedImports` in `wasm-check.ts`). A module is
 * refused, at install and at run, for an operation its own manifest did not grant — even one the
 * shared allow-list would otherwise let it have.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/* ---------- a tiny assembler (see tests/safety-extras-wasm.test.mjs for the format) ---------- */
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

/** Reads its input back out, and also logs it: input_size(), read_input(0), log(0, size),
 * write_output(0, size), return 0. Four branch functions imported: input_size(0), read_input(1),
 * write_output(2), log(3); its own run function is index 4. */
const withLog = module({
  types: [fn([], [I32]), fn([I32], []), fn([I32, I32], [])],
  imports: [
    imp("memory", 0x02, limits(1, 2)),
    imp("input_size", 0x00, [0]),
    imp("read_input", 0x00, [1]),
    imp("write_output", 0x00, [2]),
    imp("log", 0x00, [2]),
  ],
  funcs: [0],
  exports: [[...str("run"), 0x00, 4]],
  code: [body([[1, I32]], [
    0x10, 0, 0x21, 0,              // size = input_size(); local.set 0
    0x41, 0, 0x10, 1,              // read_input(0)
    0x41, 0, 0x20, 0, 0x10, 3,     // log(0, size)
    0x41, 0, 0x20, 0, 0x10, 2,     // write_output(0, size)
    0x41, 0,                       // return 0
  ])],
});

async function wasmApp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-safety-wasm-caps-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.store.save("settings", app.runtime.owner, "safety-wasm-add-ons", { mode: "on" });
  return app;
}

test("a module that asks for an operation its own manifest does not grant is refused at install, even though the shared list allows it", async (t) => {
  const app = await wasmApp(t);
  await assert.rejects(
    app.safetyExtras.wasm.install({ name: "logger", wasm: Buffer.from(withLog).toString("base64"),
      capabilities: ["input_size", "read_input", "write_output"] }),
    /asks for log, which its own capability manifest does not grant/,
  );
  assert.deepEqual(await app.safetyExtras.wasm.list(), [], "the refused module was not kept");
});

test("left out, a module is granted exactly what its own bytes ask for — the per-module manifest, derived rather than typed", async (t) => {
  const app = await wasmApp(t);
  const manifest = await app.safetyExtras.wasm.install({ name: "logger", wasm: Buffer.from(withLog).toString("base64") });
  assert.deepEqual([...manifest.capabilities].sort(), ["input_size", "log", "read_input", "write_output"]);
  const run = await app.safetyExtras.wasm.run({ name: "logger", input: "hi there" });
  assert.equal(run.ok, true, run.error);
  assert.equal(run.output, "hi there");
});

test("review: a manifest narrowed after install refuses the run itself for the undeclared operation, though the module's bytes never changed", async (t) => {
  const app = await wasmApp(t);
  await app.safetyExtras.wasm.install({ name: "logger", wasm: Buffer.from(withLog).toString("base64") });
  const key = "safety-wasm-add-on:logger";
  const kept = app.store.get("settings", app.runtime.owner, key).data;
  app.store.save("settings", app.runtime.owner, key, { ...kept, capabilities: ["input_size", "read_input", "write_output"] });
  await assert.rejects(
    app.safetyExtras.wasm.run({ name: "logger", input: "hi" }),
    /asks for log, which its own capability manifest does not grant/,
  );
});

test("runWasm itself refuses an operation the caller did not grant, without needing the store or an install at all", async (t) => {
  const { runWasm } = await import("../dist/safety-extras/wasm-add-ons.js");
  const denied = await runWasm(withLog, "hi", { maxMemoryMb: 16, timeoutMs: 2000 }, ["input_size", "read_input", "write_output"]);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /asks for log, which its own capability manifest does not grant/);
  const allowed = await runWasm(withLog, "hi", { maxMemoryMb: 16, timeoutMs: 2000 }, ["input_size", "read_input", "write_output", "log"]);
  assert.equal(allowed.ok, true, allowed.error);
  assert.equal(allowed.output, "hi");
  // Omitting the capabilities list entirely keeps the call unrestricted, matching the run this
  // function always did before per-module manifests existed.
  const unrestricted = await runWasm(withLog, "hi", { maxMemoryMb: 16, timeoutMs: 2000 });
  assert.equal(unrestricted.ok, true, unrestricted.error);
});
