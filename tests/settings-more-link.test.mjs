/* DG-073: "N more with Advanced" is the approved sample's link at the end of its section (design/Branch-Grown-Up.html,
   the live `cardHTML` override's `.bk-lv .linkish`): after the section's last card on show, left-aligned, 14px at the
   body's weight, copper and underlined. A section that shows nothing keeps it in its head. It still changes the level,
   and search never finds a card by the link's own words. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function settings(t, page = "general") {
  const root = await mkdtemp(join(tmpdir(), "branch-more-link-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const tab = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.goto(server.url);
  await tab.getByLabel("Session token", { exact: true }).fill(server.token);
  await tab.getByRole("button", { name: "Connect", exact: true }).click();
  await tab.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await tab.locator("body.sg-ready").waitFor();
  /* Opened as a person opens it, not through the test helper that also shows every card of the page. */
  await tab.keyboard.press("ControlOrMeta+Comma");
  await tab.locator("#settings-window").waitFor({ state: "visible" });
  await tab.locator(`.lx-settings-link[data-page="${page}"]`).click();
  await tab.evaluate(() => globalThis.branchSettingsLevel.set("regular"));
  await settled(tab);
  return { page: tab, errors };
}

/** Waits until Settings stops changing (a level change moves many cards at once), or fails if it never does. */
async function settled(page) {
  const quiet = await page.evaluate(() => new Promise((done) => {
    let last = Date.now();
    const watch = new MutationObserver(() => { last = Date.now(); });
    watch.observe(document.getElementById("lx-settings-body"), { childList: true, subtree: true });
    const started = Date.now();
    const tick = setInterval(() => {
      if (Date.now() - last >= 500) { clearInterval(tick); watch.disconnect(); done(true); }
      else if (Date.now() - started > 8000) { clearInterval(tick); watch.disconnect(); done(false); }
    }, 50);
  }));
  if (!quiet) throw new Error("Settings kept changing for 8 s: something keeps moving");
}

/** Every "N more" link on show: where it sits, how it looks, and the section it ends. */
const links = (page) => page.evaluate(() => {
  const probe = document.createElement("i");
  probe.style.color = "var(--copper-text)";
  document.body.append(probe);
  const copper = getComputedStyle(probe).color;
  probe.remove();
  return [...document.querySelectorAll(".sg-more-line")].filter((line) => line.checkVisibility()).map((line) => {
    const more = line.querySelector(".sg-more"), style = getComputedStyle(more), box = more.getBoundingClientRect();
    const head = document.querySelector(`.sg-head[data-bucket="${line.dataset.bucket}"]`);
    const cards = head.dataset.cards.split(" ").filter(Boolean).map((id) => document.getElementById(id)).filter((card) => card?.checkVisibility());
    const holder = line.parentElement, others = [...holder.children].filter((child) => child !== line && child.checkVisibility());
    return {
      bucket: line.dataset.bucket, words: more.textContent, inHead: holder === head,
      endsSection: cards.length ? holder === cards.at(-1) && holder.lastElementChild === line : holder === head,
      below: others.every((child) => child.getBoundingClientRect().bottom <= box.top + 0.5),
      indent: box.left - holder.getBoundingClientRect().left,
      look: { size: style.fontSize, weight: style.fontWeight, line: style.lineHeight, underline: style.textDecorationLine, copper: style.color === copper },
    };
  });
});

test("DG-073 each section's \"N more\" link ends the section, in the sample's link style", async (t) => {
  const { page, errors } = await settings(t);
  const seen = await links(page);
  const ending = seen.filter((link) => !link.inHead);
  assert.ok(ending.length >= 1, `at least one section ends with its link (${seen.map((l) => l.bucket).join(", ")})`);
  for (const link of seen) {
    assert.equal(link.endsSection, true, `${link.bucket}: the link is the last thing in its section`);
    assert.match(link.words, /^\d+ more with (Advanced|Technical)$/);
    assert.deepEqual(link.look, { size: "14px", weight: "400", line: "21.7px", underline: "underline", copper: true }, `${link.bucket}: the sample's link`);
  }
  for (const link of ending) {
    assert.equal(link.below, true, `${link.bucket}: under everything else in the card`);
    assert.ok(link.indent < 40, `${link.bucket}: at the start of the line, not pushed right (${link.indent}px in)`);
  }
  /* It still changes the level, and the section's hidden cards show. */
  await page.locator('.sg-more-line[data-bucket="general:start"] .sg-more').click();
  await page.waitForFunction(() => document.documentElement.dataset.settingsLevel === "advanced");
  assert.equal(await page.locator("#never-break-card").isVisible(), true);
  assert.deepEqual(errors, []);
});

