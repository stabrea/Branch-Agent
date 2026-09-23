import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace } from "./places.mjs";

/**
 * The Notes panel (public/collab-events.js), reached from Schedules: publishing a note under the
 * owner's identity, and a note tampered with after signing dropping out of the list.
 */
async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-collab-events-ui-"));
  const provider = { name: "collab-events-ui", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await discardTemp(root).catch(() => undefined);
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await openPlace(page, "schedules");
  return { app, page, errors };
}

test("a note sent from the panel lists as genuine; a tampered one drops out and is counted as rejected", async (t) => {
  const { app, page, errors } = await fixture(t);
  const section = page.locator('[data-part="events"]');
  await section.waitFor({ state: "visible" });

  await section.getByLabel("Write a note for the household").fill("Groceries are done");
  await section.getByRole("button", { name: "Send", exact: true }).click();
  await section.getByText("Groceries are done").waitFor({ timeout: 10000 });

  // Published under the owner, not somebody named in the request (nobody was), and it verifies.
  const stored = app.store.sqlite.prepare("SELECT id, member, signature FROM collab_events ORDER BY at DESC LIMIT 1").get();
  assert.ok(stored, "the note was written to the database");
  assert.deepEqual((await app.store.collabEvents.verify({ ...(await app.store.collabEvents.list(app.runtime.owner)).events.find((e) => e.id === stored.id) })).valid, true);

  // Somebody edits the stored payload directly, the way a relay or a database edit would.
  app.store.sqlite.prepare("UPDATE collab_events SET payload=? WHERE id=?")
    .run(JSON.stringify({ text: "Groceries are NOT done" }), stored.id);

  await page.waitForFunction(
    () => !document.querySelector('[data-part="events"]')?.textContent.includes("Groceries are done"),
    { timeout: 10000 },
  );
  await section.getByText(/changed after they were signed/).waitFor({ timeout: 10000 });
  assert.equal(await section.getByText("Groceries are NOT done").count(), 0, "a changed note is never shown, tampered or original");
  assert.deepEqual(errors, []);
});
