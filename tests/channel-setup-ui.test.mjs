/**
 * mac7/connect: the Set up panel as a person sees it, in a headless browser: its home in Customize,
 * Chat apps, the square codes, off by default, a refused paste, French, and 400 px wide. Nothing here
 * reaches a chat service: the only paste tried is refused before anything is asked.
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

async function signedIn(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-connect-ui-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  return { page, errors };
}

const tooWide = (page, selector) => page.evaluate((selector) => [...document.querySelectorAll(`${selector} *`)]
  .filter((node) => node.getClientRects().length && (node.getBoundingClientRect().right > document.documentElement.clientWidth + 1 || node.scrollWidth > node.clientWidth + 1))
  .map((node) => `${node.tagName} ${node.textContent.slice(0, 30)}`), selector);

test("the Set up card sits in Customize → Chat apps, ships off, and shows the command and the codes", async (t) => {
  const { page, errors } = await signedIn(t);
  await openPlace(page, "customize:channels");
  const card = page.locator("#channel-setup-card");
  await card.locator("#channel-setup-panel-card").waitFor();
  assert.equal(await card.getAttribute("data-home"), "customize:channels");
  assert.equal(await card.locator("h2").count(), 1);
  assert.equal(await card.locator("button:not(.quiet-button)").count(), 1, "one filled button");
  assert.equal(await page.locator("#channel-setup-mode").inputValue(), "off");
  assert.equal(await page.locator("#channel-setup-app").inputValue(), "telegram");
  assert.equal(await page.locator("#channel-setup-app option").count(), 55);
  assert.match(await card.textContent(), /branch connect telegram[\s\S]*brew install --cask telegram[\s\S]*Get the app on iPhone[\s\S]*Make the bot[\s\S]*\/newbot/);
  assert.equal(await card.locator(".channel-setup-codes canvas").count(), 3);
  assert.equal(await page.locator("#channel-setup-open-card").getAttribute("href"), "https://t.me/BotFather?text=%2Fnewbot");
  assert.equal(await page.locator("#channel-setup-save-card").isDisabled(), true, "saving is off until switched on");
  assert.equal(await page.locator("#channel-setup-card-TELEGRAM_BOT_TOKEN").getAttribute("type"), "password");

  await page.locator("#channel-setup-app").selectOption("slack");
  await page.locator("#channel-setup-panel-card[data-app=slack]").waitFor();
  assert.match(await page.locator("#channel-setup-open-card").getAttribute("href"), /^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/);
  assert.equal(await card.locator(".channel-setup-codes canvas").count(), 3, "Slack's plain page still gets a code");

  await page.locator("#channel-setup-app").selectOption("mastodon");
  await page.locator("#channel-setup-panel-card[data-app=mastodon]").waitFor();
  assert.equal(await page.locator("#channel-setup-open-card").isHidden(), true, "no page until the server is typed");
  await page.locator("#channel-setup-card-server").fill("https://social.example");
  assert.equal(await page.locator("#channel-setup-open-card").getAttribute("href"), "https://social.example/settings/applications/new");
  await page.locator("#channel-setup-card-server").fill("javascript:alert(1)");
  assert.equal(await page.locator("#channel-setup-open-card").isHidden(), true);

  await page.locator("#channel-setup-mode").selectOption("when-needed");
  await page.locator("#channel-setup-mode-save").click();
  await page.waitForFunction(() => document.getElementById("channel-setup-save-card")?.disabled === false);
  await page.locator("#channel-setup-app").selectOption("telegram");
  await page.locator("#channel-setup-panel-card[data-app=telegram]").waitFor();
  await page.locator("#channel-setup-card-TELEGRAM_BOT_TOKEN").fill("not-a-token");
  await page.locator("#channel-setup-save-card").click();
  await card.locator("[role=status]", { hasText: "does not look right" }).waitFor();
  assert.ok(!(await card.textContent()).includes("not-a-token"), "a refused paste is not shown back");
  assert.deepEqual(errors, []);
});

test("each More chat apps row and the Telegram card open the same panel, and it reads in French at 400 px", async (t) => {
  const { page, errors } = await signedIn(t);
  await openPlace(page, "customize:channels");
  const row = page.locator("#channels-more-list details").filter({ hasText: "Mastodon" }).first();
  await row.locator(".channel-setup-row").waitFor({ state: "attached" });
  await row.locator("summary").click();
  await row.getByRole("button", { name: "Set up" }).click();
  await page.locator("#channel-setup-panel-card[data-app=mastodon]").waitFor();
  assert.equal(await page.locator("#channel-setup-app").inputValue(), "mastodon");

  const telegram = page.locator("#telegram-setup-card");
  await telegram.locator("#channel-setup-panel-telegram").waitFor({ state: "attached" });
  assert.equal(await telegram.locator("button:not(.quiet-button)").count(), 1, "the Telegram card keeps one filled button");
  assert.equal(await page.locator("#telegram-setup-card").count(), 1, "no second Telegram card");

  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.getElementById("channel-setup-card")?.textContent.includes("Configurer une appli de messagerie"));
  await page.locator("#channel-setup-panel-card").waitFor();
  assert.match(await page.locator("#channel-setup-card").textContent(), /Collez ceci dans un terminal[\s\S]*Ouvrir la page qui crée le bot/);
  assert.match(await page.locator("#channel-setup-card").textContent(), /Votre serveur ouvre/, "the recipe's own sentence in French");

  await page.setViewportSize({ width: 400, height: 800 });
  await openPlace(page, "customize:channels");
  await page.locator("#channel-setup-card").scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  assert.deepEqual(await tooWide(page, "#channel-setup-card"), []);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  await page.locator("#channel-setup-app").selectOption("slack");
  await page.locator("#channel-setup-panel-card[data-app=slack]").waitFor();
  assert.deepEqual(await tooWide(page, "#channel-setup-card"), [], "Slack's long lines wrap");
  assert.deepEqual(errors, []);
});

/* ---------- the phone app's own panel (apps/mobile/web), with a stand-in for the phone ---------- */

