import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";

/* bucket-18 (A2128): research reads a page built by script with the browser, only when one is set up. */
async function fixture(t, search) {
  const root = await mkdtemp(join(tmpdir(), "branch-research-browser-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    web: { allowPrivateAddresses: true, searchEndpoint: `${search}/search` } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, workspace: join(root, "workspace") };
}

async function site(t) {
  const server = createServer((request, response) => {
    const port = server.address().port;
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    response.writeHead(200, { "content-type": "text/html" });
    if (path === "/search") {
      response.end(`<a href="http://127.0.0.1:${port}/app" class="result-link">App</a><td class="result-snippet">tower</td>` +
        `<a href="http://127.0.0.1:${port}/plain" class="result-link">Plain</a><td class="result-snippet">tower</td>`);
    } else if (path === "/app") {
      response.end(`<html><head><title>App</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`);
    } else {
      response.end(`<html><head><title>Plain</title></head><body><p>The Eiffel Tower stands 324 metres tall including its antennas, as measured in 2022 by the survey team that climbed it.</p><p>It was completed in 1889 for the Paris World Fair and has been repainted many times since then.</p></body></html>`);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("A2128 a page built by script is read with the browser, and an ordinary page is not", async (t) => {
  const base = await site(t);
  const { app, workspace } = await fixture(t, base);
  const visited = [];
  app.registry.register({ name: "browser.navigate", permission: "browser.read", description: "stand-in",
    parameters: z.object({ url: z.string() }).strict(), execute: async (args) => { visited.push(args.url); return {}; } });
  app.registry.register({ name: "browser.snapshot", permission: "browser.read", description: "stand-in",
    parameters: z.object({}).strict(), execute: async () => ({ url: visited.at(-1),
      accessibility: "- paragraph: The Eiffel Tower stands 330 metres tall including its antennas, according to the rendered application page that loads by script." }) });

  const run = app.store.createRun("local", "How tall is the Eiffel Tower?");
  const context = app.runtime.context({ runId: run.id });
  const report = await app.registry.execute("research.run", { question: "How tall is the Eiffel Tower?", depth: "quick" }, context);
  assert.equal(report.status, "finished");
  assert.deepEqual(visited, [`${base}/app`], "only the empty page went to the browser");
  const written = await readFile(join(workspace, report.path), "utf8");
  assert.match(written, /330 metres/, "what the browser saw is in the report");
  assert.match(written, /324 metres/);
  assert.ok(app.store.events(run.id).some((event) => event.kind === "research.browser" && event.data.url === `${base}/app`));

  // A task that may not use the browser gets the plain reading only.
  visited.length = 0;
  const limited = app.runtime.context({ runId: app.store.createRun("local", "again").id,
    permissions: app.registry.permissions().filter((name) => name !== "browser.read") });
  await app.registry.execute("research.run", { question: "How tall is the Eiffel Tower really?", depth: "quick" }, limited);
  assert.deepEqual(visited, []);
});
