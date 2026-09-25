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
    // Q239: a row whose file names where it sends, and carries a secret.
    { owner, id: "automatic-problem-reports", data: JSON.stringify({ mode: "on", destination: { kind: "github", repository: "file-maker/inbox" }, apiToken: "s3cret-from-file" }) },
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
  const shown = await card.innerText();
  assert.match(shown, /A restore is waiting for your answer/);
  for (const id of ["goal:held-test", "handoffs:held-test", "automatic-problem-reports"]) assert.ok(shown.includes(id), `${id} is listed`);
  assert.deepEqual(setting("goal:held-test"), { mine: true }, "control: this computer's own stays until the owner answers");
  // Q239 (NAS 9368030): the owner sees what a yes would turn on: the file's own address, never its secret.
  const reports = card.locator(".restore-held-row", { hasText: "automatic-problem-reports" });
  const reportsText = await reports.innerText();
  assert.match(reportsText, /From the backup:/);
  assert.match(reportsText, /destination\.repository: file-maker\/inbox/);
  assert.match(reportsText, /mode: on/);
  assert.doesNotMatch(await card.innerText(), /s3cret-from-file/, "a secret the file carries is never shown");
  assert.match(await card.locator(".restore-held-row", { hasText: "goal:held-test" }).innerText(), /fromFile: true/, "every field is shown");
  // "Use all" says what it would turn on and asks once more; "Not now" changes nothing.
  await card.getByRole("button", { name: "Use all from the backup" }).click();
  const confirm = page.locator("#restore-held-confirm");
  assert.match(await confirm.innerText(), /This puts all of these in place[\s\S]*file-maker\/inbox/);
  await confirm.getByRole("button", { name: "Not now" }).click();
  assert.equal(await confirm.innerText(), "");
  assert.deepEqual(setting("goal:held-test"), { mine: true }, "nothing was put in place");

  await card.locator(".restore-held-row", { hasText: "goal:held-test" }).getByRole("button", { name: "Use the backup's" }).click();
  await page.locator("#restore-held-status", { hasText: "goal:held-test now comes from the backup" }).waitFor();
  assert.deepEqual(setting("goal:held-test"), { fromFile: true }, "a yes puts the backup's in place");
  assert.equal(await card.locator(".restore-held-row").count(), 2, "and it no longer waits");

  await card.getByRole("button", { name: "Keep all of this computer's" }).click();
  await card.waitFor({ state: "hidden" });
  assert.deepEqual(setting("handoffs:held-test"), { mine: true }, "keeping leaves this computer's own");
  assert.deepEqual(app.store.restoreHeld.groups(), [], "nothing waits any more");
  assert.deepEqual(errors, []);
});
