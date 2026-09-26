import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { ToolRegistry, Budget, createBranch } from "../dist/index.js";
import { liveStage } from "../dist/live-stage.js";

/**
 * live-stage: GET /api/panels/live (src/live-stage.ts) and the frame under it (BranchBrowser.watch).
 *
 * The frame comes from Branch's own browser tool opening a local page whose rules refuse any added style, with a
 * filled password box at the top: the frame is a JPEG of that page with the box covered. A run with no window has
 * nothing to watch. The route's own rules are held with a stand-in for the browser: only the owner's own
 * conversation is answered, the last frame is kept (not live) once the task ends, and addresses that carry a
 * key-shaped value or are not web addresses never come back as they were.
 */

const passwordPage = () => `<!doctype html><title>Frame page</title><body bgcolor="#1f9d55"><input type="password" value="correct-horse-battery-staple" size="150"><h1>Frame page</h1></body>`;

async function site() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'none'" });
    response.end(passwordPage());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
}

/** The colour of one pixel of a JPEG, read by a real browser drawing it onto a canvas. */
async function pixel(jpeg, x, y) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    return await page.evaluate(async ([src, px, py]) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      return [...g.getImageData(px, py, 1, 1).data.slice(0, 3)];
    }, [`data:image/jpeg;base64,${jpeg.toString("base64")}`, x, y]);
  } finally { await browser.close(); }
}

test("a task's window is watched as a JPEG frame with its password box covered, and nothing else is", async (t) => {
  const page = await site();
  const browser = new BranchBrowser({ allowedOrigins: [page.origin] });
  t.after(async () => { await browser.close(); await page.close(); });
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  const context = { owner: "local", workspace: ".", runId: "livestage", signal: AbortSignal.timeout(60000),
    budget: new Budget(), permissions: new Set(["browser.read"]), depth: 0 };
  assert.equal(await browser.watch("local", "livestage"), null, "no window yet: nothing to watch");
  await registry.execute("browser.navigate", { url: `${page.origin}/` }, context);
  const seen = await browser.watch("local", "livestage");
  assert.equal(seen.url, `${page.origin}/`);
  assert.equal(seen.title, "Frame page");
  assert.deepEqual(seen.tabs, [{ url: `${page.origin}/`, title: "Frame page", active: true }]);
  assert.equal(seen.borrowed, false);
  assert.deepEqual([...seen.frame.subarray(0, 3)], [0xff, 0xd8, 0xff], "the frame is a JPEG");
  const box = await pixel(seen.frame, 300, 18), body = await pixel(seen.frame, 640, 400);
  assert.ok(box.every((v) => v < 40), `the password box is covered: ${box}`);
  assert.ok(body[1] > 120 && body[0] < 90, `the page itself is there: ${body}`);
  assert.equal(await browser.watch("local", "another-run"), null, "another run's window is not this one");
  assert.equal(await browser.watch("someone-else", "livestage"), null, "the same run under another owner is nothing");
});

async function engine(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-live-stage-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
const frame = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

test("only the owner's own conversation is answered; the last frame outlives its task, not live", async (t) => {
  const app = await engine(t);
  const owner = app.store.profiles.scope();
  const run = app.store.createRun(owner, "open a page");
  const watched = [];
  let open = true;
  const browser = { async watch(who, runId) {
    watched.push([who, runId]);
    return open ? { url: "https://example.org/a", title: "A page", tabs: [{ url: "https://example.org/a", title: "A page", active: true }], frame, borrowed: false } : null;
  } };
  const deps = { store: app.store, owner: "local", profiles: app.store.profiles, browser };
  const now = await liveStage(deps, run.sessionId);
  assert.equal(now.runId, run.id);
  assert.equal(now.status, "running");
  assert.equal(now.browser.live, true);
  assert.equal(now.browser.url, "https://example.org/a");
  assert.equal(now.browser.frame, `data:image/jpeg;base64,${frame.toString("base64")}`);
  assert.deepEqual(watched.at(-1), ["local", run.id], "the window is asked for under the runtime's owner and this run");

  assert.deepEqual(await liveStage(deps, "not-a-conversation"), { runId: null, status: null, doing: null, browser: null });
  const other = await liveStage({ ...deps, profiles: { scope: () => owner, isOwner: () => false } }, run.sessionId);
  assert.deepEqual(other, { runId: null, status: null, doing: null, browser: null }, "a household person is shown nothing");

  app.store.finish(run.id, "completed", "done");
  open = false;
  const after = await liveStage(deps, run.sessionId);
  assert.equal(after.runId, null, "nothing is going");
  assert.equal(after.browser.live, false, "the last frame is kept, not live");
  assert.equal(after.browser.url, "https://example.org/a");
});

test("addresses and titles never come back with a key in them, and only web addresses are shown", async (t) => {
  const app = await engine(t);
  const owner = app.store.profiles.scope();
  const run = app.store.createRun(owner, "open a page");
  const key = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const browser = { async watch() {
    return { url: `https://example.org/?key=${key}`, title: `Key ${key}`, tabs: [{ url: "file:///C:/secret.txt", title: "x", active: false }], frame: null, borrowed: false };
  } };
  const view = await liveStage({ store: app.store, owner: "local", profiles: app.store.profiles, browser }, run.sessionId);
  assert.ok(!view.browser.url.includes(key) && !view.browser.title.includes(key), JSON.stringify(view.browser));
  assert.equal(view.browser.tabs[0].url, "", "a file address is not shown");
  assert.equal(view.browser.frame, null);
});
