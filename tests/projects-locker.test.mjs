import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { BranchShell, registerShell } from "../dist/integrations/shell.js";
import { scrubSecrets } from "../dist/locker.js";

function scripted(name) {
  const provider = { name, requests: [], async complete(request) { provider.requests.push(request); return { content: `${name} answered`, toolCalls: [] }; } };
  return provider;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-projects-"));
  const alpha = scripted("alpha"), beta = scripted("beta");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets: [
    { id: "alpha", name: "Alpha", provider: alpha, model: "a" }, { id: "beta", name: "Beta", provider: beta, model: "b" },
  ] });
  /* What a test opens on top of the app (a server) is shut first, then the app, then the folder, all in
     one hook: node runs separate hooks in the order they were added, which here was app and folder
     before the server still using them, and on Windows that left the file running long after it passed. */
  const closing = [];
  t.after(async () => {
    for (const close of closing.reverse()) await close();
    await app.close();
    await discardTemp(root);
  });
  return { app, root, alpha, beta, closing };
}

test("switching projects changes instructions and the preferred model; the default project always exists", async (t) => {
  const { app, alpha, beta } = await fixture(t);
  const projects = app.store.projects;
  assert.deepEqual(projects.list("local").map((p) => p.id), ["default"]);
  projects.save("local", { id: "client", name: "Client site", instructions: "Always answer in British English.", modelPreset: "beta" });
  assert.throws(() => projects.save("local", { id: "Bad Id", name: "x" }), /lowercase/);
  assert.throws(() => projects.remove("local", "default"), /cannot be removed/);
  await app.runtime.run({ prompt: "one" });
  assert.equal(alpha.requests.length, 1);
  assert.ok(!alpha.requests[0].messages[0].content.includes("British"));
  projects.setActive("local", { active: "client" });
  const run = await app.runtime.run({ prompt: "two" });
  assert.equal(beta.requests.length, 1, "the project's preferred model answers");
  assert.match(beta.requests[0].messages[0].content, /Project "Client site" instructions: Always answer in British English\./);
  assert.equal(app.store.events(run.id).find((e) => e.kind === "model.selected").data.source, "project");
  app.runtime.models.configureSession("local", run.sessionId, { preset: "alpha" });
  await app.runtime.run({ prompt: "three", sessionId: run.sessionId });
  assert.equal(alpha.requests.length, 2, "a conversation's own choice still wins over the project");
  const removed = projects.remove("local", "client");
  assert.equal(removed.active, "default");
  assert.throws(() => projects.setActive("local", { active: "client" }), /not found/);
});

test("secrets are encrypted at rest, scoped to the active project, injected only at the host boundary and scrubbed from output", async (t) => {
  const { app, root } = await fixture(t);
  const locker = app.store.locker, projects = app.store.projects;
  projects.save("local", { id: "other", name: "Other" });
  await locker.set("local", "default", "DEPLOY_TOKEN", "tok-default-9f8e7d");
  await locker.set("local", "other", "DEPLOY_TOKEN", "tok-other-1a2b3c");
  await locker.set("local", "other", "ONLY_OTHER", "shh-other-secret");
  await assert.rejects(locker.set("local", "default", "bad-name", "x"), /environment-style/);
  assert.deepEqual(locker.names("local", "default").map((s) => s.name), ["DEPLOY_TOKEN"]);
  assert.ok(await stat(join(root, "data", "locker.key")), "key file exists outside the database");
  const { DatabaseSync } = await import("node:sqlite");
  const { Locker } = await import("../dist/locker.js");
  const memory = new DatabaseSync(":memory:");
  const inspectable = new Locker(memory, { key: async () => Buffer.alloc(32, 7) });
  await inspectable.set("local", "default", "DEPLOY_TOKEN", "tok-default-9f8e7d");
  const rows = memory.prepare("SELECT ciphertext FROM locker").all();
  assert.ok(rows.length === 1 && !Buffer.from(rows[0].ciphertext).toString("latin1").includes("tok-"), "values are not stored in clear text");
  assert.deepEqual(await inspectable.resolve("local", "default", ["DEPLOY_TOKEN"]), { DEPLOY_TOKEN: "tok-default-9f8e7d" });
  memory.close();
  assert.deepEqual(await locker.resolve("local", "default", ["DEPLOY_TOKEN"]), { DEPLOY_TOKEN: "tok-default-9f8e7d" });
  await assert.rejects(locker.resolve("local", "default", ["ONLY_OTHER"]), /not available in the active project \(default\)/);
  const shell = new BranchShell({ executables: { show: { path: process.execPath, args: ["-e",
    "process.stdout.write('token=' + process.env.DEPLOY_TOKEN + ' other=' + process.env.ONLY_OTHER)"] } } }, process.env, app.secretsFor);
  registerShell(app.registry, shell);
  const context = app.runtime.context({ runId: "run-secrets" });
  const result = await app.registry.execute("shell.execute", { executable: "show", secrets: ["DEPLOY_TOKEN"] }, context);
  assert.equal(result.stdout, "token=[secret DEPLOY_TOKEN] other=undefined", "the program saw the value; the result does not");
  assert.deepEqual(result.target.secrets, ["DEPLOY_TOKEN"]);
  await assert.rejects(app.registry.execute("shell.execute", { executable: "show", secrets: ["ONLY_OTHER"] }, context), /not available in the active project/);
  projects.setActive("local", { active: "other" });
  const switched = await app.registry.execute("shell.execute", { executable: "show", secrets: ["DEPLOY_TOKEN", "ONLY_OTHER"] }, context);
  assert.equal(switched.stdout, "token=[secret DEPLOY_TOKEN] other=[secret ONLY_OTHER]");
  assert.equal(scrubSecrets("a tok-x b", { T: "tok" }), "a tok-x b", "very short values are not scrubbed into noise");
  assert.equal(locker.removeProject("local", "other"), 2);
});

test("HTTP API manages projects and secret names without ever returning a value", async (t) => {
  const { app, root, closing } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closing.push(() => server.close());
  const call = async (path, body) => {
    const response = await fetch(server.url + "/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json(), text: JSON.stringify(await Promise.resolve(null)) };
  };
  assert.equal((await call("state")).data.project.active.id, "default");
  assert.equal((await call("projects", { id: "site", name: "Site", modelPreset: "nope" })).status, 400);
  assert.equal((await call("projects", { id: "site", name: "Site", modelPreset: "beta" })).status, 200);
  assert.equal((await call("projects/active", { active: "site" })).data.id, "site");
  const saved = await call("secrets", { project: "site", name: "API_KEY", value: "very-secret-value" });
  assert.equal(saved.status, 200);
  assert.ok(!JSON.stringify(saved.data).includes("very-secret"));
  const listing = await call("secrets/site");
  assert.deepEqual(listing.data.secrets.map((s) => s.name), ["API_KEY"]);
  assert.ok(!JSON.stringify(listing.data).includes("very-secret"));
  assert.equal((await call("secrets/missing")).status, 404);
  assert.equal((await call("secrets/site/API_KEY/remove", {})).data.removed, true);
  assert.equal((await call("projects/site/remove", {})).data.active, "default");
  assert.equal((await call("state")).data.project.all.length, 1);
});
