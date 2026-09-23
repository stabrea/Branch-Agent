/**
 * DG-198: Settings › Automations & inbox has the approved sample's sections, in its order, with its "N more with …"
 * counts, with Show everything off and on, at 1440, 860 and 400 px, in English and French. The settings that lived on
 * the Automations and Inbox places now live here, each in its section, and every one of them is still on the page.
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

const HEADS = ["Keep it running by itself", "Limits and the waiting line", "A public address for webhooks", "Watch a task again"];
/* The sample says 10, 11 and 2 more. Its other two are the HEARTBEAT.md and SOP.md switches, which it draws as
   "Set in Instructions & personality" links and so has no row level for (left for the coordinator). DG-199 counts a
   row the card has not drawn yet (the tunnel's program and path, the board's limit wait for their switch). */
const REGULAR = ["Keep it running by itself", "9 more with Advanced", "Limits and the waiting line", "10 more with Advanced",
  "A public address for webhooks", "2 more with Advanced", "Watch a task again"];
/* At Advanced the sample keeps one Technical row back in each of the first three: the timezone, tokens, the path. */
const ADVANCED = ["Keep it running by itself", "1 more with Technical", "Limits and the waiting line", "1 more with Technical",
  "A public address for webhooks", "1 more with Technical", "Watch a task again"];
const FRENCH = ["Le laisser tourner tout seul", "Les limites et la file d'attente", "Une adresse publique pour les webhooks", "Revoir une tâche"];
const SECTIONS = {
  "automations:running": ["quiet-checkin", "autonomy-suggestions-card", "autonomy-orders-card", "context-heartbeat", "autonomy-loops-card",
    "autonomy-queue-card"],
  "automations:limits": ["quiet-health", "flows-board-card", "flows-waiting-card", "autonomy-limits-card", "flows-travel-card",
    "flows-recipes-card", "prompts-card", "context-sop", "autonomy-procedures-card"],
  "automations:webhooks": ["personal-tunnel-card", "flows-installs-card"],
  "automations:watch": ["recordings-card"],
};

/** The section headings and "N more" lines on show, in page order. */
const shownLines = () => [...document.querySelectorAll("#lx-page-automations :is(.sg-head-title, .sg-more)")]
  .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
  .map((node) => node.textContent.trim());

test("Automations & inbox: the sample's sections and counts, at every width, both levels and in French", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-automations-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", body: JSON.stringify({ done: true }),
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } });

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  const cog = page.locator(".sg-foot-line > .sg-gear:visible");
  if (!(await cog.count())) await page.locator("#rail-toggle").click();
  await cog.click();
  await page.locator('.lx-settings-link[data-page="automations"]').click();
  const settle = async (want) => {
    await page.waitForFunction((list) => JSON.stringify([...document.querySelectorAll("#lx-page-automations :is(.sg-head-title, .sg-more)")]
      .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
      .map((node) => node.textContent.trim())) === JSON.stringify(list), want, { timeout: 20000 }).catch(() => undefined);
    return page.evaluate(shownLines);
  };
  const level = (to) => page.evaluate((name) => globalThis.branchSettingsLevel.set(name), to);

  /* Every card that lived on the Automations and Inbox places is here, in its section, and nowhere else. */
  await page.locator("#recordings-card").waitFor({ state: "attached", timeout: 20000 });
  await page.locator("#prompts-card").waitFor({ state: "attached", timeout: 20000 });
  for (const [bucket, ids] of Object.entries(SECTIONS)) for (const id of ids) {
    await page.locator(`#${id}`).waitFor({ state: "attached", timeout: 20000 });
    assert.equal(await page.locator(`#${id}`).evaluate((node) => `${node.parentElement.id} ${node.dataset.sgBucket}`),
      `lx-page-automations ${bucket}`, `${id} is in its section`);
  }
  assert.equal(await page.locator("#lx-page-automations .lx-page-title").evaluate((node) => node.tagName), "H2");
  assert.deepEqual(await page.locator("#lx-page-automations .settings-card-title").evaluateAll((nodes) => [...new Set(nodes.map((n) => n.tagName))]),
    ["H3"], "a card is titled below the page title (DG-008)");
  assert.equal(await page.locator("#lx-page-automations .sg-head-title:visible", { hasText: "More on this page" }).count(), 0);
  /* DG-008: the page's one h2 is its title; sections and cards are titled below it, and nothing sits below them. */
  assert.deepEqual(await page.locator("#lx-page-automations").evaluate((host) => [...host.querySelectorAll("h1, h2, h4, h5, h6")]
    .map((node) => `${node.tagName}.${node.className}`)), ["H2.lx-page-title"]);

  for (const colorScheme of ["light", "dark"]) for (const width of [1440, 860, 400]) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width, height: 1000 });
    await level("regular");
    assert.deepEqual(await settle(REGULAR), REGULAR, `Regular at ${width} px, ${colorScheme}`);
    await level("advanced");
    assert.deepEqual(await settle(ADVANCED), ADVANCED, `Advanced at ${width} px, ${colorScheme}`);
    await level("technical");
    assert.deepEqual(await settle(HEADS), HEADS, `Technical at ${width} px, ${colorScheme}: nothing more to show`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `no sideways scroll at ${width} px`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await level("regular");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  const french = await page.evaluate(() => [...document.querySelectorAll("#lx-page-automations .sg-head-title")]
    .filter((node) => node.getClientRects().length).map((node) => node.textContent.trim()));
  assert.deepEqual(french, FRENCH);
  /* The links to the Automations and Inbox places have no home in the sample: they wait at Technical. */
  assert.equal(await page.locator("#lx-page-automations .settings-directory-card:visible").count(), 0);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));

  /* "Tasks at the same time" has a card of its own here, saved as it changes, with no Save button (DG-025). */
  const atOnce = async () => (await (await fetch(new URL("/api/queue", server.url), { headers: { authorization: `Bearer ${server.token}` } })).json()).settings.atOnce;
  await level("advanced");
  const queue = page.locator("#autonomy-queue-card"), said = queue.locator("[role=status]");
  assert.equal(await queue.locator("button:not(.sg-more)").count(), 0, "nothing to press: it saves as it changes");
  await page.locator("#queue-at-once").fill("5");
  await page.locator("#queue-at-once").press("Tab");
  await said.filter({ hasText: "Saved" }).waitFor();
  assert.equal(await atOnce(), 5);
  /* A number the waiting line refuses is said in the card, and what was saved stays. */
  await page.locator("#queue-at-once").fill("9");
  await page.locator("#queue-at-once").press("Tab");
  await page.waitForFunction(() => { const text = document.querySelector("#autonomy-queue-card [role=status]")?.textContent ?? ""; return text && !/Saved/.test(text); });
  assert.equal(await atOnce(), 5);
  assert.equal(await page.locator("#collab-container input[type=number][max='8']").count(), 0, "one control for one setting");
  assert.deepEqual(errors, []);
});
