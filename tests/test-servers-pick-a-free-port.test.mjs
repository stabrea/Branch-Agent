import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/*
 * A test that starts the app without saying which port listens on the default one, 3210. That is the
 * port the owner's own Branch Agent holds on this computer, so such a test fails there with
 * EADDRINUSE (tests/memory-context.test.mjs did), and on any other machine it would collide with the
 * next test to do the same. `port: 0` asks the system for a free one.
 */
const dir = import.meta.dirname;

/** Every `startServer(...)` call in the tests whose options do not name a port. */
async function portless() {
  const found = [];
  for (const name of (await readdir(dir)).filter((file) => /\.m?js$/.test(file))) {
    const source = await readFile(join(dir, name), "utf8");
    for (const call of source.matchAll(/startServer\(([^;]*?)\);/gs))
      if (!/\bport\s*:/.test(call[1])) found.push(`${name}:${source.slice(0, call.index).split("\n").length}`);
  }
  return found;
}

test("every test that starts the app asks for a port of its own", async () => {
  assert.deepEqual(await portless(), [], "pass { port: 0 } to startServer so the test never takes the default port");
});
