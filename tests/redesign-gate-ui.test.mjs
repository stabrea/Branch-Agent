/**
 * Redesign merge gate (design/redesign/CONTRACT.md): in the new window, sign in with the session token, send a message
 * and see the reply stream in, and answer the approval card: the action's own verb lets it go ahead once, "Don't allow"
 * refuses it, and "Always allow" stays greyed out until a standing yes can be kept for one Trunk. A scripted model;
 * nothing reaches a provider.
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
  const last = request.messages.at(-1);
  if (last?.role === "tool") return { content: "Written.", toolCalls: [] };
  // A yes carries the task on with a nudge; the model then makes the call again and it goes through.
  if (last?.role === "user" && request.messages.some((m) => m.role === "user" && /write the note/.test(String(m.content))))
    return { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hello" }) }] };
  for (const piece of ["Hello ", "from ", "Branch."]) request.onTextDelta?.(piece);
  return { content: "Hello from Branch.", toolCalls: [] };
} };

async function signedIn(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-redesign-gate-"));
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
  return { page, workspace };
}
async function send(page, text) {
  await page.locator("#prompt").fill(text);
  await page.locator("#send").click();
}

test("sign in, send a message, and the reply shows in the conversation", async (t) => {
  const { page } = await signedIn(t);
  await send(page, "say hello");
  await page.locator("#conversation").getByText("Hello from Branch.").waitFor({ timeout: 30000 });
  assert.match(await page.locator("#conversation").innerText(), /say hello/, "the message sent is in the conversation");
});

test("the approval card: the verb lets it go ahead once, Always allow is greyed out", async (t) => {
  const { page, workspace } = await signedIn(t);
  await send(page, "write the note");
  const card = page.locator("#live-ask");
  await card.waitFor({ state: "visible", timeout: 30000 });
  const always = card.getByRole("button", { name: "Always allow", exact: true });
  assert.equal(await always.getAttribute("aria-disabled"), "true", "Always allow waits for Trunk-scoped rules");
  assert.equal(existsSync(join(workspace, "note.txt")), false, "nothing is written before the answer");
  await card.locator(".btn.pri").click();
  await page.locator("#conversation").getByText("Written.").waitFor({ timeout: 30000 });
  assert.equal(await readFile(join(workspace, "note.txt"), "utf8"), "hello");
  assert.equal(await page.locator("#live-ask").count(), 0, "the card is gone once answered");
});

test("the approval card: Don't allow refuses it and nothing is written", async (t) => {
  const { page, workspace } = await signedIn(t);
  await send(page, "write the note");
  const card = page.locator("#live-ask");
  await card.waitFor({ state: "visible", timeout: 30000 });
  await card.getByRole("button", { name: "Don’t allow", exact: true }).click();
  await page.locator("#live-ask").waitFor({ state: "detached", timeout: 30000 });
  assert.equal(existsSync(join(workspace, "note.txt")), false, "a refusal writes nothing");
});

test("add an account in Settings › Accounts: the engine keeps it and the key never shows on the page", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-redesign-accounts-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const owner = app.runtime.owner;
  const answer = async () => ({ content: "ok", toolCalls: [] });
  app.store.save("settings", owner, "model-connections", { connections: [
    { id: "openai-work", name: "OpenAI", catalogId: "openai", model: "gpt-5.5", extras: {} }] });
  app.runtime.models.register({ id: "openai-work", name: "OpenAI", model: "gpt-5.5", catalogId: "openai", provider: { name: "openai-compatible", complete: answer } });
  app.runtime.models.configure(owner, { activePreset: "openai-work" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then((response) => response.json());
  await call("/api/accounts/settings", { mode: "on" });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.locator('[data-act="setpage"][data-v="accounts"]').click();
  await page.getByRole("button", { name: "Add an account", exact: true }).click();
  await page.locator('[data-act="aa-prov"][data-v="openai-work"]').click();
  const key = "sk-redesign-gate-000000000000000042";
  // The prototype's wizard: the key on its own step ("Add key" sends it), then the name on the next ("Add account").
  await page.getByLabel("Key", { exact: true }).fill(key);
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  await page.getByLabel("Call it", { exact: true }).fill("Work key");
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await page.locator(".dlg").waitFor({ state: "detached", timeout: 30000 });
  const pool = (await call("/api/accounts")).pools.find((p) => p.pool === "openai-work");
  assert.ok(pool.accounts.some((a) => a.label === "Work key"), "the engine kept the new account");
  assert.equal((await page.content()).includes(key), false, "the key is never on the page");
  assert.equal((await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }))).includes(key), false,
    "the key is never kept in the window's storage");
});
