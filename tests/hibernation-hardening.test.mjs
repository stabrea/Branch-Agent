/**
 * FQ-operations.hibernation, review fixes: an operation id names only a folder inside the store,
 * the routes are the owner's alone, two calls on one operation never interleave, a workspace with
 * a sub-folder can be suspended, and a changed workspace is not resumed without the owner saying so.
 * Everything runs from a temporary data folder; nothing is fetched from outside this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { HibernationStore } from "../dist/hibernation.js";

async function boot(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-hibernation-hard-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider: { name: "scripted", complete: async () => ({ content: "ok", toolCalls: [] }) } });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  /** Sends the path exactly as written: fetch() would tidy "../" away before it left this process. */
  const raw = (method, path, body, key = server.token) => new Promise((resolve, reject) => {
    const url = new URL(server.url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const sent = request({ host: url.hostname, port: url.port, method, path, headers: {
      authorization: `Bearer ${key}`, origin: server.url,
      ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
    } }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text }));
    });
    sent.on("error", reject);
    if (payload !== undefined) sent.write(payload);
    sent.end();
  });
  return { root, dataDir, app, server, raw };
}

/** A manifest planted outside the store, where an id made of "../" would have led. */
async function plantOutside(root) {
  const outside = join(root, "elsewhere");
  await mkdir(join(outside, "workspace"), { recursive: true });
  const planted = JSON.stringify({ id: "../../elsewhere", environment: "local", steps: ["x", "y"], step: 0, status: "running", hashes: {}, note: "outside-the-store" });
  await writeFile(join(outside, "manifest.json"), planted, "utf8");
  return { outside, planted };
}

test("HH1 an encoded ../ in the address does not read a manifest outside the store", async (t) => {
  const { root, raw } = await boot(t);
  await plantOutside(root);
  for (const path of ["/api/hibernation/..%2F..%2Felsewhere", "/api/hibernation/..%5C..%5Celsewhere", "/api/hibernation/%2E%2E%2F%2E%2E%2Felsewhere"]) {
    const answer = await raw("GET", path);
    assert.equal(answer.status, 404, `${path} → ${answer.status} ${answer.text}`);
    assert.doesNotMatch(answer.text, /outside-the-store/, path);
  }
});

test("HH2 an id made of ../ in a request body reads and changes nothing outside the store", async (t) => {
  const { root, raw } = await boot(t);
  const { outside, planted } = await plantOutside(root);
  for (const id of ["../../elsewhere", "..\\..\\elsewhere", "../../elsewhere/"]) {
    for (const action of ["advance", "suspend", "resume"]) {
      const answer = await raw("POST", `/api/hibernation/${action}`, { id });
      assert.equal(answer.status, 404, `${action} ${id} → ${answer.status} ${answer.text}`);
      assert.doesNotMatch(answer.text, /outside-the-store/);
    }
  }
  assert.equal(await readFile(join(outside, "manifest.json"), "utf8"), planted, "the planted manifest is untouched");
  assert.deepEqual(await readdir(join(outside, "workspace")), [], "no step was written outside the store");
});

test("HH3 the store itself answers 'no such operation' for any id that is not one it made", async (t) => {
  const { root, dataDir } = await boot(t);
  await plantOutside(root);
  const store = new HibernationStore(dataDir);
  for (const id of ["../../elsewhere", "..\\..\\elsewhere", "", ".", "..", "/etc", "C:\\Windows", "ABCDEF00-0000-4000-8000-000000000000x"])
    await assert.rejects(store.read(id), /No operation by the id/, JSON.stringify(id));
  const made = await store.start("local", ["a"]);
  assert.equal((await store.read(made.id)).id, made.id, "an id the store made still reads");
});

test("HH4 the hibernation routes are the owner's: a short-lived key can neither read nor change them", async (t) => {
  const { app, dataDir, raw } = await boot(t);
  const made = await new HibernationStore(dataDir).start("local", ["a"]);
  for (const scope of ["read", "run"]) {
    const key = app.sessionTokens.create(app.runtime.owner, { name: scope, scope, minutes: 5 }).token;
    for (const path of ["/api/hibernation", "/api/hibernation/operations", "/api/hibernation/00000000-0000-4000-8000-000000000000"])
      assert.equal((await raw("GET", path, undefined, key)).status, 401, `${scope} GET ${path}`);
    for (const action of ["settings", "start", "advance", "suspend", "resume"])
      assert.equal((await raw("POST", `/api/hibernation/${action}`, action === "start" ? { steps: ["a"] } : { id: made.id }, key)).status, 401, `${scope} POST ${action}`);
  }
});

