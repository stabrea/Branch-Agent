/**
 * Never breaks, the owner's screens: the "Keep running" card in Settings → General (and, later in
 * this file, the Telegram setup card). A headless browser opens them the way a person does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { proposeConfig } from "../dist/never-break/gateway-config.js";

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-never-ui-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  return { app, server, dataDir };
}
async function signedIn(t, server) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  return { page, errors };
}

test("the settings can only be changed with the master key, and the gateway itself stays hidden from tasks", async (t) => {
  const { app, server } = await served(t);
  const call = (method, path, body, token = server.token) => fetch(server.url + path, { method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const shown = await call("GET", "/api/never-break");
  assert.equal(shown.status, 200);
  assert.equal(shown.body.mode, "off", "shipped off");
  const key = app.sessionTokens.create(app.runtime.owner, { scope: "run", minutes: 5 });
  const refused = await call("POST", "/api/never-break", { mode: "on" }, key.token);
  assert.equal(refused.status, 401);
  assert.match(refused.body.error, /cannot change how Branch keeps itself running/);
  assert.equal((await call("POST", "/api/never-break", { mode: "on" })).body.mode, "on");
  assert.equal(app.registry.inventory().some((tool) => tool.name === "gateway.propose"), false,
    "the suggesting tool is only offered when the switch was on at launch");
});

test("the Keep running card sits in Settings → General, works in French and fits 400 px", async (t) => {
  const { server, dataDir } = await served(t);
  await proposeConfig(dataDir, { holdSeconds: 3 }, "Shorter waits while the assistant restarts", async () => ({ ok: false, detail: "The engine did not come up." }));
  const { page, errors } = await signedIn(t, server);
  await openPlace(page, "settings:general");
  const card = page.locator("#never-break-card");
  await card.waitFor({ state: "attached" });
  assert.equal(await card.getAttribute("data-home"), "settings:general");
  await page.waitForFunction(() => document.getElementById("never-break-card")?.closest("#lx-page-general"));
  assert.equal(await page.locator("#never-break-mode").inputValue(), "off");
  assert.match(await card.textContent(), /Keep running through crashes and updates[\s\S]*without the gatekeeper[\s\S]*Shorter waits[\s\S]*cannot be used/);
  assert.equal(await card.locator("button:not(.quiet-button)").count(), 1, "one filled button");
  assert.equal(await card.getByRole("button", { name: "Use this change" }).isDisabled(), true, "a change that failed its try cannot be used");
  assert.equal(await card.locator("h2").count(), 1);

  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.getElementById("never-break-card")?.textContent.includes("Continuer malgré les pannes"));
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));

  await page.locator("#never-break-mode").selectOption("when-needed");
  await card.getByRole("button", { name: "Save this setting" }).click();
  await card.locator("[role=status]", { hasText: "Saved." }).first().waitFor();
  await card.getByRole("button", { name: "Discard this change" }).click();
  await page.waitForFunction(() => !document.getElementById("never-break-card")?.textContent.includes("Shorter waits"));

  await page.setViewportSize({ width: 400, height: 800 });
  await openPlace(page, "settings:general");
  await card.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  const wide = await page.evaluate(() => [...document.querySelectorAll("#never-break-card *")]
    .filter((node) => node.getBoundingClientRect().right > document.documentElement.clientWidth + 1 || node.scrollWidth > node.clientWidth + 1)
    .map((node) => `${node.tagName} ${node.textContent.slice(0, 30)}`));
  assert.deepEqual(wide, []);
  assert.deepEqual(errors, []);
});