test("the phone shows the same panel as links: the store for this phone and the bot page, at 400 px", async (t) => {
  const { createServer } = await import("node:http");
  const { readFile } = await import("node:fs/promises");
  const { extname } = await import("node:path");
  const { setupList, setupPanel } = await import("../dist/channel-setup/service.js");
  const store = { get: () => ({ data: { mode: "when-needed" } }) };
  const answers = { list: setupList(store, "local"), telegram: setupPanel(store, "local", "telegram"), bluesky: setupPanel(store, "local", "bluesky") };
  const WEB = join(import.meta.dirname, "..", "apps", "mobile", "web"), PUBLIC = join(import.meta.dirname, "..", "public");
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2" };
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    for (const file of [join(WEB, path), join(PUBLIC, path)]) {
      let body;
      try { body = await readFile(file); } catch { continue; }
      return void response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(body);
    }
    response.writeHead(404).end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await new Promise((done) => server.close(done)); });
  const page = await browser.newPage({ viewport: { width: 400, height: 800 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((answers) => {
    globalThis.posted = [];
    globalThis.branchPhoneFake = {
      async session() { return { paired: true, origin: "http://100.64.0.9:3210" }; },
      async request({ method, path, body }) {
        if (path === "/api/channel-setup") return { status: 200, data: answers.list };
        const panel = /^\/api\/channel-setup\/([a-z-]+)$/.exec(path);
        if (panel) return { status: 200, data: answers[panel[1]] };
        if (method === "POST") { globalThis.posted.push({ path, body }); return { status: 422, data: { error: "Telegram did not accept that (it answered 401)." } }; }
        return { status: 200, data: { attention: [] } };
      },
      async getSwitches() { return { switches: {} }; }, async setSwitches() {}, async switchesChanged() {},
      async look() { return { theme: "forest", mode: "dark" }; }, async lastSeen() { return { at: Date.now() }; },
      async takeShared() { return { items: [] }; }, async openBranch() {}, async notify() {}, async unlock() { return { unlocked: true }; },
    };
  }, answers);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const card = page.locator("#connect-card");
  await card.waitFor({ state: "visible" });
  await page.locator("#connect-body a").first().waitFor();
  assert.equal(await page.locator("#connect-app option").count(), 55);
  assert.equal(await card.getByRole("link", { name: "Get the app" }).getAttribute("href"), "https://apps.apple.com/app/id686449807", "the iPhone store on an iPhone");
  assert.equal(await card.getByRole("link", { name: "Make the bot" }).getAttribute("href"), "https://t.me/BotFather?text=%2Fnewbot");
  assert.equal(await page.locator("#connect-TELEGRAM_BOT_TOKEN").getAttribute("type"), "password");
  await page.locator("#connect-TELEGRAM_BOT_TOKEN").fill(`123456789:${"Q".repeat(35)}`);
  await page.locator("#connect-save").click();
  await page.locator("#connect-status", { hasText: "did not accept" }).waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.posted.map((post) => post.path)), ["/api/channel-setup/telegram/check"]);
  assert.equal(await page.locator("#connect-TELEGRAM_BOT_TOKEN").inputValue().then((value) => value.length), 45, "a refused token stays to be corrected");
  await page.locator("#connect-app").selectOption("bluesky");
  await page.locator("#connect-handle").waitFor();
  assert.equal(await card.getByRole("link", { name: "Make the bot" }).getAttribute("href"), "https://bsky.app/settings/app-passwords");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  assert.deepEqual(errors, []);
});
