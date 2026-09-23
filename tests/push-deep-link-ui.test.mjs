/**
 * FQ-surfaces.mobile-push (deep link): tapping a push notification runs the service worker's
 * notificationclick handler, which postMessages { type: "branch-push-open", runId, sessionId } to
 * every open client (public/service-worker.js). public/push.js re-dispatches that as a
 * "branch-push-open" DOM CustomEvent. This test proves the page itself acts on that event: it
 * jumps to chat and opens the conversation the notification named, the same way tapping a waiting-
 * attention row does (public/app.js waitingMessageRow's `open`).
 *
 * No real push service is involved — dispatching the DOM event directly is the documented seam
 * between the worker and the page (see tests/web-push-integration.test.mjs for the server-to-worker
 * half). A temp data folder and a local server on port 0 only; no network.
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
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

async function fixture(t, before) {
  const root = await mkdtemp(join(tmpdir(), "branch-push-deep-link-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 900 } });
  t.after(async () => {
    await context.close();
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /* `before` may stage the page and name the address it opens at; "/" otherwise. */
  const path = (await before?.({ app, page })) ?? "/";
  await page.goto(server.url + path);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, server, errors };
}

test("push: a tapped notification's branch-push-open event opens the conversation it named", async (t) => {
  const f = await fixture(t);

  // A first conversation, so there is something a notification can point back at.
  await f.page.locator("#prompt").fill("push deep link target conversation");
  await f.page.locator("#send").click();
  await f.page.locator(".message.assistant").first().waitFor({ timeout: 30000 });
  const targetId = await f.page.evaluate(() => document.getElementById("conversation").dataset.sessionId);
  assert.ok(targetId, "the first conversation has a session id");

  // Leave it for a different one — a real background push arrives while the owner is elsewhere.
  await f.page.locator("#rail-new").click();
  await f.page.locator("#prompt").fill("a different, later conversation");
  await f.page.locator("#send").click();
  await f.page.locator(".message.assistant").first().waitFor({ timeout: 30000 });
  const otherId = await f.page.evaluate(() => document.getElementById("conversation").dataset.sessionId);
  assert.ok(otherId && otherId !== targetId, "the owner is now on a different conversation");

  // The service worker's tap-through, as public/push.js re-dispatches it.
  await f.page.evaluate((detail) => {
    document.dispatchEvent(new CustomEvent("branch-push-open", { detail }));
  }, { runId: "run-from-notification", sessionId: targetId });

  await f.page.locator("#thread-name", { hasText: "push deep link target conversation" }).waitFor({ timeout: 10000 });
  const openedId = await f.page.evaluate(() => document.getElementById("conversation").dataset.sessionId);
  assert.equal(openedId, targetId, "the notification's own conversation is the one that opens, not the one left open");
  assert.equal(await f.page.locator("#chat").isHidden(), false, "the chat view is on screen");

  // An event naming no conversation is a no-op — it must not throw or blank the current one.
  await f.page.evaluate(() => document.dispatchEvent(new CustomEvent("branch-push-open", { detail: { runId: "no-session" } })));
  await f.page.waitForTimeout(200);
  assert.equal(await f.page.evaluate(() => document.getElementById("conversation").dataset.sessionId), targetId);

  assert.deepEqual(f.errors, []);
});

test("push: a tap that had to open a new window opens the conversation it named once signed in", async (t) => {
  let targetId;
  const f = await fixture(t, async ({ app }) => {
    const run = await app.runtime.run({ prompt: "push fresh window target" });
    targetId = run.sessionId;
    return `/?push-session=${encodeURIComponent(targetId)}`;
  });
  await f.page.locator("#thread-name", { hasText: "push fresh window target" }).waitFor({ timeout: 15000 });
  assert.equal(await f.page.evaluate(() => document.getElementById("conversation").dataset.sessionId), targetId);
  assert.equal(await f.page.evaluate(() => location.search), "", "the address is put back, so a reload does not open it again");
  assert.deepEqual(f.errors, []);
});

test("push: when the server refuses a subscription, the browser lets go of it too", async (t) => {
  const f = await fixture(t, async ({ page }) => {
    // No real push service in a test browser: a stand-in subscription that counts being let go of.
    await page.addInitScript(() => {
      globalThis.unsubscribedCount = 0;
      const fake = {
        endpoint: "https://push.example/refused",
        toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "p", auth: "a" } }; },
        async unsubscribe() { globalThis.unsubscribedCount += 1; return true; },
      };
      PushManager.prototype.getSubscription = async () => null;
      PushManager.prototype.subscribe = async () => fake;
    });
    await page.route("**/api/push/subscribe", (route) => route.fulfill({
      status: 400, contentType: "application/json", body: JSON.stringify({ error: "That is not a push subscription." }),
    }));
  });
  await f.page.locator("#push-card button").waitFor({ state: "attached", timeout: 15000 });
  await f.page.evaluate(() => document.querySelector("#push-card button").click());
  await f.page.waitForFunction(() => globalThis.unsubscribedCount === 1, null, { timeout: 10000 });
  assert.equal(await f.page.locator("#push-card [role=status]").textContent(), "That is not a push subscription.");
  assert.deepEqual(f.errors, []);
});
