/* DG-119: in a conversation that has never run anything, no section of the side panel is a bare heading. Every one
   says what it holds or why it is empty, in every tab, with Show everything on and off. "Still to do" used to show
   the sign-in's refusal ("Too many wrong tries...") instead: its list was asked for before the key was given and
   never asked for again. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const quiet = { name: "scripted", async complete() { return { content: "Here is a short answer.", toolCalls: [] }; } };
const english = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));

async function neverRun(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-side-empty-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const sessionId = app.store.createSession(app.runtime.owner);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /* Through the real sign-in page, as a person in a browser meets it. */
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => globalThis.branchPanels);
  errors.length = 0; // what failed before the key was given is the login page's business
  await page.evaluate(async (id) => { const { openConversation } = await import("/app.js"); await openConversation(id); }, sessionId);
  return { page, errors };
}

/** The headings in the open tab with nothing visible under them. A folded disclosure is a control, not a heading. */
const bareHeadings = (page) => page.evaluate(() => [...document.getElementById("context-panel").children]
  .filter((block) => block.getClientRects().length && !block.matches(".lx-pane-head, .lx-pane-foot"))
  .flatMap((block) => {
    const shown = [...block.children].filter((child) => child.getClientRects().length);
    const head = shown.find((child) => child.matches("h2, h3, .context-head"));
    if (!head) return [];
    const said = shown.some((child) => child !== head && (child.innerText.trim() || child.querySelector("input, button, select, textarea")));
    return said ? [] : [head.innerText.trim()];
  }));

test("DG-119 a conversation that never ran anything shows no bare heading in any side panel tab", async (t) => {
  const { page, errors } = await neverRun(t);
  for (const everything of [false, true]) {
    await page.evaluate(async (on) => (await import("/appearance.js")).changeAppearance({ showEverything: on }), everything);
    await page.waitForFunction((on) => (document.documentElement.dataset.everything === "on") === on, everything);
    if (!(await page.locator("#context-panel").isVisible())) await page.locator("#aside-toggle").click();
    await page.locator("#context-panel").waitFor({ state: "visible" });
    const mode = `Show everything ${everything ? "on" : "off"}`;
    for (const tab of ["activity", "plan", "files", "memory", "browser", "terminal"]) {
      await page.locator(`#context-panel .lx-pane-tab[data-pane="${tab}"]`).click();
      await page.waitForFunction((name) => document.getElementById("context-panel").dataset.pane === name, tab);
      /* Give each section its first drawing, then read what it says. */
      await page.waitForFunction(() => !document.querySelector("#context-todos:empty, #context-working:empty"), null, { timeout: 10000 })
        .catch(() => {});
      assert.deepEqual(await bareHeadings(page), [], `${mode}, ${tab}: every heading has something under it`);
    }
    /* Still to do says it is empty, in its own words, not the sign-in's refusal. */
    await page.locator('#context-panel .lx-pane-tab[data-pane="plan"]').click();
    await page.waitForFunction((words) => document.getElementById("context-todos").innerText.trim() === words, english["todos.empty"],
      { timeout: 10000 }).catch(() => {});
    assert.equal((await page.locator("#context-todos").innerText()).trim(), english["todos.empty"], `${mode}: Still to do explains that it is empty`);
  }
  assert.deepEqual(errors, []);
});
