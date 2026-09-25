/**
 * FQ-collaboration.unified-search: the palette (Ctrl K / the top-bar "Search" box) is where the
 * owner actually reaches GET /api/search (src/unified-search.ts, public/unified-search.js). This
 * proves a query that matches nothing local still surfaces a conversation, a workflow and an audit
 * (repository) result, each opening the real place its source lives — not just that the route answers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-unified-search-palette-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });

  const word = "quokkabridge7000";
  const owner = app.runtime.owner;
  const run = app.store.createRun(owner, "Unified search palette fixture");
  app.store.message(run.sessionId, { role: "user", content: `Notes mentioning ${word} here.` });
  app.store.finish(run.id, "completed", "Fixture complete");
  // A recent conversation whose title does not carry the word, only a later message: the palette's
  // local title match cannot find it, so only /api/search can.
  const quiet = app.store.createRun(owner, "Plan the trip");
  app.store.message(quiet.sessionId, { role: "user", content: "Plan the trip" });
  app.store.message(quiet.sessionId, { role: "assistant", content: `Pack the ${word} adapter first.` });
  app.store.finish(quiet.id, "completed", "Fixture complete");
  const workflow = app.workflows.create(owner, {
    name: `Palette workflow ${word}`,
    description: `A saved workflow used only to test ${word} in the palette.`,
    steps: [{ name: "Say hello", kind: "prompt", prompt: "Say hello." }],
  });
  app.store.audit.record(owner, {
    action: "data.exported", actor: owner, subject: `export touching ${word}`,
    reason: "Palette fixture for unified search", outcome: "saved",
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors, word, sessionId: run.sessionId, quietId: quiet.sessionId, workflow };
}

async function searchFor(page, word) {
  await page.keyboard.press("ControlOrMeta+K");
  await page.locator("#cmd-input").waitFor({ state: "visible" });
  await page.locator("#cmd-input").fill(word);
}

test("a conversation result opens the conversation", async (t) => {
  const { page, errors, word, sessionId } = await fixture(t);
  await searchFor(page, word);
  // "Notes mentioning …" is the fixture message itself, so this is unambiguously the row for it —
  // whether the palette found it locally (the rail's own recent list) or through /api/search.
  const item = page.locator(".cmd-item", { hasText: "Notes mentioning" });
  await item.waitFor({ state: "visible", timeout: 10000 });
  await item.click();
  await page.locator("#cmd-input").waitFor({ state: "hidden" });
  await page.waitForFunction((w) => document.getElementById("thread-name")?.textContent?.includes(w), word);
  assert.ok((await page.locator("#thread-name").textContent()).includes(word));
  assert.equal(await page.evaluate(() => document.getElementById("conversation").dataset.sessionId), sessionId);
  assert.deepEqual(errors, []);
});

test("a workflow result opens Automations, where the workflow is listed", async (t) => {
  const { page, word, workflow } = await fixture(t);
  await searchFor(page, word);
  const item = page.locator(".cmd-item", { hasText: "Workflow" });
  await item.waitFor({ state: "visible", timeout: 10000 });
  await item.click();
  await page.locator("#cmd-input").waitFor({ state: "hidden" });
  await page.locator(".collab-card strong", { hasText: workflow.name }).waitFor({ state: "visible", timeout: 10000 });
});

test("a repository (audit) result opens Usage, where the record is listed", async (t) => {
  const { page, word } = await fixture(t);
  await searchFor(page, word);
  const item = page.locator(".cmd-item", { hasText: "What it was allowed to do" });
  await item.waitFor({ state: "visible", timeout: 10000 });
  await item.click();
  await page.locator("#cmd-input").waitFor({ state: "hidden" });
  await page.getByText(`export touching ${word}`).first().waitFor({ state: "visible", timeout: 10000 });
});

test("a one-letter query never reaches the remote search, but the full word does", async (t) => {
  const { page, word } = await fixture(t);
  // The workflow and the audit entry are never in any local, already-loaded list — the only way
  // the palette can find either is a round trip to /api/search, so they are the clean signal for
  // whether that round trip happened yet.
  await page.keyboard.press("ControlOrMeta+K");
  await page.locator("#cmd-input").waitFor({ state: "visible" });
  await page.locator("#cmd-input").fill(word[0]);
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".cmd-item", { hasText: "Workflow" }).count(), 0, "one letter is too short to search remotely");
  await page.locator("#cmd-input").fill(word);
  await page.locator(".cmd-item", { hasText: "Workflow" }).waitFor({ state: "visible", timeout: 10000 });
});

test("a recent conversation whose title lacks the word is still found by its words, and opens", async (t) => {
  const { page, errors, word, quietId } = await fixture(t);
  await searchFor(page, word);
  const item = page.locator(".cmd-item", { hasText: `Conversation ${quietId.slice(0, 8)}` }).first();
  await item.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator(".cmd-item", { hasText: "Plan the trip" }).count(), 0, "its title did not match locally");
  await item.click();
  await page.locator("#cmd-input").waitFor({ state: "hidden" });
  await page.waitForFunction((id) => document.getElementById("conversation").dataset.sessionId === id, quietId);
  assert.deepEqual(errors, []);
});

test("the palette lists a conversation once even if the search answers with two rows for it", async (t) => {
  const { page, word, quietId } = await fixture(t);
  // The server already groups by conversation; this feeds the palette a repeated row directly, so
  // its own de-duplication is what is being checked.
  const row = { kind: "conversation", title: `Conversation ${quietId.slice(0, 8)}`,
    snippet: `Pack the ${word} adapter first.`, link: `/api/sessions/${quietId}` };
  await page.route("**/api/search?*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ results: [row, { ...row }] }),
  }));
  await searchFor(page, word);
  const item = page.locator(".cmd-item", { hasText: `Conversation ${quietId.slice(0, 8)}` });
  await item.first().waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(300);
  assert.equal(await item.count(), 1);
});