test("HH5 two advances at once run each step exactly once", async (t) => {
  const { dataDir } = await boot(t);
  for (let round = 0; round < 10; round++) {
    const made = await new HibernationStore(dataDir).start("local", ["one", "two", "three"]);
    // Two separate store objects, as src/server.ts builds a fresh one for every request.
    await Promise.all([new HibernationStore(dataDir).advance(made.id), new HibernationStore(dataDir).advance(made.id)]);
    const record = await new HibernationStore(dataDir).read(made.id);
    assert.equal(record.step, 2, `round ${round}: two advances moved the operation two steps`);
    const files = (await readdir(new HibernationStore(dataDir).workspacePath(made.id))).sort();
    assert.deepEqual(files, ["step-0.txt", "step-1.txt"], `round ${round}`);
  }
});

test("HH6 an advance racing a suspend leaves the frozen bytes matching the workspace and the step count", async (t) => {
  const { dataDir } = await boot(t);
  for (let round = 0; round < 10; round++) {
    const made = await new HibernationStore(dataDir).start("local", ["one", "two", "three"]);
    await Promise.allSettled([new HibernationStore(dataDir).advance(made.id), new HibernationStore(dataDir).suspend(made.id)]);
    const store = new HibernationStore(dataDir);
    const record = await store.read(made.id);
    const files = (await readdir(store.workspacePath(made.id))).sort();
    assert.equal(record.status, "suspended", `round ${round}`);
    assert.equal(record.step, files.length, `round ${round}: the saved step matches the steps written`);
    assert.deepEqual(Object.keys(record.hashes).sort(), files, `round ${round}: every written step was frozen`);
    const resumed = await store.resume(made.id);
    assert.deepEqual(resumed.workspace, { intact: true }, `round ${round}`);
  }
});

test("HH7 a workspace with a sub-folder suspends, and a change inside it is named on resume", async (t) => {
  const { dataDir } = await boot(t);
  const store = new HibernationStore(dataDir);
  const made = await store.start("local", ["one", "two"]);
  await store.advance(made.id);
  await mkdir(join(store.workspacePath(made.id), "notes", "deep"), { recursive: true });
  await writeFile(join(store.workspacePath(made.id), "notes", "deep", "x.txt"), "first", "utf8");
  const suspended = await store.suspend(made.id);
  assert.equal(suspended.status, "suspended");
  assert.equal((await store.read(made.id)).status, "suspended", "the operation is not left stuck running");
  assert.ok("notes/deep/x.txt" in suspended.hashes, Object.keys(suspended.hashes).join(", "));
  await writeFile(join(store.workspacePath(made.id), "notes", "deep", "x.txt"), "changed", "utf8");
  await assert.rejects(store.resume(made.id), (error) => {
    assert.deepEqual(error.changed, ["notes/deep/x.txt"]);
    return true;
  });
});

test("HH8 a changed workspace is not resumed until the owner says to continue anyway", async (t) => {
  const { dataDir, raw } = await boot(t);
  const store = new HibernationStore(dataDir);
  const made = await store.start("local", ["one", "two"]);
  await store.advance(made.id);
  await store.suspend(made.id);
  await writeFile(join(store.workspacePath(made.id), "step-0.txt"), "tampered", "utf8");
  const refused = await raw("POST", "/api/hibernation/resume", { id: made.id });
  assert.equal(refused.status, 409, refused.text);
  assert.match(JSON.parse(refused.text).error, /changed since it was suspended: step-0\.txt/);
  assert.equal((await store.read(made.id)).status, "suspended", "a refused resume leaves it suspended");
  const accepted = await raw("POST", "/api/hibernation/resume", { id: made.id, acceptChanges: true });
  assert.equal(accepted.status, 200, accepted.text);
  const body = JSON.parse(accepted.text);
  assert.equal(body.record.status, "running");
  assert.deepEqual(body.workspace, { intact: false, changed: ["step-0.txt"] });
});

test("HH9 asking an operation to do what its state does not allow is a 409, not a server error", async (t) => {
  const { dataDir, raw } = await boot(t);
  const made = await new HibernationStore(dataDir).start("local", ["one"]);
  const early = await raw("POST", "/api/hibernation/resume", { id: made.id });
  assert.equal(early.status, 409, early.text);
  assert.match(JSON.parse(early.text).error, /Only a suspended operation can be resumed/);
});
