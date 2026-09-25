/**
 * Redesign security review, re-checked in the new window:
 * F1/F2: with a request waiting in each of two conversations, allowing the one shown answers that one only; the other
 * still waits and nothing of it happens. F3: a Trunk whose name is markup shows the name as text; no element of it
 * becomes part of the page. A scripted model; nothing reaches a provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readPolicy, savePolicy } from "../dist/policy.js";

const scripted = { name: "scripted", async complete(request) {
  const users = request.messages.filter((m) => m.role === "user").map((m) => String(m.content));
  if (request.messages.at(-1)?.role === "tool") return { content: "Written.", toolCalls: [] };
  const wanted = users.map((text) => /write (\w+)/.exec(text)?.[1]).find(Boolean);
  if (wanted && request.messages.at(-1)?.role === "user")
    return { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: `${wanted}.txt`, content: wanted }) }] };
  return { content: "ok", toolCalls: [] };
} };

async function signedIn(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-redesign-exact-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider: scripted });
  const policy = readPolicy(app.store, app.runtime.owner);
  savePolicy(app.store, app.runtime.owner, { ...policy, rules: [{ tool: "files.write", decision: "ask" }, ...policy.rules] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, server, workspace };
}
async function send(page, text) {
  await page.locator("#prompt").fill(text);
  await page.locator("#send").click();
}

test("F1/F2: allowing the request shown answers that one only; the other conversation's still waits", async (t) => {
  const { app, page, workspace } = await signedIn(t);
  await send(page, "write alpha");
  await page.locator("#live-ask").waitFor({ state: "visible", timeout: 30000 });
  await page.locator('[data-act="newmenu"]').first().click();
  await page.locator('[data-act="newconv"]').first().click();
  await send(page, "write beta");
  await page.waitForFunction(() => document.querySelector("#live-ask")?.textContent?.includes("beta"), undefined, { timeout: 30000 });
  assert.equal(app.runtime.approvals.waiting().length, 2, "a request waits in each conversation");
  await page.locator("#live-ask .btn.pri").click();
  await page.locator("#conversation").getByText("Written.").waitFor({ timeout: 30000 });
  assert.equal(await readFile(join(workspace, "beta.txt"), "utf8"), "beta", "the request shown was answered");
  assert.equal(existsSync(join(workspace, "alpha.txt")), false, "the other conversation's request did not happen");
  assert.deepEqual(app.runtime.approvals.waiting().map((q) => q.target), ["alpha.txt"], "it still waits");
});

test("F3: a Trunk named with markup shows the name as text, and none of it becomes part of the page", async (t) => {
  const { app, page } = await signedIn(t);
  const name = "</button><i class=scrim data-act=ask>";
  app.trunks.create({ name });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.locator('[data-act="setpage"][data-v="instructions"]').click();
  await page.getByText(name, { exact: true }).first().waitFor({ timeout: 30000 });
  assert.equal(await page.locator("i.scrim").count(), 0, "no element made from the name");
  assert.equal(await page.locator('i[data-act="ask"]').count(), 0, "no action made from the name");
});

test("F1: an approve control that names no request (as Inbox's Trunk-message rows had) answers nothing", async (t) => {
  const { app, page, workspace } = await signedIn(t);
  await send(page, "write alpha");
  await page.locator("#live-ask").waitFor({ state: "visible", timeout: 30000 });
  await page.locator('[data-act="newmenu"]').first().click();
  await page.locator('[data-act="newconv"]').first().click();
  await page.evaluate(() => {
    const stray = document.createElement("button");
    stray.type = "button"; stray.id = "stray-allow"; stray.dataset.act = "ask"; stray.dataset.v = "allowed"; stray.textContent = "Allow";
    document.querySelector("#main").append(stray);
  });
  await page.locator("#stray-allow").click();
  await page.waitForTimeout(3000);
  assert.equal(existsSync(join(workspace, "alpha.txt")), false, "the unseen request did not happen");
  assert.equal(app.runtime.approvals.waiting().length, 1, "it still waits");
});
