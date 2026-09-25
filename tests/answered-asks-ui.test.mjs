/**
 * NAS 0adb368: the window said "Noted. It carries on in its conversation." when the monthly budget refused the
 * carry-on. The Inbox card's words now follow what the answer did: carried on, or still waiting.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer, carryOnWords } from "../dist/server.js";
import { openPlace } from "./places.mjs";

function writer() {
  let file = "";
  return { name: "writer", async complete(request) {
    const last = request.messages.at(-1);
    const named = /^write (\S+)/.exec(String(last?.content ?? ""));
    if (last?.role === "user" && named) file = named[1];
    if (last?.role === "user" && (named || last.content === carryOnWords))
      return { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path: file, content: "hello" }) }] };
    return { content: "Done.", toolCalls: [] };
  } };
}

test("the Inbox says it carries on only when it does, and that it still waits when the budget stops it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-answered-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: writer() });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const answerOnce = async () => {
    const card = page.locator("#policy-waiting .item").first();
    await card.waitFor({ timeout: 30000 });
    await card.getByRole("button", { name: "Yes, just now", exact: true }).click();
    await page.waitForFunction(() => /^Noted\./.test(document.getElementById("policy-status")?.textContent ?? ""), null, { timeout: 20000 });
    return page.locator("#policy-status").textContent();
  };
  await app.runtime.run({ prompt: "write u1.txt" });
  await openPlace(page, "inbox:needs");
  assert.equal(await answerOnce(), "Noted. It carries on in its conversation.");
  // A second task asks; then the budget is reached, so its carry-on is refused as it starts.
  const second = await app.runtime.run({ prompt: "write u2.txt" });
  assert.equal(second.status, "needs_input", "control: a second task waits");
  app.store.save("settings", app.runtime.owner, "usage_budget", { pauseAtBudget: true, maxMonthlyTokens: 0 });
  await page.evaluate(() => { document.getElementById("policy-status").textContent = ""; });
  assert.equal(await answerOnce(), "Noted. It still waits in its conversation: open it to carry on.");
  assert.deepEqual(errors, []);
});
