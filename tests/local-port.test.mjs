/* Q45 leaf 0 (src/desktop/local-port.ts): the desktop app asks for the same port as last time, so the page's own
   stored choices survive a restart and an update. Only temp files and a free-port probe on this computer. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { rememberedPort, rememberPort, portIsFree } from "../dist/desktop/local-port.js";

async function file(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-local-port-"));
  t.after(() => discardTemp(root));
  return join(root, "local-port.json");
}
const free = async () => true, taken = async () => false;

test("the port used last time is asked for again, and a first start takes any free port", async (t) => {
  const path = await file(t);
  assert.equal(await rememberedPort(path, free), 0, "nothing remembered yet");
  rememberPort(path, "http://127.0.0.1:43127");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { port: 43127 });
  assert.equal(await rememberedPort(path, free), 43127);
});

test("a taken, damaged or out-of-range remembered port falls back to any free port", async (t) => {
  const path = await file(t);
  rememberPort(path, "http://127.0.0.1:43127");
  assert.equal(await rememberedPort(path, taken), 0);
  for (const text of ["not json", "{}", '{"port":80}', '{"port":70000}', '{"port":"43127"}']) {
    await writeFile(path, text);
    assert.equal(await rememberedPort(path, free), 0, text);
  }
});

test("the free-port probe says no for a port something is listening on", async () => {
  const other = createServer();
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal(await portIsFree(other.address().port), false);
  } finally {
    await new Promise((resolve) => other.close(resolve));
  }
});
