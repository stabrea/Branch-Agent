import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, packSkill } from "../dist/index.js";
import { startServer } from "../dist/server.js";

// FQ-automation.metrics: a package that ships metrics.json alongside tools.json asks Branch to
// keep a running count of one of its own declared calls. This proves the count is zero before the
// call ever runs, moves once the call actually happens, and is read back both through the plain
// library function and through the HTTP API the owner's browser uses.

const say = (content) => () => ({ content, toolCalls: [] });
function scripted(steps) {
  const provider = { name: "scripted", requests: [], steps, index: 0, async complete(request) {
    provider.requests.push(request);
    return provider.steps[Math.min(provider.index++, provider.steps.length - 1)](request);
  } };
  return provider;
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-pkgmetrics-"));
  const provider = scripted([say("ok")]);
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider, web: { allowPrivateAddresses: true }, ...options });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (path, body) => {
    const response = await fetch(server.url + "/api/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error);
    return json;
  };
  return { app, api };
}
const document = () => `---\nname: counters\ndescription: Count widgets for the owner.\n---\nCount widgets.\n`;

test("a package's declared metric stays at zero until its call runs, then counts it", async (t) => {
  let hits = 0;
  const stub = createServer((request, response) => {
    hits += 1;
    response.writeHead(hits === 3 ? 500 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => stub.close(resolve)));
  const address = `http://127.0.0.1:${stub.address().port}/count`;
  const files = {
    "SKILL.md": document(),
    "tools.json": JSON.stringify({ tools: [{ name: "count", description: "Count one widget.", url: address, input: {} }] }),
    "metrics.json": JSON.stringify({ metrics: [{ tool: "count", description: "Widgets counted so far" }] }),
  };
  const file = packSkill({ files, author: "Ada", packageVersion: "1.0.0" }).toString("base64");
  const { app, api } = await fixture(t);
  const preview = await api("skills/package/inspect", { file });
  assert.deepEqual(preview.metrics, [{ tool: "count", description: "Widgets counted so far" }], "the owner is shown what a package will count before installing it");
  const installed = await api("skills/package/install", { file, approve: true });
  const view = app.store.skills.view("local", installed.skill.id);
  app.store.skills.activate("local", installed.skill.id, { version: view.headVersion, expectedRevision: view.revision });

  const before = app.skillPackages.metrics(installed.skill.id);
  assert.deepEqual(before, [{ tool: "count", description: "Widgets counted so far", callsTotal: 0, errorsTotal: 0, avgMs: 0, lastCalledAt: null }],
    "nothing has run yet, so the count starts at zero");
  const viaApi = await api(`skills/${installed.skill.id}/metrics`);
  assert.deepEqual(viaApi.metrics, before, "the API the browser calls reports the same counters as the library function");

  const run = await app.runtime.run({ prompt: "count" });
  const context = app.runtime.context({ runId: run.id });
  await app.registry.execute("skill.counters.count", {}, context);
  await app.registry.execute("skill.counters.count", {}, context);
  await assert.rejects(app.registry.execute("skill.counters.count", {}, context), /HTTP 500/, "the third call is a server error");

  const after = app.skillPackages.metrics(installed.skill.id);
  assert.equal(after.length, 1);
  assert.equal(after[0].callsTotal, 3, "every call the package made is counted, successful or not");
  assert.equal(after[0].errorsTotal, 1, "only the failing call is counted as an error");
  assert.ok(after[0].lastCalledAt, "the most recent call is timestamped");

  const list = app.skillPackages.list();
  const own = list.find((entry) => entry.skillId === installed.skill.id);
  assert.deepEqual(own.metrics, after, "the packages list the settings page reads carries the same counters");

  // A metric can only ever be declared for a call this same package already declared and the owner
  // already saw in tools.json; naming any other tool is refused at pack time, not silently dropped.
  assert.throws(() => packSkill({
    files: { "SKILL.md": document(), "tools.json": files["tools.json"], "metrics.json": JSON.stringify({ metrics: [{ tool: "unrelated", description: "x" }] }) },
    author: "Ada", packageVersion: "1.0.0",
  }), /not one of this package's declared tools/);
});
