/**
 * FQ-packages.monitoring: a watch used to keep only its current snapshot, overwriting it on every
 * look, so the very observation that proved a change had happened was gone the moment anyone asked
 * to see it. Every look a watch takes is now kept, oldest first order preserved alongside the
 * latest, so the prior observation behind a change still answers when it is asked for later.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { Monitors } from "../dist/monitors.js";

/** A workspace, a private data directory and a Branch, thrown away when the test ends. */
async function fixture(t, options = {}) {
  const scratch = join(tmpdir(), "claude-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-monitor-history-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...options });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}

/** A single page whose body can be changed between looks, the way a real watched page would. */
async function site(t, body) {
  let current = body;
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(current);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, set: (next) => { current = next; } };
}

test("the observation before a change still answers after the watch has looked again", async (t) => {
  const page = await site(t, "<html><body><p>Open in March.</p></body></html>");
  const { app } = await fixture(t, { web: { allowPrivateAddresses: true } });
  const monitors = new Monitors(app.store, app.web);

  const watch = await monitors.create("local", { url: `${page.base}/`, every: 30, label: "Notes" });
  const baseline = monitors.history("local", watch.id);
  assert.equal(baseline.length, 1, "creating a watch took no observation of its own");
  assert.match(baseline[0].snapshot, /Open in March/);
  assert.equal(baseline[0].changed, false, "the very first look is not itself a change");

  page.set("<html><body><p>Open in April.</p></body></html>");
  const looked = await monitors.check("local", watch.id);
  assert.equal(looked.changed, true, "the change was not noticed");

  const afterChange = monitors.history("local", watch.id);
  assert.equal(afterChange.length, 2, "the look that found the change replaced the earlier one instead of joining it");
  const [newest, prior] = afterChange;
  assert.match(newest.snapshot, /Open in April/, "the newest observation is not the one just taken");
  assert.equal(newest.changed, true);
  assert.match(prior.snapshot, /Open in March/, "the prior observation did not survive being overwritten");
  assert.equal(prior.changed, false);
  assert.equal(prior.hash, baseline[0].hash, "the surviving prior observation is not the same one taken at creation");

  // A further look that finds nothing new is still kept, and the March observation still survives.
  const again = await monitors.check("local", watch.id);
  assert.equal(again.changed, false);
  const afterQuietLook = monitors.history("local", watch.id);
  assert.equal(afterQuietLook.length, 3);
  assert.ok(afterQuietLook.some((entry) => /Open in March/.test(entry.snapshot)),
    "the original observation was lost after a later, unrelated look");

  // Removing the watch also forgets the looks it took; nothing is left behind for its old id.
  monitors.remove("local", watch.id);
  assert.throws(() => monitors.history("local", watch.id), /no watch with that number/);
});

test("a watch's history belongs to its owner, and old looks are bounded rather than unlimited", async (t) => {
  const page = await site(t, "look 0");
  const { app } = await fixture(t, { web: { allowPrivateAddresses: true } });
  const monitors = new Monitors(app.store, app.web);
  const watch = await monitors.create("local", { url: `${page.base}/`, every: 30 });

  assert.throws(() => monitors.history("someone-else", watch.id), /no watch with that number/,
    "a different owner could read this watch's history");

  for (let i = 1; i <= 25; i += 1) {
    page.set(`look ${i}`);
    await monitors.check("local", watch.id);
  }
  const history = monitors.history("local", watch.id);
  assert.ok(history.length <= 20, "a long-running watch keeps every look without limit");
  assert.match(history[0].snapshot, /look 25/, "the newest look is not first");
  assert.ok(!history.some((entry) => /look 0\b/.test(entry.snapshot)), "the oldest looks were never pruned");
});

test("the watch history route answers over the API, and refuses an unknown watch", async (t) => {
  const page = await site(t, "<html><body><p>Open in March.</p></body></html>");
  const { app, root } = await fixture(t, { web: { allowPrivateAddresses: true } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (path, options = {}) => {
    const response = await fetch(server.url + path, {
      method: options.method ?? (options.body ? "POST" : "GET"),
      headers: { authorization: "Bearer " + server.token, ...(options.body ? { "content-type": "application/json" } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };

  const created = await call("/api/monitors", { body: { url: `${page.base}/`, every: "6h", label: "Notes" } });
  assert.equal(created.status, 200);
  page.set("<html><body><p>Open in April.</p></body></html>");
  await call(`/api/monitors/${created.body.id}/check`, { method: "POST" });

  const history = await call(`/api/monitors/${created.body.id}/history`);
  assert.equal(history.status, 200);
  assert.equal(history.body.observations.length, 2);
  assert.ok(history.body.observations.some((entry) => /Open in March/.test(entry.snapshot)),
    "the prior observation does not reach the owner through the API");

  assert.equal((await call("/api/monitors/not-a-watch/history")).status, 404);
});
