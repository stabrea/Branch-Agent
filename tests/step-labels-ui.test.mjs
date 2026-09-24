/**
 * Dogfood B2/B3: a step in a conversation says what was done and what came of it, like Claude Code's tool lines, not
 * only which tools were used ("Worked with 6 tools · settings list", or "Used settings change" when nothing changed).
 * A headless browser, a scripted model, and two real tool calls: one that works and one that cannot.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const prompt = "Look at your settings and read the missing file";

async function fixture(t) {
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-step-labels-"));
  let round = 0;
  const provider = { name: "scripted", async complete() {
    if (++round === 1) return { content: "", toolCalls: [
      { id: "one", name: "settings.list", arguments: "{}" },
      { id: "two", name: "files.read", arguments: JSON.stringify({ path: "missing-notes.txt" }) },
    ] };
    return { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await app.runtime.run({ prompt });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors };
}

test("a step says what was done and what came of it, and names the part that did not work", async (t) => {
  const { page, errors } = await fixture(t);
  await page.getByText(prompt).first().click();
  const step = page.locator("#conversation .tool-step").first();
  await step.waitFor({ timeout: 30000 });
  const label = (await step.locator("summary").innerText()).trim();
  assert.match(label, /^2 steps: Looked through the settings; Read missing-notes\.txt · 1 didn't work/, label);
  assert.doesNotMatch(label, /Worked with|Used /, "never only which tool was used");
  await step.locator("summary").click();
  const lines = await step.locator(".step-line").evaluateAll((nodes) => nodes.map((node) => [node.dataset.ok, node.innerText.replace(/\s+/g, " ")]));
  assert.equal(lines[0][0], "true");
  assert.match(lines[0][1], /✓ Looked through the settings done/);
  assert.equal(lines[1][0], "false");
  assert.match(lines[1][1], /✗ Read missing-notes\.txt didn't work:/);
  assert.match(lines[1][1], /files\.read/, "the call itself is still there to look at");
  assert.deepEqual(errors, []);
});
