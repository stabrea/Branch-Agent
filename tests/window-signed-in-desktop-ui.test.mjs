/**
 * Dogfood F7: the desktop app signs every /api/ request itself and never gives the page its key. A dozen parts of the
 * page asked "is anyone signed in?" by reading branch-token, so in the desktop the comfort settings (keys,
 * notifications, "update by itself") never loaded and Dev never updated itself. The window now says it is signed in
 * with a stand-in, and the desktop swaps whatever authorization the page wrote for its own key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signedHeaders } from "../dist/desktop/signed-headers.js";

test("the desktop sends only its own key, whatever authorization the page wrote", () => {
  assert.deepEqual(signedHeaders({ authorization: "Bearer desktop-window", Accept: "*/*" }, "real"), { Accept: "*/*", Authorization: "Bearer real" });
  assert.deepEqual(signedHeaders({ AUTHORIZATION: "Bearer x", Authorization: "Bearer y" }, "real"), { Authorization: "Bearer real" });
  assert.deepEqual(signedHeaders({}, "real"), { Authorization: "Bearer real" });
});

test("in the desktop window, with no key in the page, the settings that read it still load", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-desktop-signed-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  // What src/desktop/main.ts does: every /api/ request goes out with the app's own key, whatever the page wrote.
  const sent = [];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    sent.push(request.headers().authorization ?? "");
    return route.continue({ headers: signedHeaders(request.headers(), server.token) });
  });
  await page.goto(`${server.url}/?desktop=1`);
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  // The comfort settings load, so "update by itself" can be seen and chosen.
  await page.locator("#comfort-updates-card").waitFor({ state: "attached", timeout: 60000 });
  assert.ok(await page.locator("#comfort-notify-card").count(), "the notifications card loads too");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("branch-token")), "desktop-window", "the page holds a stand-in, never the key");
  assert.ok(!sent.some((header) => header.includes(server.token)), "the page itself never had the key to send");
});
