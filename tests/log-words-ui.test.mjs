/**
 * Dogfood E2 part 2 (Mac mini's item 3): Inbox › History, "The record of what happened", named each step as it is
 * filed (`tool.started`, `catalog.preselected`) and showed its details as key: value dumps. Each kind now reads in
 * words, a step's own sentence shows, and the details fold away under "Details". A scripted model and a headless page.
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

test("the record names each step in words, keeps the step's own sentence, and folds the details away", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-log-words-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  let round = 0;
  const provider = { name: "scripted", async complete() {
    return ++round === 1 ? { content: "", toolCalls: [{ id: "c1", name: "files.list", arguments: "{\"path\":\".\"}" }] } : { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await app.runtime.run({ prompt: "list the folder" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  const seen = await page.evaluate(async () => {
    const logs = await import("/logs.js");
    await logs.drawLog();
    const rows = [...document.querySelectorAll("#log-list .log-row")];
    return {
      titles: rows.map((row) => row.querySelector("strong").textContent),
      started: rows.find((row) => row.dataset.kind === "tool.started")?.querySelector(":scope > p")?.textContent ?? "",
      folded: rows.every((row) => !row.querySelector(".log-details") || !row.querySelector(".log-details").open),
      options: [...document.querySelectorAll("#log-kind option")].map((option) => option.textContent),
      unknown: logs.kindWords("some.new_kind"),
    };
  });
  assert.ok(seen.titles.includes("Task started") && seen.titles.includes("Step started"), seen.titles.join(" | "));
  assert.ok(seen.titles.every((title) => !/^[a-z]+\.[a-z_]+$/.test(title)), `no step is named as it is filed: ${seen.titles.join(" | ")}`);
  assert.match(seen.started, /Looking through/, "a step's own sentence shows");
  assert.ok(seen.folded, "the details are folded away");
  assert.ok(seen.options.every((option) => !/^[a-z]+\.[a-z_]+$/.test(option)), `the picker offers words: ${seen.options.join(" | ")}`);
  assert.equal(seen.unknown, "Some new kind", "a kind with no words of its own is spelled out from its name");
  assert.deepEqual(errors, []);
});
