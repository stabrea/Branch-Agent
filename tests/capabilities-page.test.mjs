/**
 * Owner item 17, slice 3: Settings › Capabilities. Every switchable capability as one on/off switch,
 * grouped, with the Tool loading switch and what switching it off would cost at the top. Stored values
 * are kept as they were (no migration): on writes "when needed", off writes "off", and a record
 * already "on" keeps it. Lockdown keeps what it covers off; a short-lived key changes nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-capabilities-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (body, key = server.token) => {
    const response = await fetch(server.url + "/api/capabilities", { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, server, call, owner: app.runtime.owner };
}
const row = (view, key) => view.rows.find((entry) => entry.key === key);

test("every switch is one row, and switching writes the three-way value without migrating anything", async (t) => {
  const { app, call, owner } = await fixture(t);
  const view = (await call()).body;
  assert.equal(view.toolLoading.mode, "deferred");
  assert.ok(view.rows.length >= 70, `about 70 tool switches plus the context files (${view.rows.length})`);
  assert.deepEqual(row(view, "web-pages"), { key: "web-pages", label: "Reading and crawling web pages", group: "research", on: false, always: false, tools: 2, locked: false });
  assert.equal((await call({ key: "web-pages", on: true })).body.on, true);
  assert.equal(app.store.get("settings", owner, "web-pages").data.mode, "when-needed", "on writes when needed");
  await call({ key: "web-pages", on: false });
  assert.equal(app.store.get("settings", owner, "web-pages").data.mode, "off");
  // A record saved as "on" before this page keeps it, and says it is always loaded.
  app.store.save("settings", owner, "troubleshoot", { mode: "on" });
  assert.deepEqual([row((await call()).body, "troubleshoot").on, row((await call()).body, "troubleshoot").always], [true, true]);
  await call({ key: "troubleshoot", on: true });
  assert.equal(app.store.get("settings", owner, "troubleshoot").data.mode, "on", "switching on again keeps a legacy on");
  // A field inside a bigger record, and the context files.
  await call({ key: "voice#systemVoice", on: true });
  assert.equal(app.store.get("settings", owner, "voice").data.systemVoice, "when-needed");
  await call({ key: "context-files:agents", on: true });
  assert.equal(app.store.get("settings", owner, "context-files").data.files.agents, "when-needed");
  assert.equal((await call({ key: "made-up", on: true })).status, 400);
});

test("Lockdown keeps what it covers off, and a short-lived key changes nothing", async (t) => {
  const { app, call, owner } = await fixture(t);
  app.store.save("settings", owner, "lockdown", { on: true });
  const screen = row((await call()).body, "desktop-control");
  assert.deepEqual([screen.on, screen.locked], [false, true]);
  assert.equal((await call({ key: "desktop-control", on: true })).status, 400);
  assert.ok(row((await call()).body, "web-pages").locked === false, "what Lockdown does not cover stays switchable");
  const key = app.sessionTokens.create(owner, { name: "phone", scope: "run" }).token;
  assert.ok([401, 403].includes((await call({ key: "web-pages", on: true }, key)).status));
  assert.equal(app.store.get("settings", owner, "web-pages")?.data?.mode ?? "off", "off");
});

test("the Capabilities page shows the Tool loading switch with its cost, and a switch that saves", async (t) => {
  const { chromium } = await import("playwright");
  const { app, server, owner } = await fixture(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await openSettings(page, "capabilities");
  const loading = page.locator("#lx-page-capabilities #capabilities-loading");
  await loading.waitFor();
  assert.equal(await page.getByRole("switch", { name: "Load tools only when a task needs them" }).isChecked(), true, "Tool loading ships on");
  assert.match(await loading.innerText(), /Nothing with tools is switched on yet|Off would load/);
  const web = page.locator('#lx-page-capabilities [data-key="web-pages"] input[role="switch"]');
  await web.check();
  for (let i = 0; i < 50 && app.store.get("settings", owner, "web-pages")?.data?.mode !== "when-needed"; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.store.get("settings", owner, "web-pages").data.mode, "when-needed");
  await page.waitForFunction(() => /Off would load \d+ tools/.test(document.querySelector("#capabilities-loading")?.innerText ?? ""));
  await page.getByRole("switch", { name: "Load tools only when a task needs them" }).uncheck();
  for (let i = 0; i < 50 && app.store.get("settings", owner, "tool-loading")?.data?.mode !== "eager"; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.store.get("settings", owner, "tool-loading").data.mode, "eager");
  assert.deepEqual(errors, []);
});
