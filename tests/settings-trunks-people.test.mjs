/**
 * DG-193: Settings › Trunks & people has the approved sample's sections, in its order, with the same "N more with …"
 * lines, at 1440, 860 and 400 and in both Show everything states; its switches save as you go and keep Customize ›
 * Specialists in step; its headings are French in French.
 * Parity pass: each row is the sample's `.ctl` (words left, control at the far edge, a line above, the note on a line
 * of its own; one column at 760px and under), Edit Trunk's rows come in the sample's order, the page says what the
 * sample says, and every word on the three cards is French in French.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const REGULAR = ["Trunks", "3 more with Advanced", "Edit Trunk", "15 more with Advanced", "A person's card", "2 more with Advanced"];
const ADVANCED = ["Trunks", "Edit Trunk", "A person's card"];

async function fixture(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-trunks-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", body: JSON.stringify({ done: true }),
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } });
  const page = await browser.newPage({ viewport: { width, height: 950 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  const cog = page.locator(".sg-foot-line > .sg-gear:visible");
  if (!(await cog.count())) await page.locator("#rail-toggle").click();
  await cog.click();
  await page.locator('.lx-settings-link[data-page="trunks"]').click();
  await page.locator("#lx-page-trunks > #settings-person-card").waitFor({ state: "attached" });
  return { app, page, errors };
}
const outline = (page) => page.evaluate(() => [...document.querySelectorAll("#lx-page-trunks .sg-head-title, #lx-page-trunks .sg-more")]
  .filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()));
async function settle(page, want) {
  await page.waitForFunction((want) => [...document.querySelectorAll("#lx-page-trunks .sg-head-title, #lx-page-trunks .sg-more")]
    .filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()).join("|") === want, want.join("|"), { timeout: 10000 }).catch(() => {});
}
async function level(page, pick) {
  await page.evaluate((pick) => globalThis.branchSettingsLevel.set(pick), pick);
  await page.waitForFunction((pick) => document.documentElement.dataset.settingsLevel === pick, pick);
}

/** Where each row's words, control and note sit: the three kinds of control, a three-way switch, a switch and a list. */
const geometry = (page) => page.evaluate(() => ["settings-trunks-switch-trunks", "settings-trunk-edit-commands", "settings-person-role"].map((id) => {
  const control = document.getElementById(id), row = control.closest(".settings-trunks-row");
  const shown = control.closest(".segmented-control") ?? control;
  const box = (node) => { const { left, right, top, bottom } = node.getBoundingClientRect(); return { left, right, top, bottom }; };
  const note = row.querySelector(":scope > .field-note");
  return { id, label: box(row.querySelector(":scope > label")), control: box(shown), note: note ? box(note) : null, line: getComputedStyle(row).borderTopWidth };
}));
/* The sample's Edit Trunk, top to bottom: switches, choices, words, lists. */
const EDIT_ORDER = ["commands", "hidden", "pinned", "keys", "model", "reasoning", "style", "picture", "name", "title", "description", "instructions",
  "section", "permissions", "skills", "mcp", "channels"].map((name) => `settings-trunk-edit-${name}`);

