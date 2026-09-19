/* Redesign phase 1: the pieces of the approved sample the owner loved most, built into the real window.
   Slate by default, the usage ring and its popover, the save-progress prompt, the suggestion bars and
   update cards, the permission-mode chip, and the glass dropdown with its tooltips. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, { provider, onboarded = true, width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-redesign-1-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  if (onboarded) await call("/api/onboarding", { done: true });
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => {
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.locator("body.lx-ready").waitFor({ state: "attached" });
  };
  await open();
  return { page, server, call, errors, app, open, context };
}

/* ---------------------------------------------------------------- 3. Slate by default */

test("a new window wears Slate, and a picked Forest is remembered over the new default", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.palette), "slate");
  assert.equal((await f.call("/api/look")).theme, "slate", "the shared record starts on Slate too");
  await f.page.evaluate(() => document.querySelector('.lx-quick[aria-label="Forest theme"]')?.click()
    ?? document.querySelector('#lx-theme-gallery .lx-tile[data-family="forest"]')?.click());
  await f.page.waitForFunction(() => document.documentElement.dataset.palette === "forest");
  assert.equal(await f.page.evaluate(() => localStorage.getItem("branch-palette")), "forest", "Forest is written down, not left as the default");
  await f.page.reload();
  await f.page.locator("body.lx-ready").waitFor({ state: "attached" });
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.palette), "forest");
  assert.deepEqual(f.errors, []);
});
