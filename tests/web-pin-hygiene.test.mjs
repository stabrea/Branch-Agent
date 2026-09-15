import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, WebAccess, isPrivateAddress, readable, parseSearchResults } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";

async function site(t) {
  const server = createServer((req, res) => {
    if (req.url === "/page") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end("<html><head><title>Garden &amp; Gate</title><script>alert(1)</script></head><body><nav>menu</nav><h1>Gate notes</h1><p>The gate sticks in <b>winter</b>.</p><p>Oil it &lt;twice&gt; a year.</p><footer>foot</footer></body></html>"); }
    if (req.url === "/hop") { res.writeHead(302, { location: "/page" }); return res.end(); }
    if (req.url === "/loop") { res.writeHead(302, { location: "/loop" }); return res.end(); }
    if (req.url === "/binary") { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end("xx"); }
    if (req.url === "/lite/" && req.method === "POST") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<table><tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fgates&amp;rut=1" class='result-link'>Garden <b>gates</b></a></td></tr>
        <tr><td class='result-snippet'>All about <b>gates</b> &amp; hinges.</td></tr>
        <tr><td><a rel="nofollow" href="https://duckduckgo.com/y.js?ad=1" class='result-link'>Sponsored</a></td></tr><tr><td class='result-snippet'>ad</td></tr>
        <tr><td><a rel="nofollow" href="https://example.com/oil" class='result-link'>Oiling hinges</a></td></tr><tr><td class='result-snippet'>Twice a year.</td></tr></table>`);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-web-"));
  const provider = { name: "scripted", requests: [], async complete(request) { provider.requests.push(request); return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, root, provider };
}

test("web.fetch returns readable text with the final address, follows bounded redirects and refuses non-text", async (t) => {
  const base = await site(t);
  const web = new WebAccess({ allowPrivateAddresses: true });
  const page = await web.fetchPage(`${base}/hop`);
  assert.equal(page.url, `${base}/page`);
  assert.equal(page.title, "Garden & Gate");
  assert.equal(page.hops, 1);
  assert.match(page.text, /Gate notes\nThe gate sticks in winter\.\nOil it <twice> a year\./);
  assert.ok(!page.text.includes("alert(1)") && !page.text.includes("menu") && !page.text.includes("foot"));
  await assert.rejects(web.fetchPage(`${base}/loop`), /Too many redirects/);
  await assert.rejects(web.fetchPage(`${base}/binary`), /Unsupported content type/);
  await assert.rejects(web.fetchPage(`${base}/missing`), /HTTP 404/);
  const short = await web.fetchPage(`${base}/page`, 500);
  assert.equal(short.truncated, false);
});

test("web.search parses result links and snippets and drops the search engine's own links", async (t) => {
  const base = await site(t);
  const web = new WebAccess({ allowPrivateAddresses: true, searchEndpoint: `${base}/lite/` });
  const results = await web.search("garden gates", 5);
  assert.deepEqual(results, [
    { title: "Garden gates", url: "https://example.org/gates", snippet: "All about gates & hinges." },
    { title: "Oiling hinges", url: "https://example.com/oil", snippet: "Twice a year." },
  ]);
  assert.equal(parseSearchResults("<p>nothing</p>").length, 0);
  assert.equal(readable("<html><body><p>a</p><p>b</p></body></html>").text, "a\nb");
});

test("the network guard refuses loopback, private, link-local and blocked hosts before any request, and honours an allowlist", async (t) => {
  const base = await site(t);
  const guarded = new WebAccess({});
  for (const target of [`${base}/page`, "http://localhost/x", "http://10.0.0.1/", "http://192.168.1.1/", "http://172.16.0.9/", "http://169.254.169.254/latest", "http://[::1]/", "http://printer.local/", "ftp://example.org/"])
    await assert.rejects(guarded.fetchPage(target), /may not reach|Only http|could not be resolved|blocked/, target);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateAddress("fd00::1"), true);
  const blocked = new WebAccess({ allowPrivateAddresses: true, blockedHosts: ["127.0.0.1"] });
  await assert.rejects(blocked.fetchPage(`${base}/page`), /blocked list/);
  const allow = new WebAccess({ allowPrivateAddresses: true, allowedHosts: ["example.org"] });
  await assert.rejects(allow.fetchPage(`${base}/page`), /not on the allowed list/);
  const permitted = new WebAccess({ allowPrivateAddresses: true, allowedHosts: ["127.0.0.1"] });
  assert.equal((await permitted.fetchPage(`${base}/page`)).title, "Garden & Gate");
  await assert.rejects(guarded.fetchPage("http://user:pass@example.org/"), /credentials/);
});

test("web tools are registered by default, take settings from the integrations file, and appear in the live tool inventory", async (t) => {
  const { app, root } = await fixture(t);
  const base = await site(t);
  assert.ok(app.registry.names().includes("web.search") && app.registry.names().includes("web.fetch"));
  const configPath = join(root, "integrations.json");
  await writeFile(configPath, JSON.stringify({ web: { allowPrivateAddresses: true, searchEndpoint: `${base}/lite/` }, shell: { executables: { node: { path: process.execPath } } } }));
  const loaded = await loadIntegrations(app.registry, configPath, {}, app.secretsFor, app.channelHost);
  assert.equal(app.web.settings().allowPrivateAddresses, true);
  const context = app.runtime.context({ runId: "web-run" });
  const results = await app.registry.execute("web.search", { query: "gates", limit: 1 }, context);
  assert.equal(results[0].url, "https://example.org/gates");
  const page = await app.registry.execute("web.fetch", { url: `${base}/page` }, context);
  assert.match(page.text, /Gate notes/);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const inventory = async () => (await (await fetch(server.url + "/api/tools", { headers: { authorization: "Bearer " + server.token, origin: server.url } })).json());
  let tools = await inventory();
  assert.ok(tools.tools.some((tool) => tool.name === "shell.execute" && tool.readiness.includes("ready")));
  assert.equal(tools.tools.find((tool) => tool.name === "web.fetch").readiness, "ready (private addresses allowed)");
  await loaded.close();
  tools = await inventory();
  assert.ok(!tools.tools.some((tool) => tool.name === "shell.execute"), "closing an integration removes its tools from the inventory");
  assert.ok(!tools.permissions.includes("shell.execute"));
});

test("a skill pinned to a conversation is present in every turn until unpinned", async (t) => {
  const { app, provider, root } = await fixture(t);
  const installed = app.store.skills.install("local", { document: "---\nname: tidy-notes\ndescription: Tidy notes.\n---\n\nAlways end with a one-line summary.\n" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (path, body) => (await fetch(server.url + "/api/" + path, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + server.token, origin: server.url, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json();
  const first = await app.runtime.run({ prompt: "hello" });
  const system = (request) => request.messages[0].content;
  assert.ok(!system(provider.requests[0]).includes("Always end with a one-line summary"));
  assert.deepEqual(await call(`sessions/${first.sessionId}/skill`, { skillId: installed.id }), { skillId: installed.id });
  await app.runtime.run({ prompt: "again", sessionId: first.sessionId });
  assert.match(system(provider.requests[1]), /Pinned skill "tidy-notes" \(v1\)[\s\S]*Always end with a one-line summary/);
  assert.ok(app.store.events(app.store.runs("local")[0].id).some((e) => e.kind === "skills.pinned"));
  const other = await app.runtime.run({ prompt: "elsewhere" });
  assert.ok(!system(provider.requests[2]).includes("Pinned skill"), "other conversations are unaffected");
  assert.deepEqual(await call(`sessions/${first.sessionId}/skill`), { skillId: installed.id });
  await call(`sessions/${first.sessionId}/skill`, { skillId: null });
  await app.runtime.run({ prompt: "third", sessionId: first.sessionId });
  assert.ok(!system(provider.requests[3]).includes("Pinned skill"));
  void other;
});

test("memory hygiene previews, archives (restorable) or purges stale facts by age", async (t) => {
  const { app } = await fixture(t);
  app.store.save("memory", "local", "old-1", { text: "Old preference", source: "owner" });
  app.store.save("memory", "local", "old-2", { text: "Older preference", source: "owner" });
  const later = Date.now() + 3 * 86_400_000;
  app.store.save("memory", "local", "new-1", { text: "Fresh preference", source: "owner" });
  assert.equal(app.store.memoryHygiene("local", { olderThanDays: 1, action: "preview" }).stale.length, 0, "nothing is a day old yet");
  const preview = app.store.memoryHygiene("local", { olderThanDays: 2, action: "preview" }, later);
  assert.deepEqual(preview.stale.map((f) => f.id).sort(), ["new-1", "old-1", "old-2"], "seen from three days later, everything is stale");
  const archived = app.store.memoryHygiene("local", { olderThanDays: 2, action: "archive" }, later);
  assert.equal(archived.archived.length, 3);
  assert.equal(app.store.list("memory", "local").length, 0);
  assert.equal(app.store.archivedMemory("local").length, 3);
  const restored = app.store.restoreMemory("local", "new-1");
  assert.equal(restored.data.text, "Fresh preference");
  assert.equal(restored.revision, 2, "a restore counts as an edit");
  assert.equal(app.store.archivedMemory("local").length, 2);
  assert.throws(() => app.store.restoreMemory("local", "new-1"), /not found/);
  app.store.save("memory", "local", "old-3", { text: "Another old one", source: "owner" });
  const purged = app.store.memoryHygiene("local", { olderThanDays: 1, action: "purge" }, later);
  assert.deepEqual(purged.purged.map((f) => f.id).sort(), ["new-1", "old-3"]);
  assert.equal(app.store.list("memory", "local").length, 0);
  assert.equal(app.store.archivedMemory("local").length, 2, "purging leaves the archive alone");
});
