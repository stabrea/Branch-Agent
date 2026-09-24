/**
 * Q111 (NAS 2361bcd): a value a model chooses and Branch puts into one segment of a URL path. `encodeURIComponent`
 * leaves "." and ".." unchanged and the URL parser resolves them, so an id of ".." climbed one level: a DELETE
 * meant for one item landed on the collection above it, on the owner's own configured API. An empty value
 * reached the collection itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { buildRequest } from "../dist/openapi-tools.js";
import { registerHttpTools } from "../dist/skill-http-tools.js";
import { HttpToolSchema } from "../dist/skill-package.js";

const climbs = ["..", ".", ""];

test("Q111: an OpenAPI path parameter is never \".\", \"..\" or empty, so a call cannot climb out of its item", () => {
  const operation = { id: "drop", method: "delete", path: "/items/{id}", summary: "", body: null, bodyRequired: false,
    parameters: [{ name: "id", where: "path", required: true }, { name: "q", where: "query", required: false }] };
  for (const id of climbs)
    assert.throws(() => buildRequest(operation, "https://api.example.com/v1", { id }), /cannot be used as one part of an address/, JSON.stringify(id));
  assert.equal(buildRequest(operation, "https://api.example.com/v1", { id: "a b/..", q: ".." }).url.href,
    "https://api.example.com/v1/items/a%20b%2F..?q=..", "anything else is one encoded segment, and a query value is only encoded");
});

test("Q111: a skill HTTP tool's path placeholder is never \".\", \"..\" or empty, and nothing is sent when it is", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-path-segments-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const sent = [];
  const fetchImpl = async (url) => { sent.push(String(url)); return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); };
  const [name] = registerHttpTools(app.registry, { store: app.store, policy: { assertAllowed: async () => undefined }, fetchImpl }, "items",
    [HttpToolSchema.parse({ name: "remove", description: "Removes one item.", method: "POST", url: "https://api.example.com/items/{{id}}/remove?q={{q}}",
      input: { id: { type: "string", required: true }, q: { type: "string", default: "" } } })]);
  const context = app.runtime.context();
  for (const id of climbs)
    await assert.rejects(app.registry.execute(name, { id, q: "x" }, context), /cannot be used as one part of an address/, JSON.stringify(id));
  assert.deepEqual(sent, [], "nothing was sent");
  await app.registry.execute(name, { id: "a b", q: ".." }, context);
  assert.deepEqual(sent, ["https://api.example.com/items/a%20b/remove?q=.."], "a query value is only encoded");
});
