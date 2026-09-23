/* FQ-surfaces.panes: "Compare topics side by side" (public/topic-panes.js, public/topic-panes.css).
   Headless only. Two conversations (topics) are opened as columns and messages must stay assigned
   to the topic they came from, even when the columns' own reads settle out of order. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const quiet = { name: "scripted", async complete() { return { content: "Here is a short answer.", toolCalls: [] }; } };

async function world(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-topic-panes-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
/** A finished two-message conversation about the given thing, so two topics never share any words. */
function seedTopic(app, thing) {
  const run = app.store.createRun(app.runtime.owner, `Tell me about ${thing}`);
  app.store.message(run.sessionId, { role: "user", content: `Tell me about ${thing}` });
  app.store.message(run.sessionId, { role: "assistant", content: `Here is what I know about ${thing}.` });
  app.store.finish(run.id, "completed", `Here is what I know about ${thing}.`);
  return run.sessionId;
}

async function windowFixture(t, { width = 1440, height = 950 } = {}) {
  const { app, root } = await world(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("body.lx-ready").waitFor({ state: "attached" });
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => Boolean(globalThis.branchTopicPanes));
  errors.length = 0; // whatever the login page failed at is not this feature's business
  return { app, page, context, errors };
}

/* ---------------------------------------------------------------- wired into the product */

test("More → Go to opens Compare topics side by side, and adding a topic through the picker shows its own messages", async (t) => {
  const f = await windowFixture(t);
  const cherries = seedTopic(f.app, "cherries");
  seedTopic(f.app, "plums"); // a second, unrelated topic that must never appear in the cherries column

  await f.page.locator("#lx-more").click();
  await f.page.locator('#lx-more-menu [data-target="topic-panes-open"]').click();
  await f.page.locator("#topic-panes-overlay").waitFor({ state: "visible" });
  assert.equal(await f.page.locator("#topic-panes-overlay .topic-panes-empty").isVisible(), true, "starts empty, prompting to add topics");

  await f.page.locator("#topic-panes-add").click();
  await f.page.locator('.topic-pane-picker-item:has-text("cherries")').click();
  const col = f.page.locator(`.topic-pane-col[data-session-id="${cherries}"]`);
  await col.locator(".topic-pane-message").first().waitFor();
  const text = await col.innerText();
  assert.match(text, /cherries/);
  assert.doesNotMatch(text, /plums/, "the cherries column never shows the plums conversation");
  assert.deepEqual(f.errors, []);
});

/* ---------------------------------------------------------------- messages stay with the right topic */

