/* Q59: the four conversation modes, weighed tool by tool through the real runtime's policy check.
   Plan is never looser than Ask first, Ask first never looser than Auto, Auto never looser than No
   approvals, and the design's own rows hold: Ask first asks before any change, command or web action
   (Q59-Q60-PRESETS-DESIGN.md, the coordinator's ruling). "follow" is the owner's own rules, not a mode. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { saveConversationMode } from "../dist/conversation-mode.js";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { BranchShell, registerShell } from "../dist/integrations/shell.js";
import { registerAnswerEngine } from "../dist/asks/answer-engine.js";
import { registerMarketTool } from "../dist/interop/agent-market.js";

const modes = ["plan", "ask", "auto", "full"];
const care = { allow: 0, ask: 1, deny: 2 };
const page = "https://example.com/a";
/** Representative calls, each with arguments the tool really accepts, so no row is an argument refusal. */
const calls = {
  "files.read": { path: "notes.txt" },
  "files.write": { path: "notes.txt", content: "x" },
  "shell.execute": { executable: "node", args: ["--version"] },
  "web.fetch": { url: page },
  "web.search": { query: "branch agent" },
  "web.page": { url: page },
  "web.crawl": { url: page },
  "media.captions": { url: page },
  "media.download": { url: page },
  "decisions.judge": { kind: "yes", question: "Is the report finished?", state: "finished" },
  "answer.ask": { question: "what is branch agent" },
  "assistant.market": { market: page },
  "research.run": { question: "what is branch agent", sources: [page] },
  "browser.navigate": { url: page },
  "browser.snapshot": {},
  "browser.click": { role: "button", name: "Go" },
  "browser.fill": { label: "Name", value: "x" },
  "browser.upload": { selector: "#file", path: "notes.txt" },
};
/** The web actions Auto asks about (webActionRules in src/policy.ts). */
const autoAsks = ["web.fetch", "web.search", "web.page", "web.crawl", "media.captions", "decisions.judge",
  "answer.ask", "assistant.market", "browser.navigate", "browser.click", "browser.fill", "browser.upload"];
/** Everything that reaches out to the web: Ask first asks, Plan never lets it through. */
const webActions = [...autoAsks, "research.run", "media.download"];

async function modeTable(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-mode-order-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const browser = new BranchBrowser({ allowedOrigins: ["https://example.com"], maxRuns: 1 });
  const shell = new BranchShell({ executables: { node: { path: process.execPath } } });
  t.after(async () => { await shell.close(); await browser.close(); await app.close(); await discardTemp(root); });
  // The command, browser and two optional web reader tools are registered for real, so each row is
  // judged by the tool's own permission and not as an unknown tool.
  await shell.ready();
  registerShell(app.registry, shell);
  registerBrowser(app.runtime.registry, browser);
  registerAnswerEngine(app.runtime.registry, {});
  registerMarketTool(app.runtime.registry, {});
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  const contexts = {};
  for (const mode of modes) {
    const run = await app.runtime.run({ prompt: `a ${mode} conversation` });
    saveConversationMode(app.store, app.runtime.owner, run.sessionId, { mode, planSet: mode === "plan" });
    contexts[mode] = app.runtime.context({ runId: run.id });
  }
  const check = (tool, args, mode) => app.runtime.checkPolicy(tool, args, contexts[mode]);
  return { app, check };
}

test("per tool, each mode is at least as careful as the next looser one, and the design's rows hold", async (t) => {
  const { app, check } = await modeTable(t);
  const table = {};
  for (const [tool, args] of Object.entries(calls)) {
    assert.notEqual(app.runtime.registry.permissionOf(tool), "", `${tool} is a registered tool`);
    table[tool] = {};
    for (const mode of modes) {
      const result = check(tool, args, mode);
      assert.equal(result.decision === "deny" ? result.reason : undefined, undefined,
        `${tool} under ${mode} is judged by the rules, not refused by a guard: ${result.reason}`);
      table[tool][mode] = result.decision;
    }
    const row = table[tool];
    for (let i = 1; i < modes.length; i++)
      assert.ok(care[row[modes[i - 1]]] >= care[row[modes[i]]],
        `${tool}: ${modes[i - 1]} (${row[modes[i - 1]]}) must be at least as careful as ${modes[i]} (${row[modes[i]]})`);
  }
  for (const tool of webActions) {
    assert.equal(table[tool].ask, "ask", `Ask first asks before the web action ${tool}`);
    assert.notEqual(table[tool].plan, "allow", `Plan never lets the web action ${tool} through`);
  }
  for (const tool of autoAsks) assert.equal(table[tool].auto, "ask", `Auto asks before the web action ${tool}`);
  assert.deepEqual(table["files.read"], { plan: "allow", ask: "allow", auto: "allow", full: "allow" }, "reading is free everywhere");
  assert.deepEqual(table["browser.snapshot"], { plan: "allow", ask: "allow", auto: "allow", full: "allow" }, "reading the open page is free");
  assert.deepEqual(table["files.write"], { plan: "deny", ask: "ask", auto: "allow", full: "allow" }, "Auto writes in the workspace; Plan refuses");
  assert.deepEqual(table["shell.execute"], { plan: "deny", ask: "ask", auto: "ask", full: "ask" }, "a command no rule covers asks even under No approvals");
  for (const tool of ["browser.click", "browser.fill", "browser.upload"])
    assert.equal(table[tool].plan, "deny", `Plan refuses the change ${tool}, never asks about it`);
  for (const tool of ["web.fetch", "web.search", "browser.navigate", "browser.click"])
    assert.equal(table[tool].full, "allow", `No approvals lets ${tool} through`);
});

test("every registered tool with the web.read permission is a web action to Ask first, Auto and Plan", async (t) => {
  const { app, check } = await modeTable(t);
  const readers = app.runtime.registry.inventory().filter((tool) => tool.permission === "web.read").map((tool) => tool.name);
  assert.ok(readers.length >= 8, `the web readers are registered: ${readers.join(", ")}`);
  for (const tool of readers) {
    const args = calls[tool];
    assert.ok(args, `${tool} reads the web: add it to this table and to webActionRules in src/policy.ts`);
    assert.equal(check(tool, args, "ask").decision, "ask", `Ask first asks before ${tool}`);
    assert.equal(check(tool, args, "auto").decision, "ask", `Auto asks before ${tool}`);
    assert.notEqual(check(tool, args, "plan").decision, "allow", `Plan never lets ${tool} through`);
  }
});
