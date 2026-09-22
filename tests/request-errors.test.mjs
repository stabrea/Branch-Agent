import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-request-errors-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const post = (body) => fetch(`${server.url}/api/tools/meaning-search`, {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { post };
}

test("schema failures name one bad field and the accepted shape in one sentence", async (t) => {
  const { post } = await fixture(t);
  const wrong = await post({ enabled: "yes" });
  assert.equal(wrong.status, 400);
  const wrongBody = await wrong.json();
  assert.equal(wrongBody.error, '"enabled" is not valid: expected boolean, received string.');
  assert.equal(wrongBody.requestId, undefined, "an ordinary bad request is not reported as an internal failure");

  const extra = await post({ enabled: true, surprise: "hidden" });
  assert.equal(extra.status, 400);
  assert.equal((await extra.json()).error, '"surprise" is not an accepted field.');
});
