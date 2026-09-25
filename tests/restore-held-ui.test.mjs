/**
 * Q230 part 3: a restore holds what can change who Branch talks to, what it runs or how careful it is, and Settings ›
 * Backup is where the owner answers, group by group or all at once. Until then this computer's own stays. Headless only.
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
import { openSettings } from "./places.mjs";

test("the backup card lists what a restore holds, and each answer puts it in place or keeps this computer's", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-restore-held-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const setting = (id) => app.store.get("settings", owner, id)?.data;
  // What a restore held: this computer has its own values, the file had others.
  app.store.save("settings", owner, "goal:held-test", { mine: true });
  app.store.save("settings", owner, "handoffs:held-test", { mine: true });
  app.store.restoreHeld.merge([
    { owner, id: "goal:held-test", data: JSON.stringify({ fromFile: true }) },
    { owner, id: "handoffs:held-test", data: JSON.stringify({ fromFile: true }) },
  ]);
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", body: JSON.stringify({ done: true }),
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 30000 }).catch(async (error) => { throw new Error(`${error.message}\npage errors: ${errors.join(" | ")}\nPAGETEXT ${(await page.locator("body").innerText()).slice(0, 600).replace(/\n/g, " / ")}`); });
  await openSettings(page, "data");
  const card = page.locator("#restore-held");
  await page.locator("#backup-card").scrollIntoViewIfNeeded();
  await card.waitFor({ state: "visible", timeout: 20000 });
  assert.match(await card.innerText(), /A restore is waiting for your answer[\s\S]*goal:held-test[\s\S]*handoffs:held-test/);
  assert.deepEqual(setting("goal:held-test"), { mine: true }, "control: this computer's own stays until the owner answers");

  await card.locator(".restore-held-row", { hasText: "goal:held-test" }).getByRole("button", { name: "Use the backup's" }).click();
  await page.locator("#restore-held-status", { hasText: "goal:held-test now comes from the backup" }).waitFor();
  assert.deepEqual(setting("goal:held-test"), { fromFile: true }, "a yes puts the backup's in place");
  assert.equal(await card.locator(".restore-held-row").count(), 1, "and it no longer waits");

  await card.getByRole("button", { name: "Keep all of this computer's" }).click();
  await card.waitFor({ state: "hidden" });
  assert.deepEqual(setting("handoffs:held-test"), { mine: true }, "keeping leaves this computer's own");
  assert.deepEqual(app.store.restoreHeld.groups(), [], "nothing waits any more");
  assert.deepEqual(errors, []);
});
