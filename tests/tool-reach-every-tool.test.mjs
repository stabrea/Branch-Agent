/**
 * Q90: every registered tool must have a permission classified in src/tool-reach.ts
 * A new tool family cannot slip through silently with an unknown permission.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { permissionClassified } from "../dist/tool-reach.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";
import { registerHttpTools } from "../dist/skill-http-tools.js";
import { HttpToolSchema } from "../dist/skill-package.js";

/**
 * A real Branch with every switched part on (reuse fullBranch setup)
 */
async function fullBranch(t, provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } }) {
  const root = await mkdtemp(join(tmpdir(), "branch-reach-every-tool-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const launch = join(root, "integrations.json");
  await writeFile(launch, JSON.stringify({
    browser: { allowedOrigins: ["https://example.com"], maxRuns: 1 },
    shell: { executables: { node: { path: process.execPath } } },
    git: { remote: true, github: {}, gitlab: {} },
    issues: { github: true, gitlab: true },
  }));
  const integrations = await loadIntegrations(app.registry, launch, process.env, app.secretsFor, app.channelHost);
  t.after(async () => { await integrations.close(); await app.close(); await discardTemp(root); });
  for (const part of Object.values(app)) {
    if (!part || typeof part.setMode !== "function") continue;
    const names = typeof part.modes === "function" ? Object.keys(part.modes())
      : typeof part.modesOf === "function" ? Object.keys(part.modesOf()) : [null];
    const on = (input) => (name) => name === null ? part.setMode(input) : part.setMode(name, input);
    for (const name of names) { try { on({ mode: "on" })(name); } catch { on("on")(name); } }
  }
  app.addOns.save({ modes: { search: "on" } });
  registerHttpTools(app.registry, { store: app.store, policy: app.web.policy }, "weather",
    [HttpToolSchema.parse({ name: "forecast", description: "The forecast for tomorrow.", url: "https://api.example.com/forecast" })]);
  app.store.save("settings", app.runtime.owner, "openapi-service:weather", { name: "weather", allowlist: ["forecast"], from: "weather.json",
    document: JSON.stringify({ openapi: "3.0.0", info: { title: "Weather", version: "1" }, servers: [{ url: "https://api.example.com" }],
      paths: { "/forecast": { get: { operationId: "forecast", summary: "The forecast for tomorrow." } } } }) });
  // Saving the description is not enough: restore() is what registers the service's api.call tools.
  assert.deepEqual(app.openApiTools.restore(app.runtime.owner), ["weather"]);
  app.interop.clients.open({ send() {}, close() {} })
    .receive(JSON.stringify({ type: "hello", client: "lender", tools: [{ name: "look_up", description: "Looks something up." }] }));
  return app;
}

test("every tool in the registry has a permission classified in src/tool-reach.ts", async (t) => {
  const app = await fullBranch(t);
  const tools = app.registry.inventory();
  assert.ok(tools.length >= 300, `the whole registry is loaded (${tools.length} tools)`);
  
  // Collect unclassified permissions from tools
  const unclassifiedTools = [];
  const seenPermissions = new Set();
  
  for (const tool of tools) {
    if (!seenPermissions.has(tool.permission)) {
      seenPermissions.add(tool.permission);
      // Check if the permission is classified
      if (!permissionClassified(tool.permission)) {
        unclassifiedTools.push({ name: tool.name, permission: tool.permission });
      }
    }
  }
  
  // Report on any unclassified tools
  if (unclassifiedTools.length > 0) {
    console.log(`Found ${unclassifiedTools.length} unclassified permission(s):`);
    for (const tool of unclassifiedTools) {
      console.log(`  - ${tool.name}: ${tool.permission}`);
    }
  }
  
  assert.deepEqual(unclassifiedTools, [], "every tool's permission must be classified in src/tool-reach.ts");
});

test("adding a tool with an unclassified permission makes the test fail", async (t) => {
  const app = await fullBranch(t);
  
  // Add a fake tool with a brand new, unclassified permission
  app.registry.register({
    name: "test.fake.unclassified",
    permission: "test.unclassified.permission",
    description: "A test tool with an unclassified permission.",
    parameters: z.object({}).passthrough(),
    execute: async () => ({})
  });
  
  const tools = app.registry.inventory();
  const hasFakeTool = tools.some((t) => t.name === "test.fake.unclassified");
  assert.ok(hasFakeTool, "fake tool was registered");
  
  // This should detect the unclassified permission
  const unclassifiedTools = [];
  const seenPermissions = new Set();
  
  for (const tool of tools) {
    if (!seenPermissions.has(tool.permission)) {
      seenPermissions.add(tool.permission);
      if (!permissionClassified(tool.permission)) {
        unclassifiedTools.push(tool.permission);
      }
    }
  }
  
  assert.ok(unclassifiedTools.includes("test.unclassified.permission"), "fake tool's permission must be unclassified");
  assert.ok(unclassifiedTools.length > 0, "test must detect unclassified permissions");
});
