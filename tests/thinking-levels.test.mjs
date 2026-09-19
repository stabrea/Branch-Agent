/**
 * Redesign phase 2 (accounts, critique #22): the Thinking lists offer only the levels the chosen
 * model really takes. The map is checked against the providers that actually send a level, and the
 * lists are checked in a headless window with three stand-in connections (nothing reaches a service).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { thinkingLevels } from "../dist/thinking-levels.js";
import { openSettingFor } from "./places.mjs";

const all = ["low", "medium", "high"];

test("K1 only the three providers that send a level are offered one, and only for models that think", () => {
  assert.deepEqual(thinkingLevels("openai-compatible", "gpt-5.5"), { how: "effort", levels: all });
  assert.deepEqual(thinkingLevels("openai-compatible", "openai/o4-mini"), { how: "effort", levels: all }, "a router's prefix is read through");
  assert.deepEqual(thinkingLevels("openai-compatible", "gpt-4o-mini"), { how: "none", levels: [] }, "a model that does not think");
  assert.deepEqual(thinkingLevels("openai-compatible", "grok-3-mini"), { how: "effort", levels: ["low", "high"] }, "xAI takes two levels");
  assert.deepEqual(thinkingLevels("chatgpt", "gpt-5.6-terra"), { how: "effort", levels: all });
  assert.deepEqual(thinkingLevels("openai-responses", "gpt-5.5"), { how: "effort", levels: all });
  assert.deepEqual(thinkingLevels("anthropic", "claude-sonnet-4-5"), { how: "budget", levels: all });
  assert.deepEqual(thinkingLevels("anthropic-vertex", "claude-opus-4-1@20250805"), { how: "budget", levels: all });
  assert.deepEqual(thinkingLevels("anthropic", "claude-3-7-sonnet-latest"), { how: "budget", levels: all });
  assert.deepEqual(thinkingLevels("anthropic", "claude-3-5-haiku-latest"), { how: "none", levels: [] });
  for (const provider of ["gemini", "ollama", "cohere", "bedrock", "azure-openai", "claude-code", "scripted"])
    assert.equal(thinkingLevels(provider, "gpt-5.5").how, "none", `${provider} sends no level, so none is offered`);
});

test("K2 the providers that send a level are exactly the ones the map knows", async () => {
  const src = join(import.meta.dirname, "..", "src");
  const files = [...(await readdir(src)).map((name) => join(src, name)), ...(await readdir(join(src, "providers"))).map((name) => join(src, "providers", name))];
  const senders = [];
  for (const file of files.filter((name) => name.endsWith(".ts"))) {
    const text = await readFile(file, "utf8");
    if (/request\.reasoning\s*\?/.test(text) || /thinkingBudgets\[request\.reasoning\]/.test(text)) senders.push(file.split(/[\\/]/).slice(-2).join("/"));
  }
  assert.deepEqual(senders.sort(), ["providers/openai-responses.ts", "src/chatgpt-provider.ts", "src/providers.ts"],
    "a provider started or stopped sending a thinking level: update src/thinking-levels.ts");
});

async function fixture(t) {
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-thinking-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const answer = async () => ({ content: "ok", toolCalls: [] });
  for (const [id, name, provider, model] of [["think-gpt", "OpenAI", "openai-compatible", "gpt-5.5"],
    ["think-claude", "Anthropic", "anthropic", "claude-sonnet-4-5"], ["think-local", "Ollama", "ollama", "llama3.1:8b"]])
    app.runtime.models.register({ id, name, model, provider: { name: provider, complete: answer } });
  app.runtime.models.configure(app.runtime.owner, { activePreset: "think-local", reasoning: "high" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  return { page, errors, app, server };
}
const values = (page, id) => page.locator(`#${id} option`).evaluateAll((nodes) => nodes.map((node) => node.value));

test("K3 the /api/state models carry their levels, and the default list follows the chosen model", async (t) => {
  const { page, errors, server } = await fixture(t);
  const state = await (await fetch(new URL("/api/state", server.url), { headers: { authorization: `Bearer ${server.token}` } })).json();
  const byId = Object.fromEntries(state.models.presets.map((preset) => [preset.id, preset.thinking]));
  assert.deepEqual(byId["think-claude"], { how: "budget", levels: all });
  assert.deepEqual(byId["think-local"], { how: "none", levels: [] });
  await page.locator("#models-reasoning-thinking-note").waitFor({ state: "attached", timeout: 30000 });
  await openSettingFor(page, "#models-reasoning");
  // Ollama takes no level: the saved "high" is kept and marked, and the note says so.
  assert.deepEqual(await values(page, "models-reasoning"), ["", "high"]);
  assert.equal(await page.locator("#models-reasoning").inputValue(), "high", "the saved level is kept, not cleared");
  assert.match(await page.locator("#models-reasoning option[value=high]").innerText(), /does not use it/);
  assert.match(await page.locator("#models-reasoning-thinking-note").innerText(), /llama3\.1:8b does not take a thinking setting/);
  await page.locator("#models-active").selectOption("think-claude");
  assert.deepEqual(await values(page, "models-reasoning"), ["", ...all]);
  assert.match(await page.locator("#models-reasoning option[value=low]").innerText(), /short think/);
  assert.match(await page.locator("#models-reasoning option[value='']").innerText(), /^Off/);
  await page.locator("#models-active").selectOption("think-gpt");
  assert.deepEqual(await values(page, "models-reasoning"), ["", ...all]);
  assert.equal(await page.locator("#models-reasoning option[value=medium]").innerText(), "Balanced");
  assert.equal(await page.locator("#models-reasoning-thinking-note").isHidden(), true, "nothing to explain for an effort model");
  assert.deepEqual(errors, []);
});

test("K4 a conversation's list follows its own model, and a per-model level offers only what that model takes", async (t) => {
  const { page, errors, server } = await fixture(t);
  const call = (path, body) => fetch(new URL(path, server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  await page.locator("#prompt").fill("Hello there");
  await page.locator("#send").click();
  await page.locator(".message.assistant").first().waitFor({ timeout: 20000 });
  await page.locator("#session-reasoning-thinking-note").waitFor({ state: "attached", timeout: 20000 });
  assert.deepEqual(await values(page, "session-reasoning"), [""], "the workspace default here is Ollama, which takes none");
  const sessionId = await page.locator("#conversation").getAttribute("data-session-id");
  await call(`/api/sessions/${sessionId}/model`, { preset: "think-claude", reasoning: "medium" });
  await page.evaluate(() => globalThis.branchRefreshSessionModel());
  await page.waitForFunction(() => document.querySelectorAll("#session-reasoning option").length === 4);
  assert.equal(await page.locator("#session-reasoning").inputValue(), "medium");
  const knobs = await (await fetch(new URL("/api/knobs", server.url), { headers: { authorization: `Bearer ${server.token}` } })).json();
  const local = knobs.connections.find((one) => one.id === "think-local");
  assert.deepEqual(local.thinking, { how: "none", levels: [] }, "the per-model levels carry the same map");
  assert.deepEqual(errors, []);
});
