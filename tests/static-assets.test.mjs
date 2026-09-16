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
  }
  assert.ok(referenced.has("/app.js") && referenced.has("/usage.js"), "the scan found the page's scripts");
  const missing = [];
  for (const path of referenced) {
    if (path.startsWith("/api/") || path.startsWith("//")) continue;
    const response = await fetch(server.url + path, { headers: { origin: server.url } });
    if (response.status !== 200) missing.push(`${path} → ${response.status}`);
  }
  assert.deepEqual(missing, [], "these referenced files are not served");
});
