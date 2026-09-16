import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** Every script, stylesheet and font the page refers to, including dynamic imports, must actually be served. */
test("every file the page loads is on the server's allowlist and answers 200", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-static-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await rm(root, { recursive: true, force: true }); });
  const publicDir = new URL("../public/", import.meta.url);
  const html = await readFile(new URL("index.html", publicDir), "utf8");
  const referenced = new Set([...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]));
  for (const file of await readdir(publicDir)) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(new URL(file, publicDir), "utf8");
    for (const m of source.matchAll(/import\(\s*["']\.\/([a-z0-9-]+\.js)["']\s*\)/g)) referenced.add("/" + m[1]);
    for (const m of source.matchAll(/^import\s+[^"']*["']\.\/([a-z0-9-]+\.js)["']/gm)) referenced.add("/" + m[1]);
    /* Wave 6 modules import each other by the path the browser asks for, e.g. "/markdown.js". */
    for (const m of source.matchAll(/^import\s+[^"']*["'](\/[a-z0-9-]+\.js)["']/gm)) referenced.add(m[1]);
    for (const m of source.matchAll(/import\(\s*["'](\/[a-z0-9-]+\.js)["']\s*\)/g)) referenced.add(m[1]);
    /* Anything the page fetches for itself: the language files, and the worker it registers. */
    for (const m of source.matchAll(/["'`](\/(?:locales\/[a-z-]+\.json|service-worker\.js))["'`]/g)) referenced.add(m[1]);
    for (const m of source.matchAll(/fetch\(`(\/locales\/)\$\{\w+\}(\.json)`/g)) for (const id of ["en", "fr"]) referenced.add(m[1] + id + m[2]);
  }
  /* The worker names the files it keeps; every one of them has to be served too. */
  const worker = await readFile(new URL("service-worker.js", publicDir), "utf8");
  const shell = /const SHELL = \[([\s\S]*?)\];/.exec(worker);
  assert.ok(shell, "the worker lists the files it keeps");
  for (const m of shell[1].matchAll(/"([^"]+)"/g)) referenced.add(m[1]);
  assert.ok(referenced.has("/app.js") && referenced.has("/usage.js"), "the scan found the page's scripts");
  for (const path of ["/markdown.js", "/i18n.js", "/locales/en.json", "/locales/fr.json", "/service-worker.js", "/manifest.webmanifest"])
    assert.ok(referenced.has(path), `the scan found ${path}`);
  /* Wave 8: the small box is included by a page of the owner's OWN, so nothing here imports it and
     the scan above cannot see it. It still has to be served, so it is named outright. */
  referenced.add("/widget.js");
  const missing = [];
  for (const path of referenced) {
    if (path.startsWith("/api/") || path.startsWith("//")) continue;
    const response = await fetch(server.url + path, { headers: { origin: server.url } });
    if (response.status !== 200) missing.push(`${path} → ${response.status}`);
  }
  assert.deepEqual(missing, [], "these referenced files are not served");
});
