import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/* mac5/key-sweep: "Test this connection" sends the typed key to the typed address, so the app's
   network rules are asked first, with the same allowance a catalogue connection on this computer has. */

async function fakeService(t, status = 200) {
  const seen = [];
  const service = createServer((request, response) => {
    seen.push(`${request.method} ${request.url} ${request.headers.authorization ?? ""}`);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(status === 200 ? { choices: [{ message: { role: "assistant", content: "OK" } }] } : { error: { message: "nope" } }));
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => service.close(resolve)));
  return { seen, base: `http://127.0.0.1:${service.address().port}/v1` };
}

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-provider-test-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const test = (body) => fetch(server.url + "/api/providers/test", {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((response) => response.json());
  return { test };
}

test("Test this connection asks the network rules before the key leaves: a private address gets nothing", async (t) => {
  const service = await fakeService(t);
  const { test: check } = await served(t);
  const answer = await check({ endpoint: service.base, model: "m", apiKey: "sk-typed-secret" });
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /not allowed/);
  assert.deepEqual(service.seen, [], "the typed key was sent to an address the rules refuse");
});

test("a catalogue service on this computer is still reached at its own address", async (t) => {
  const service = await fakeService(t);
  const { test: check } = await served(t);
  const answer = await check({ preset: "vllm", endpoint: service.base, model: "m", apiKey: "local-key" });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(service.seen.length, 1);
});

/* A backspace byte once stood where the pattern's \b was meant, so a refused key read as "an error". */
test("a refused key and a missing model are named in plain words", async (t) => {
  const { test: check } = await served(t);
  for (const [status, reason] of [[401, /key was not accepted/], [403, /key was not accepted/], [404, /model name was not found/]]) {
    const service = await fakeService(t, status);
    const answer = await check({ preset: "vllm", endpoint: service.base, model: "m", apiKey: "local-key" });
    assert.equal(answer.ok, false);
    assert.match(answer.reason, reason, `${status}: ${answer.reason}`);
  }
});
