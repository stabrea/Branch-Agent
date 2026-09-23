import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-conversation-cost-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { port: 0, dataDir: join(root, "data") });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const cost = (session, token = server.token) => fetch(new URL(`/api/sessions/${session}/cost`, server.url), {
    headers: { authorization: `Bearer ${token}` },
  });
  return { app, server, cost };
}

test("conversation cost distinguishes a known free task from an unknown or missing conversation", async (t) => {
  const { app, cost } = await fixture(t);
  const run = app.store.createRun(app.runtime.owner, "Free local task");
  assert.deepEqual(await (await cost(run.sessionId)).json(), { amount: null, currency: "USD" });
  app.store.event(run.id, "model.complete", { model: "local-model" });
  assert.deepEqual(await (await cost(run.sessionId)).json(), { amount: 0, currency: "USD" });
  app.store.createRun(app.runtime.owner, "Unknown task", run.sessionId);
  assert.equal((await (await cost(run.sessionId)).json()).amount, null);
  assert.equal((await cost(randomUUID())).status, 404);
});

test("conversation cost is authenticated, profile-scoped, and does not broaden conversation-key access", async (t) => {
  const { app, cost } = await fixture(t);
  const ownerRun = app.store.createRun(app.runtime.owner, "Owner task");
  assert.equal((await cost(ownerRun.sessionId, "invalid")).status, 401);
  const key = app.sessionTokens.create(app.runtime.owner, { scope: "read", minutes: 5, sessionId: ownerRun.sessionId });
  assert.equal((await cost(ownerRun.sessionId, key.token)).status, 401, "new route is not added to the bound-key allowlist");
  const person = app.store.profiles.create({ name: "Household", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  assert.equal((await cost(ownerRun.sessionId)).status, 404);
  const personalRun = app.store.createRun(app.store.profiles.scope(), "Personal task");
  assert.equal((await cost(personalRun.sessionId)).status, 200);
  app.store.profiles.switch({ profileId: null });
  assert.equal((await cost(personalRun.sessionId)).status, 404);
  assert.equal((await cost(ownerRun.sessionId)).status, 200);
});