test("two topics side by side keep their own messages even when the slower one's read finishes last", async (t) => {
  const f = await windowFixture(t);
  const cherries = seedTopic(f.app, "cherries");
  const plums = seedTopic(f.app, "plums");

  // The cherries conversation is read from the server well after the plums one, so if a column ever
  // painted into a shared place instead of its own closure, the late cherries answer would land in
  // (or wipe) the plums column once it arrives.
  await f.page.route(`**/api/sessions/${cherries}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });

  await f.page.evaluate(async (ids) => {
    const { openTopicPanesWith } = await import("/topic-panes.js");
    openTopicPanesWith(ids);
  }, [cherries, plums]);
  await f.page.locator("#topic-panes-overlay").waitFor({ state: "visible" });

  const plumsCol = f.page.locator(`.topic-pane-col[data-session-id="${plums}"]`);
  await plumsCol.locator(".topic-pane-message").first().waitFor();
  const plumsTextEarly = await plumsCol.innerText();
  assert.match(plumsTextEarly, /plums/);
  assert.doesNotMatch(plumsTextEarly, /cherries/, "the faster column is not overwritten while the other is still loading");

  const cherriesCol = f.page.locator(`.topic-pane-col[data-session-id="${cherries}"]`);
  await cherriesCol.locator(".topic-pane-message").first().waitFor({ timeout: 5000 });
  const [cherriesText, plumsText] = await Promise.all([cherriesCol.innerText(), plumsCol.innerText()]);
  assert.match(cherriesText, /cherries/);
  assert.doesNotMatch(cherriesText, /plums/);
  assert.match(plumsText, /plums/);
  assert.doesNotMatch(plumsText, /cherries/);
  for (const row of await f.page.locator(`.topic-pane-col[data-session-id="${cherries}"] .topic-pane-message`).all())
    assert.equal(await row.getAttribute("data-session-id"), cherries);
  for (const row of await f.page.locator(`.topic-pane-col[data-session-id="${plums}"] .topic-pane-message`).all())
    assert.equal(await row.getAttribute("data-session-id"), plums);

  // Arranging them: moving the first column right swaps the on-screen order, not the messages inside them.
  const order = () => f.page.locator(".topic-pane-col").evaluateAll((cols) => cols.map((c) => c.dataset.sessionId));
  assert.deepEqual(await order(), [cherries, plums]);
  await f.page.locator(`.topic-pane-col[data-session-id="${cherries}"] .topic-pane-arrow:last-child`).click();
  assert.deepEqual(await order(), [plums, cherries]);
  assert.match(await cherriesCol.innerText(), /cherries/);
  assert.doesNotMatch(await cherriesCol.innerText(), /plums/);

  // Removing one topic leaves the other's messages untouched.
  await f.page.locator(`.topic-pane-col[data-session-id="${plums}"] .topic-pane-close`).click();
  await f.page.locator(`.topic-pane-col[data-session-id="${plums}"]`).waitFor({ state: "detached" });
  assert.equal(await f.page.locator(".topic-pane-col").count(), 1);
  assert.match(await cherriesCol.innerText(), /cherries/);
  assert.deepEqual(f.errors, []);
});

/* ---------------------------------------------------------------- Escape closes only the sheet */

test("with the floating side pane open, one Escape closes only the compare sheet and the keyboard goes back to where it was", async (t) => {
  const f = await windowFixture(t, { width: 1000, height: 900 }); // narrow enough that the side pane floats
  const cherries = seedTopic(f.app, "cherries");
  await f.page.locator("#aside-toggle").click();
  await f.page.locator("body.lx-pane-float").waitFor({ state: "attached" });

  await f.page.locator("#prompt").focus();
  await f.page.evaluate(async (ids) => {
    const { openTopicPanesWith } = await import("/topic-panes.js");
    openTopicPanesWith(ids);
  }, [cherries]);
  await f.page.locator("#topic-panes-overlay").waitFor({ state: "visible" });
  assert.equal(await f.page.evaluate(() => document.activeElement?.id), "topic-panes-add", "the keyboard is inside the sheet");

  await f.page.keyboard.press("Escape");
  assert.equal(await f.page.locator("#topic-panes-overlay").isVisible(), false, "the sheet closes");
  assert.equal(await f.page.evaluate(() => document.body.classList.contains("lx-pane-float")), true, "the side pane behind it stays open");
  assert.equal(await f.page.evaluate(() => document.activeElement?.id), "prompt", "the keyboard goes back to what had it before the sheet opened");

  // Only the sheet's Escape is held back: the next one steps out of the message box (public/shell.js),
  // and the one after that closes the side pane, as before.
  await f.page.keyboard.press("Escape");
  await f.page.keyboard.press("Escape");
  assert.equal(await f.page.evaluate(() => document.body.classList.contains("lx-pane-float")), false, "the side pane still closes on its own Escape");
  assert.deepEqual(f.errors, []);
});

/* ---------------------------------------------------------------- Escape closes only the picker */

test("with the sheet open, Escape in the picker closes only the picker and focus returns to the Add button", async (t) => {
  const f = await windowFixture(t, { width: 1000, height: 900 });
  const cherries = seedTopic(f.app, "cherries");
  seedTopic(f.app, "plums");
  await f.page.locator("#aside-toggle").click();
  await f.page.locator("body.lx-pane-float").waitFor({ state: "attached" });

  await f.page.evaluate(async (ids) => {
    const { openTopicPanesWith } = await import("/topic-panes.js");
    openTopicPanesWith(ids);
  }, [cherries]);
  await f.page.locator("#topic-panes-overlay").waitFor({ state: "visible" });
  
  // Open the picker
  await f.page.locator("#topic-panes-add").click();
  await f.page.locator(".topic-pane-picker-item:first-child").waitFor({ state: "visible" });
  
  // Focus the first picker item and press Escape
  await f.page.locator(".topic-pane-picker-item:first-child").focus();
  await f.page.keyboard.press("Escape");
  
  // Verify only the picker closed
  assert.equal(await f.page.locator(".topic-pane-picker").isVisible(), false, "the picker closes");
  assert.equal(await f.page.locator("#topic-panes-overlay").isVisible(), true, "the sheet stays open");
  assert.equal(await f.page.evaluate(() => document.body.classList.contains("lx-pane-float")), true, "the side pane stays open");
  assert.equal(await f.page.evaluate(() => document.activeElement?.id), "topic-panes-add", "focus returns to the Add button");
  assert.deepEqual(f.errors, []);
});

test("after a click on the sheet's heading, Escape closes the sheet and leaves the floating side pane open", async (t) => {
  const f = await windowFixture(t, { width: 1000, height: 900 });
  const cherries = seedTopic(f.app, "cherries");
  await f.page.locator("#aside-toggle").click();
  await f.page.locator("body.lx-pane-float").waitFor({ state: "attached" });
  await f.page.evaluate(async (ids) => {
    const { openTopicPanesWith } = await import("/topic-panes.js");
    openTopicPanesWith(ids);
  }, [cherries]);
  await f.page.locator("#topic-panes-overlay").waitFor({ state: "visible" });
  await f.page.locator("#topic-panes-heading").click();
  await f.page.keyboard.press("Escape");
  assert.equal(await f.page.locator("#topic-panes-overlay").isVisible(), false, "the sheet closes");
  assert.equal(await f.page.evaluate(() => document.body.classList.contains("lx-pane-float")), true, "the side pane stays open");
  assert.deepEqual(f.errors, []);
});
