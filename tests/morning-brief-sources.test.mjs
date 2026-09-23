/**
 * FQ-packages.morning-brief (partial): the brief's "In the news" section reads the owner's own
 * RSS/Atom feeds through the app's checked fetch path (never a fresh HTTP client), and its "Health"
 * section shows a source-backed line when a health source is wired in, or says plainly that nothing
 * is connected when it isn't. Every item keeps its source link; anything other than http/https is
 * dropped rather than shown.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { MorningBrief } from "../dist/brief.js";
import { parseFeedItems, isSafeLink, fetchNewsItems, noHealthConnected } from "../dist/brief-sources.js";

/** A stand-in for the app's network rules: everything is allowed, so the test needs no real policy. */
function openPolicy() { return { assertAllowed: async () => undefined }; }
function fetchDeps() { return { policy: openPolicy(), fetch: globalThis.fetch, timeoutMs: 5000, maxBytes: 1_000_000, userAgent: "BranchAgentTest" }; }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-brief-sources-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

/** A local fixture feed server on an OS-assigned port, closed automatically after the test. */
async function feedServer(t, xmlForUrl) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(xmlForUrl(`http://127.0.0.1:${server.address().port}`));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("morning brief: RSS feed items appear with their source link, a javascript: link is dropped, and health reports honestly", async (t) => {
  const app = await fixture(t);
  const feedUrl = await feedServer(t, (base) => `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>Storm warning lifted</title><link>${base}/weather</link></item>
    <item><title>Sketchy item</title><link>javascript:alert(1)</link></item>
  </channel></rss>`);
  const feedXml = (await (await fetch(feedUrl)).text());

  // Unit-level check: the parser keeps the safe item and drops the javascript: one.
  const items = parseFeedItems(feedXml, "example-feed");
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Storm warning lifted");
  assert.match(items[0].link, /\/weather$/);
  assert.equal(isSafeLink("javascript:alert(1)"), false);
  assert.equal(isSafeLink("https://example.com/x"), true);

  // fetchNewsItems reads the feed through a policy-checked fetch, the same shape web.page uses.
  const fetched = await fetchNewsItems(fetchDeps(), [{ url: feedUrl, name: "example-feed" }], AbortSignal.timeout(5000));
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].source, "example-feed");
  assert.equal(isSafeLink(fetched[0].link), true);

  // End to end: the brief itself lists the item with its link, once refreshed.
  const brief = new MorningBrief(app.store, undefined, app.documents, undefined, fetchDeps());
  brief.configure("local", { newsFeeds: [feedUrl] });
  await brief.refreshSources("local");
  const preview = brief.preview("local");
  assert.match(preview.markdown, /Storm warning lifted/);
  assert.match(preview.markdown, /\/weather/);
  assert.doesNotMatch(preview.markdown, /alert\(1\)/, "a javascript: link never reaches the brief");

  // Health: with nothing connected, the brief says so plainly rather than inventing data.
  const noHealthBrief = new MorningBrief(app.store);
  const noHealthPreview = noHealthBrief.preview("local");
  assert.match(noHealthPreview.markdown, new RegExp(noHealthConnected.replace(/[.]/g, "\\.")));

  // Health: with a test double connected, its source-backed line shows up instead.
  const double = { async read() { return [{ title: "7,200 steps", link: "https://health.example/steps", source: "Test Health" }]; } };
  const healthBrief = new MorningBrief(app.store, undefined, app.documents, undefined, undefined, double);
  await healthBrief.refreshSources("local");
  const healthPreview = healthBrief.preview("local");
  assert.match(healthPreview.markdown, /7,200 steps/);
  assert.match(healthPreview.markdown, /https:\/\/health\.example\/steps/);
  assert.match(healthPreview.markdown, /Test Health/);
});

test("morning brief: the running app itself, not just the library, reads news feeds through brief.configure/brief.preview", async (t) => {
  // This is the end-to-end check that the brief the owner actually gets (via createBranch, wired
  // in index.ts) has a real newsFetch, not only the MorningBrief class tested in isolation above.
  // allowPrivateAddresses lets the app's own network policy reach the local fixture feed server.
  const root = await mkdtemp(join(tmpdir(), "branch-brief-sources-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, web: { allowPrivateAddresses: true } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const feedUrl = await feedServer(t, (base) => `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>City council approves new park</title><link>${base}/park</link></item>
  </channel></rss>`);
  const own = await app.runtime.run({ prompt: "set up my brief" });
  const context = app.runtime.context({ runId: own.id });

  await app.registry.execute("brief.configure", { newsFeeds: [feedUrl] }, context);
  const preview = await app.registry.execute("brief.preview", {}, context);

  assert.match(preview.markdown, /City council approves new park/);
  assert.match(preview.markdown, new RegExp(`${feedUrl.replace(/[.]/g, "\\.")}\\/park`));
  assert.match(preview.markdown, /No health data source is connected\./, "health is honest with nothing wired up");
});
