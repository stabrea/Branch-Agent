/* DG-077: a Gold achievement or better is the approved sample's party card (design/Branch-Grown-Up.html, its live
   `celebrate`): "Gold achievement" as a copper eyebrow in capitals (11.5px, 0.06em apart), the name at 20px, the line
   under it at 13.5px in the second text colour, and "Lovely" as the sample's small quiet button, on a card with the
   sample's padding, corners, copper edge and shadow, sized to its words. It still sits over the conversation and
   never on the message box. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-achievement-party-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  return { page, errors };
}

const celebrate = (page, tier) => page.evaluate(async (rank) => (await import("/delight-achievements.js")).preview(rank), tier);
const measure = (page) => page.evaluate(() => {
  const colour = (value) => { const probe = document.createElement("i"); probe.style.color = value; document.body.append(probe); const out = getComputedStyle(probe).color; probe.remove(); return out; };
  const shadow = (value) => { const probe = document.createElement("i"); probe.style.boxShadow = value; document.body.append(probe); const out = getComputedStyle(probe).boxShadow; probe.remove(); return out; };
  const card = document.querySelector(".ach-party .ach-card"), style = getComputedStyle(card), box = card.getBoundingClientRect();
  const type = (node) => { const c = getComputedStyle(node); return { size: c.fontSize, spacing: c.letterSpacing, transform: c.textTransform, colour: c.color }; };
  const button = card.querySelector("button"), b = getComputedStyle(button);
  const main = document.querySelector("main").getBoundingClientRect(), form = document.getElementById("chat-form")?.getBoundingClientRect();
  return {
    card: { padding: style.padding, radius: style.borderRadius, edge: style.borderTopColor === colour("var(--copper-edge)"), shadow: style.boxShadow === shadow("var(--card-shadow)") },
    eyebrow: { text: card.querySelector("small").textContent, ...type(card.querySelector("small")), copper: getComputedStyle(card.querySelector("small")).color === colour("var(--copper-text)") },
    name: getComputedStyle(card.querySelector("b")).fontSize,
    line: { size: getComputedStyle(card.querySelector(":scope > span")).fontSize, quiet: getComputedStyle(card.querySelector(":scope > span")).color === colour("var(--text-2)") },
    button: { words: button.textContent, height: button.getBoundingClientRect().height, size: b.fontSize, weight: b.fontWeight, radius: b.borderRadius, padding: b.padding, shadow: b.boxShadow },
    overConversation: Math.abs((box.left + box.right) / 2 - (main.left + main.right) / 2) <= 1,
    offMessageBox: !form || !form.height || box.bottom <= form.top || box.top >= form.bottom,
    inWindow: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
  };
});

for (const width of [1440, 400]) {
  test(`DG-077 at ${width} px a Gold achievement is the sample's party card, over the conversation and off the message box`, async (t) => {
    const { page, errors } = await fixture(t, width);
    await celebrate(page, "Gold");
    await page.locator(".ach-party .ach-card").waitFor();
    const seen = await measure(page);
    assert.deepEqual(seen.card, { padding: "24px 28px", radius: "22px", edge: true, shadow: true });
    assert.deepEqual(seen.eyebrow, { text: "Gold achievement", size: "11.5px", spacing: "0.69px", transform: "uppercase", colour: seen.eyebrow.colour, copper: true });
    assert.equal(seen.name, "20px");
    assert.deepEqual(seen.line, { size: "13.5px", quiet: true });
    assert.deepEqual(seen.button, { words: "Lovely", height: 30, size: "12.5px", weight: "540", radius: "9px", padding: "0px 11px", shadow: "none" });
    assert.deepEqual({ over: seen.overConversation, off: seen.offMessageBox, inside: seen.inWindow }, { over: true, off: true, inside: true });
    assert.deepEqual(errors, []);
  });
}

test("DG-077 the tier's words follow the language, and the highest tier is the same card", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await celebrate(page, "SSS+");
  await page.locator(".ach-party .ach-card").waitFor();
  const seen = await measure(page);
  const french = await page.evaluate(async () => (await import("/i18n.js")).t("delight.ach.earned", { tier: "SSS+" }));
  assert.equal(seen.eyebrow.text, french);
  assert.equal(seen.eyebrow.transform, "uppercase");
  assert.equal(seen.button.words, await page.evaluate(async () => (await import("/i18n.js")).t("delight.ach.lovely")));
  assert.deepEqual(errors, []);
});
