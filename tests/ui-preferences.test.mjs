/**
 * Q45: the window's own choices are kept by the engine in the data folder, not in the page's browser
 * storage, which belongs to the page's address. The desktop app picks a new port each start, so a
 * choice kept only in the browser came back as the default after an update. These tests hold the
 * engine's record to its promises (a default when nothing is saved, only named and checked fields,
 * an import that only fills what is empty) and prove a choice survives a new address.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { importUiPreferences, patchUiPreferences, readUiPreferences, LEGACY_IMPORT } from "../dist/ui-preferences.js";

/** A fresh engine in a throwaway folder, closed before the folder is removed. */
async function freshBranch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-ui-prefs-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

test("nothing saved yet answers the defaults, and a change keeps only the fields it names", async (t) => {
  const app = await freshBranch(t);
  const owner = app.runtime.owner;
  assert.deepEqual(readUiPreferences(app.store, owner), { revision: 0, values: {}, imports: {} });

  patchUiPreferences(app.store, owner, { set: { railView: "trunks", asideOpen: false } });
  const next = patchUiPreferences(app.store, owner, { set: { focusView: true } });
  assert.deepEqual(next.values, { railView: "trunks", asideOpen: false, focusView: true }, "an older field is not put back");
  assert.equal(next.revision, 2);
  assert.deepEqual(patchUiPreferences(app.store, owner, { set: { focusView: null } }).values, { railView: "trunks", asideOpen: false });

  assert.throws(() => patchUiPreferences(app.store, owner, { set: { branchToken: "x" } }), "a field nobody named is refused");
  assert.throws(() => patchUiPreferences(app.store, owner, { set: { railView: "everything" } }), "a value outside the choices is refused");
  assert.throws(() => patchUiPreferences(app.store, owner, { set: { paneTab: "../../etc" } }));
  assert.deepEqual(readUiPreferences(app.store, owner).values, { railView: "trunks", asideOpen: false }, "a refused change changes nothing");
});

test("the import from browser storage only fills what is empty, drops what fails its check, and twice is once", async (t) => {
  const app = await freshBranch(t);
  const owner = app.runtime.owner;
  patchUiPreferences(app.store, owner, { set: { railView: "conversations" } });

  const offered = { railView: "trunks", asideOpen: false, paneTab: "files", focusView: "yes", secret: "sk-1" };
  const first = importUiPreferences(app.store, owner, true, { name: LEGACY_IMPORT, values: offered });
  assert.deepEqual(first.filled, ["asideOpen", "paneTab"]);
  assert.deepEqual(first.values, { railView: "conversations", asideOpen: false, paneTab: "files" }, "what the engine held wins");
  assert.ok(first.imports[LEGACY_IMPORT], "the import is written down");

  const again = importUiPreferences(app.store, owner, true, { name: LEGACY_IMPORT, values: offered });
  assert.deepEqual(again.filled, []);
  assert.deepEqual({ revision: again.revision, values: again.values }, { revision: first.revision, values: first.values });

  assert.deepEqual(importUiPreferences(app.store, "profile:somebody", false, { name: LEGACY_IMPORT, values: { focusView: true } }).values, {},
    "a household person's window never takes the storage everybody at this computer shared");
  assert.throws(() => importUiPreferences(app.store, owner, true, { name: "anything", values: {} }));
});

/** A signed-in window at `server`: the token is where a reload after signing in finds it. */
async function openWindow(browser, server) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript((token) => sessionStorage.setItem("branch-token", token), server.token);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors, context };
}
const saved = (server) => fetch(new URL("/api/ui-preferences", server.url), { headers: { authorization: `Bearer ${server.token}` } }).then((r) => r.json());

test("a choice left in browser storage by an older version moves to the engine and comes back at a new address", async (t) => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const root = await mkdtemp(join(tmpdir(), "branch-ui-prefs-window-"));
  const open = [];
  t.after(async () => {
    await browser.close();
    for (const close of open.reverse()) await close().catch(() => undefined);
    await discardTemp(root);
  });

  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  open.push(() => app.close());
  const first = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  open.push(() => first.close());
  const before = await openWindow(browser, first);
  assert.equal(await before.page.evaluate(() => document.body.classList.contains("no-rail")), false, "the side list starts open");
  assert.deepEqual((await saved(first)).values, {}, "drawing the window saves no defaults back");
  /* What an older version left in this page's storage. */
  await before.page.evaluate(() => { localStorage.setItem("branch-rail", "closed"); localStorage.setItem("branch-focus-view", "1"); });
  const imported = before.page.waitForResponse((r) => r.url().endsWith("/api/ui-preferences/import"));
  await before.page.reload();
  assert.equal((await imported).status(), 200);
  assert.deepEqual((await saved(first)).values, { railOpen: false, focusView: true }, "the older choices are now the engine's");
  /* The import happens once: what lands in this page's storage later is only a copy, never imported. */
  await before.page.evaluate(() => localStorage.setItem("branch-rail-view", "trunks"));
  const imports = [];
  before.page.on("request", (request) => { if (request.url().endsWith("/api/ui-preferences/import")) imports.push(request); });
  const read = before.page.waitForResponse((r) => r.url().endsWith("/api/ui-preferences") && r.request().method() === "GET");
  await before.page.reload();
  await read;
  await before.page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await before.page.waitForTimeout(300);
  assert.equal(imports.length, 0, "no second import is asked for");
  assert.deepEqual((await saved(first)).values, { railOpen: false, focusView: true }, "a second start imports nothing");
  assert.deepEqual(before.errors, []);
  await before.context.close();
  for (const close of open.splice(0).reverse()) await close();

  /* An update: the same data folder, a new engine on a new port, so a new address with empty storage. */
  const updated = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  open.push(() => updated.close());
  const second = await startServer(updated, { dataDir: join(root, "data"), port: 0 });
  open.push(() => second.close());
  assert.notEqual(new URL(second.url).port, new URL(first.url).port);
  const after = await openWindow(browser, second);
  assert.equal(await after.page.evaluate(() => document.body.classList.contains("no-rail")), true, "the side list stays folded");
  assert.equal(await after.page.evaluate(() => localStorage.getItem("branch-rail")), "closed", "and this address keeps a copy");

  await after.page.evaluate(() => document.getElementById("rail-toggle").click());
  await after.page.waitForFunction(() => !document.body.classList.contains("no-rail"));
  await assert.doesNotReject(async () => {
    for (let tries = 0; tries < 50 && (await saved(second)).values.railOpen !== true; tries++) await after.page.waitForTimeout(100);
  });
  assert.deepEqual((await saved(second)).values, { railOpen: true, focusView: true }, "a change here is the engine's at once, and nothing else moves");
  assert.deepEqual(after.errors, []);
});
