/**
 * FQ-packages.morning-brief (wiring): src/index.ts now builds the real `MorningBrief` with a live
 * `PageFetchDeps`, taken from the same `WebPages` instance `web.page` uses (src/web-pages.ts), so an
 * owner's saved news feeds actually reach the brief instead of being silently ignored. This file
 * drives that through the real app: the HTTP settings API, the real `brief.preview` tool, and a
 * headless look at the new "Morning brief: news feeds" card (public/heartbeat.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

/** A local fixture RSS server on an OS-assigned port, closed automatically after the test. */
async function feedServer(t) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Storm warning lifted</title><link>http://127.0.0.1:${server.address().port}/weather</link></item>
    </channel></rss>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-brief-wiring-"));
  // The fixture feed is on 127.0.0.1, so the app's own network rules have to allow a private address,
  // the same way tests/web-pages.test.mjs does for the same reason.
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet,
    web: { allowPrivateAddresses: true } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, method) => {
    const response = await fetch(`${server.url}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const tool = (name, args) => app.runtime.executeTool(name, args, { mode: "owner" });
  return { app, server, call, tool };
}

test("the real app wires a live news fetch into the brief: saved through the settings API, read by brief.preview", async (t) => {
  const { app, call, tool } = await served(t);
  const feedUrl = await feedServer(t);

  // A non-http(s) address is refused server-side by the schema, before it is ever saved.
  const refused = await call("/api/brief", { newsFeeds: ["ftp://example.com/feed.xml"] });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /http/);
  assert.deepEqual(app.brief.settings(app.runtime.owner).newsFeeds, [], "the refused address was never saved");

  // Saving a real feed through the settings API.
  const saved = await call("/api/brief", { newsFeeds: [feedUrl] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.newsFeeds, [feedUrl]);

  // GET /api/brief now also carries the settings back, which the settings card reloads from.
  const read = (await call("/api/brief")).body;
  assert.deepEqual(read.settings.newsFeeds, [feedUrl]);

  // The real brief.preview tool: this is what proves index.ts actually wired a live fetch in,
  // rather than leaving `newsFetch` unset (in which case refreshSources would never populate the
  // news cache and this item would never appear).
  const preview = await tool("brief.preview", {});
  assert.match(preview.markdown, /Storm warning lifted/, "the fetched item reached the brief");
  assert.match(preview.markdown, new RegExp(`${feedUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/weather`), "the item's own link is shown");
});

test("removing every feed clears the cached news rather than showing it forever", async (t) => {
  const { call, tool } = await served(t);
  const feedUrl = await feedServer(t);
  await call("/api/brief", { newsFeeds: [feedUrl] });
  const first = await tool("brief.preview", {});
  assert.match(first.markdown, /Storm warning lifted/);

  await call("/api/brief", { newsFeeds: [] });
  const second = await tool("brief.preview", {});
  assert.doesNotMatch(second.markdown, /Storm warning lifted/, "stale news does not linger after every feed is removed");
});

test("headless UI: the settings window lets the owner add a feed, save it, and see it again after a reload", async (t) => {
  const { server } = await served(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });

  await openPlace(page, "automations:scheduled");
  await page.locator("#brief-news-card h2").waitFor({ state: "visible" });
  assert.equal(await page.locator("#brief-news-card").getAttribute("data-home"), "automations:scheduled");

  const feedUrl = "https://feeds.example.com/tech.xml";
  await page.locator("#brief-feed-url").fill(feedUrl);
  await page.locator("#brief-news-card button[data-t='schedules.brief.add']").click();
  await page.locator(`#brief-news-card:has-text("${feedUrl}")`).waitFor({ state: "visible" });
  await page.locator("#brief-news-card button[data-t='action.save']").click();
  await page.waitForFunction(() => document.querySelector("#brief-news-card")?.dataset.editing === undefined);

  // The session token is kept in sessionStorage, so a reload of the same tab signs back in on its
  // own; the point of the reload here is only to prove the feed was actually saved, not remembered
  // in page state.
  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await openPlace(page, "automations:scheduled");
  await page.locator("#brief-news-card h2").waitFor({ state: "visible" });
  const listed = await page.locator(`#brief-news-card:has-text("${feedUrl}")`).count();
  assert.ok(listed > 0, "the saved feed is still listed after a reload");
  assert.deepEqual(errors, []);
});
