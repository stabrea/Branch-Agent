/**
 * Q226 (NAS 9ec0d3a): a short-lived key stops only the tasks it started, working or waiting, as it may only answer
 * their questions. A run key could stop any working task of the owner's before; the owner's own stop is unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** A model that works until it is stopped. */
const blocking = { name: "blocking", async complete({ signal }) {
  await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  return { content: "unused", toolCalls: [] };
} };
const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25)); return check(); };

test("Q226 a run key stops a working task only when it started it; the owner stops any", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-key-stops-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: blocking });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const post = (path, bearer, body = {}) => fetch(`${server.url}/api/${path}`, { method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  const running = () => app.store.sqlite.prepare("SELECT id, prompt FROM tasks WHERE status='running'").all();
  const owners = app.runtime.run({ prompt: "the owner's own work" }).catch(() => undefined);
  const keys = post("run", key, { prompt: "the script's own work" });
  assert.ok(await until(() => running().length === 2), "control: both tasks are working");
  const id = (prompt) => String(running().find((row) => row.prompt === prompt).id);
  const ownerTask = id("the owner's own work"), keyTask = id("the script's own work");
  const refused = await post(`runs/${ownerTask}/cancel`, key);
  assert.equal(refused.status, 401, JSON.stringify(refused.body));
  assert.match(refused.body.error, /can only stop tasks it started itself/);
  assert.equal(app.store.run(ownerTask).status, "running", "the key stopped nothing");
  assert.deepEqual((await post(`runs/${keyTask}/cancel`, key)).body, { cancelled: true }, "its own task it stops");
  assert.deepEqual((await post(`runs/${ownerTask}/cancel`, server.token)).body, { cancelled: true }, "the owner stops theirs");
  await Promise.allSettled([owners, keys]);
});