test("DG-073 a section with nothing on show keeps its link in its head, and Under the hood has none", async (t) => {
  const { page, errors } = await settings(t, "data");
  /* The sample's rule (DG-199): a section whose rows all wait keeps "Show N" in its head; Under the hood has no head,
     and no line, until something in it shows. Every page is looked at, so the rule holds wherever a thin section is. */
  const pages = await page.evaluate(() => [...document.querySelectorAll(".lx-settings-link[data-page]")].map((link) => link.dataset.page));
  let thinSeen = 0;
  for (const name of pages) {
    await page.evaluate((one) => globalThis.branchLayout.go(`settings:${one}`), name);
    await settled(page);
    const seen = await links(page);
    const heads = await page.evaluate(() => [...document.querySelectorAll(".sg-head")].filter((head) => head.checkVisibility())
      .map((head) => ({ bucket: head.dataset.bucket, thin: head.classList.contains("sg-thin") })));
    assert.deepEqual(heads.filter((head) => head.bucket.endsWith(":under")), [], `${name}: no Under the hood at Regular`);
    for (const { bucket } of heads.filter((head) => head.thin)) {
      thinSeen += 1;
      const link = seen.find((one) => one.bucket === bucket);
      assert.ok(link, `${bucket}: its link shows`);
      assert.equal(link.inHead, true, `${bucket}: in the head, as the sample's thin section`);
    }
  }
  t.diagnostic(`thin sections seen at Regular: ${thinSeen}`);
  assert.deepEqual(errors, []);
});

test("DG-073 search never finds a card by the link's words, and the link steps aside while searching", async (t) => {
  const { page, errors } = await settings(t);
  await page.locator("#lx-settings-search").fill("more with advanced");
  await page.waitForFunction(() => document.body.classList.contains("lx-settings-searching"));
  const found = await page.evaluate(() => ({
    cards: [...document.querySelectorAll(".lx-page:not([hidden]) :is(.lx-subpanel > *, .lx-page > *)")]
      .filter((card) => card.querySelector(".sg-more-line") && !card.classList.contains("lx-miss")).map((card) => card.id),
    linksShown: [...document.querySelectorAll(".sg-more-line")].filter((line) => line.checkVisibility()).length,
  }));
  assert.deepEqual(found.cards, [], "no card matches because of the link it carries");
  assert.equal(found.linksShown, 0, "every level shows while searching, so no link does");
  /* A card that carries a link, found by its own title: it shows, and its link still steps aside. */
  await page.locator("#lx-settings-search").fill("");
  await page.waitForFunction(() => !document.body.classList.contains("lx-settings-searching"));
  const holder = await page.evaluate(() => {
    const card = document.querySelector('.sg-more-line[data-bucket="general:start"]').parentElement;
    return { id: card.id, title: card.querySelector("h2, h3")?.textContent.trim() };
  });
  assert.ok(holder.title, "the card holding the link has a title");
  await page.locator("#lx-settings-search").fill(holder.title);
  await page.waitForFunction(() => document.body.classList.contains("lx-settings-searching"));
  const shown = await page.evaluate((id) => ({
    card: document.getElementById(id).checkVisibility(),
    link: document.getElementById(id).querySelector(".sg-more-line")?.checkVisibility() ?? false,
  }), holder.id);
  assert.deepEqual(shown, { card: true, link: false }, `${holder.id} is found by "${holder.title}", without its link`);
  assert.deepEqual(errors, []);
});

test("DG-073 the link and a card's \"Saved as\" line keep one order: the link last", async (t) => {
  const { page, errors } = await settings(t);
  const order = await page.evaluate(() => [...document.querySelectorAll(".sg-more-line")]
    .filter((line) => line.previousElementSibling?.matches(".sg-keys") || line.parentElement.querySelector(":scope > .sg-keys"))
    .map((line) => ({ last: line.parentElement.lastElementChild === line, keysBefore: line.previousElementSibling?.matches(".sg-keys") ?? false })));
  assert.ok(order.length >= 1, "a card carries both");
  assert.ok(order.every((one) => one.last && one.keysBefore), JSON.stringify(order));
  /* Settled: nothing keeps moving them (a tug of war would never stop changing the page). */
  await page.evaluate(() => globalThis.branchSettingsLevel.set("advanced"));
  await page.evaluate(() => globalThis.branchSettingsLevel.set("regular"));
  await settled(page);
  assert.deepEqual(errors, []);
});
