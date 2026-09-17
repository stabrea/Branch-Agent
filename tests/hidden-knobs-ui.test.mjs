/**
 * R17-S-B: the knob cards open where docs/places.md says, every control is described by its own
 * sentence, a change saved on the screen reaches the server, and "Put back as shipped" undoes it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, readKnobs } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace, openSettingFor } from "./places.mjs";

const homes = {
  "knobs-compaction-card": "#lx-models-defaults",
  "knobs-subtasks-card": "#lx-models-defaults",
  "knobs-reasoning-card": "#lx-models-defaults",
  "knobs-limits-card": "#lx-page-permissions",
  "knobs-leak-guard-card": "#lx-page-permissions",
  "knobs-retries-card": "#lx-page-advanced",
  "knobs-tools-card": "#lx-page-advanced",
  "knobs-commands-card": "#lx-page-computer",
  "knobs-launch-file-card": "#lx-page-computer",
  "knobs-show-reasoning-card": "#lx-page-appearance",
};

async function openApp(t, width = 1280) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-knobs-ui-"));
  const launchFile = join(root, "integrations.json");
  await writeFile(launchFile, JSON.stringify({ browser: { allowedOrigins: ["https://example.com"] } }));
  const before = process.env.BRANCH_INTEGRATIONS;
  process.env.BRANCH_INTEGRATIONS = launchFile;
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); await server.close(); await app.close(); await discardTemp(root);
    if (before === undefined) delete process.env.BRANCH_INTEGRATIONS; else process.env.BRANCH_INTEGRATIONS = before;
  });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.locator("#knobs-launch-file-card").waitFor({ state: "attached" });
  return { app, page, launchFile };
}

/** Every visible control in the card, and whether the sentence it points at has words. */
const undescribed = (page, id) => page.evaluate((cardId) => {
  const card = document.getElementById(cardId);
  return [...card.querySelectorAll("input, select, textarea")].filter((control) => {
    const note = document.getElementById(control.getAttribute("aria-describedby") ?? "");
    return !note || !note.textContent.trim();
  }).map((control) => control.id);
}, id);

test("each knob card is in its home, every control has its own sentence, and saving reaches the server", async (t) => {
  const { app, page, launchFile } = await openApp(t);
  for (const [id, host] of Object.entries(homes)) {
    await page.waitForFunction(([card, slot]) => document.getElementById(card)?.closest(slot), [id, host]);
    await openSettingFor(page, `#${id}`);
    assert.ok(await page.locator(`#${id}`).isVisible(), `${id} can be seen on its page`);
    assert.equal(await page.locator(`#${id} h2 + p.subtle`).count(), 1, `${id} says what it is for`);
    assert.deepEqual(await undescribed(page, id), [], `${id} has a control without a sentence`);
  }
  await openPlace(page, "memory");
  await page.waitForFunction(() => document.getElementById("knobs-memory-card")?.closest("#memory"));
  assert.ok(await page.locator("#knobs-memory-card").isVisible(), "the memory card is in Library, Memory");
  assert.deepEqual(await undescribed(page, "knobs-memory-card"), []);

  await openSettingFor(page, "#knobs-limits-card");
  await page.locator("#knobs-maxSteps").fill("25");
  await page.locator("#knobs-limits-card").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#knobs-limits-card [role=status]").filter({ hasText: "Saved" }).waitFor();
  assert.equal(readKnobs(app.store, "local", "limits").maxSteps, 25);
  await page.locator("#knobs-limits-card").getByRole("button", { name: "Put back as shipped" }).click();
  await page.locator("#knobs-limits-card [role=status]").filter({ hasText: "Put back" }).waitFor();
  assert.equal(readKnobs(app.store, "local", "limits").maxSteps, 60);
  assert.equal(await page.locator("#knobs-maxSteps").inputValue(), "60");

  await openSettingFor(page, "#knobs-commands-card");
  await page.locator("#knobs-passEnvironment").fill("OPENAI_API_KEY");
  await page.locator("#knobs-commands-card").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#knobs-commands-card [role=status]").filter({ hasText: "never handed to commands" }).waitFor();
  assert.deepEqual(readKnobs(app.store, "local", "commands").passEnvironment, []);

  await openSettingFor(page, "#knobs-launch-file-card");
  await page.locator("#knobs-launch-browserSites").fill("https://example.com\nhttps://docs.example.org");
  await page.locator("#knobs-launch-file-card").getByRole("button", { name: "Save for the next start" }).click();
  await page.locator("#knobs-launch-file-card [role=status]").filter({ hasText: "next time it starts" }).waitFor();
  assert.deepEqual(JSON.parse(await readFile(launchFile, "utf8")).browser.allowedOrigins, ["https://example.com", "https://docs.example.org"]);
});

test("at 400 px the knob cards fit without sideways scrolling", async (t) => {
  const { page } = await openApp(t, 400);
  for (const id of ["knobs-leak-guard-card", "knobs-commands-card", "knobs-reasoning-card"]) {
    await openSettingFor(page, `#${id}`);
    const box = await page.locator(`#${id}`).evaluate((card) => ({ scroll: card.scrollWidth, client: card.clientWidth }));
    assert.ok(box.scroll <= box.client + 1, `${id} is wider than its card (${box.scroll} > ${box.client})`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${id} scrolls the page sideways`);
  }
});