for (const width of [1440, 860, 400]) {
  test(`Trunks & people has the sample's sections in order, Show everything off and on, at ${width}px`, async (t) => {
    const { page, errors } = await fixture(t, width);
    await settle(page, REGULAR);
    assert.deepEqual(await outline(page), REGULAR);
    /* At Regular, the sample's two Trunks switches, and Edit Trunk's two ticks. */
    for (const id of ["settings-trunks-switch-trunks", "settings-trunks-switch-rooms", "settings-trunk-edit-commands", "settings-trunk-edit-hidden", "settings-person-role"])
      assert.equal(await page.locator(`#${id}`).isVisible(), true, `${id} shows at Regular`);
    assert.equal(await page.locator("#settings-trunks-switch-teach").isVisible(), false);
    for (const { id, label, control, note, line } of await geometry(page)) {
      assert.equal(line, "1px", `${id}: a line above its row`);
      if (width > 760) {
        assert.ok(control.left >= label.right, `${id}: the control sits right of its words at ${width}px`);
        assert.ok(control.top < label.bottom && control.bottom > label.top, `${id}: on the same line as its words at ${width}px`);
        assert.ok(control.right > width / 2, `${id}: at the far edge at ${width}px`);
      } else assert.ok(control.top >= label.bottom - 1, `${id}: under its words at ${width}px`);
      if (note) assert.ok(note.top >= Math.max(label.bottom, control.bottom) - 1, `${id}: its note on a line of its own at ${width}px`);
    }
    await level(page, "advanced");
    await settle(page, ADVANCED);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.everything), "on");
    assert.deepEqual(await outline(page), ADVANCED);
    assert.equal(await page.locator("#settings-trunk-edit-keys").isVisible(), true);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#settings-trunk-edit [data-sg-mirror]")].map((node) => node.id || node.querySelector("select").id)), EDIT_ORDER);
    /* No heading but the section's own, and no directory left behind. */
    assert.equal(await page.locator("#lx-page-trunks .settings-trunks-card h2, #lx-page-trunks .settings-trunks-card h3, #lx-page-trunks .settings-directory-card").count(), 0);
    assert.deepEqual(errors, []);
  });
}

test("a Trunks switch in Settings saves as you go and Customize follows it", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  assert.equal(await page.locator("#lx-page-trunks button", { hasText: /^Save/ }).count(), 0, "no Save button");
  await page.locator('.segmented-control:has(> #settings-trunks-switch-trunks) .segmented-option[data-v="on"]').click();
  /* Customize › Specialists redraws with Trunks on: its further switches appear only then. */
  await page.locator("#trunks-card [id='trunks-switch-rooms']").first().waitFor({ state: "attached" });
  await page.waitForFunction(() => document.getElementById("settings-trunks-switch-trunks")?.value === "on");
  assert.deepEqual(errors, []);
});

test("Trunks & people's section headings are French in French", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  assert.equal(await page.locator("#lx-page-trunks > .lx-page-intro").textContent(), "Your own assistants and the people who use Branch here.");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.getElementById("sg-bucket-trunks-person")?.textContent === "La fiche d'une personne");
  assert.equal(await page.locator("#sg-bucket-trunks-edit").textContent(), "Modifier un Trunk");
  assert.equal(await page.locator("#settings-trunks-switches .settings-trunks-open").textContent(), "Ouvrir Trunks");
  assert.equal(await page.locator("#lx-page-trunks > .lx-page-intro").textContent(), "Vos propres assistants et les personnes qui utilisent Branch ici.");
  /* Every word on the three cards, options and notes too, is its French one; nothing is left without a key. */
  const words = await page.evaluate(async () => {
    const fr = await (await fetch("/locales/fr.json")).json();
    const cards = ["settings-trunks-switches", "settings-trunk-edit", "settings-person-card"].map((id) => document.getElementById(id));
    const wrong = [], bare = [];
    for (const node of cards.flatMap((card) => [...card.querySelectorAll("[data-t]")]))
      if (node.textContent.trim() !== fr[node.dataset.t]) wrong.push(`${node.dataset.t}: ${node.textContent.trim()}`);
    for (const card of cards) {
      const walk = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      for (let text = walk.nextNode(); text; text = walk.nextNode()) {
        const holder = text.parentElement;
        if (!text.textContent.trim() || holder.closest("[data-t], .sr-only, .sg-more-line, #settings-trunk-pick, #settings-person-pick, .settings-trunks-status")) continue;
        bare.push(text.textContent.trim());
      }
    }
    return { wrong, bare, parts: Object.entries(fr).filter(([key]) => key.startsWith("trunks.part.")).map(([, words]) => words) };
  });
  assert.deepEqual(words.wrong, []);
  assert.deepEqual(words.bare, []);
  assert.deepEqual(words.parts.filter((part) => /Tronc/.test(part)), [], "the product's name, Trunk, as the section heading says it");
  assert.deepEqual(errors, []);
});
