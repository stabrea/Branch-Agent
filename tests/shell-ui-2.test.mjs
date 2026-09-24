/**
 * Wave 9 redesign and quality assurance — part 2 of 3
 * Q4 control naming and structure, command palette, Q5 focus and popovers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fixture, openScreen, SCREENS, SETTINGS_PAGES } from "./shell-ui-helpers.mjs";

test("Q4 every control that can be seen can also be named", async (t) => {
  const f = await fixture(t);
  for (const [view, holder] of SCREENS) {
    await openScreen(f.page, view);
    const nameless = await f.page.evaluate((id) => {
      const out = [];
      for (const node of document.getElementById(id).querySelectorAll("button, input, select, textarea")) {
        if (node.offsetParent === null) continue;
        const name = node.labels?.[0]?.textContent?.trim() || node.getAttribute("aria-label") ||
          document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() ||
          node.title || node.textContent.trim();
        if (!name) out.push(`${node.tagName.toLowerCase()}#${node.id || "(no id)"}`);
      }
      return out;
    }, holder);
    assert.deepEqual(nameless, [], `${view} has a control nothing can read out`);
  }
  assert.deepEqual(f.errors, []);
});

test("Q4 every screen calls the same thing by the same name", async (t) => {
  const f = await fixture(t);
  /* One name per idea. Each pattern is a word the owner should never have to meet on its own;
     the second half of each pair is what to say instead. See docs/design.md, "The glossary". */
  const banned = [
    [/\bSKILL\.md\b/, "the instructions"],
    [/\bAPI base URL\b/, "web address of the service"],
    [/\bendpoint\b/i, "web address"],
    [/\bpayload\b/i, "what is sent"],
    [/\bSSE\b/, "live updates"],
  ];
  for (const [view, holder] of SCREENS) {
    await openScreen(f.page, view);
    const words = await f.page.evaluate((id) => document.getElementById(id).innerText, holder);
    for (const [pattern, instead] of banned)
      assert.equal(pattern.test(words), false, `${view} still says ${pattern} where it should say "${instead}"`);
  }
  assert.deepEqual(f.errors, []);
});

test("a new screen that names its home with data-home is shown there, even when added later", async (t) => {
  const f = await fixture(t);
  await f.page.evaluate(() => {
    const card = document.createElement("section");
    card.className = "card";
    card.id = "home-probe";
    card.dataset.home = "settings:secrets";
    card.innerHTML = "<h2>Probe</h2><p>Lands on the Secrets page.</p>";
    document.getElementById("workspace").append(card);
    const local = document.createElement("section");
    local.id = "home-probe-local";
    local.dataset.home = "settings:models:local";
    document.body.append(local);
  });
  await f.page.waitForFunction(() => document.getElementById("home-probe").closest("#lx-page-secrets")
    && document.getElementById("home-probe-local").closest("#lx-models-local"));
  const { openSettingFor } = await import("./places.mjs");
  await openSettingFor(f.page, "#home-probe");
  await f.page.locator("#home-probe").waitFor({ state: "visible" });
  assert.deepEqual(f.errors, []);
});

test("the command palette jumps to a section and closes on Escape", async (t) => {
  const f = await fixture(t);
  await f.page.keyboard.press("Control+k");
  await f.page.locator("#cmd-input").waitFor({ state: "visible" });
  await f.page.locator("#cmd-input").fill("Schedu");
  await f.page.locator(".cmd-item").first().click();
  assert.match(await f.page.locator("#page-title").innerText(), /Automations/);
  assert.equal(await f.page.locator('.lx-tab[data-view="schedules"]').getAttribute("aria-selected"), "true");
  await f.page.keyboard.press("Control+k");
  await f.page.locator("#cmd-input").waitFor({ state: "visible" });
  await f.page.keyboard.press("Escape");
  await f.page.locator("#cmd-input").waitFor({ state: "hidden" });
  assert.deepEqual(f.errors, []);
});

test("Escape leaves the message box without throwing away what was typed", async (t) => {
  const f = await fixture(t);
  await f.page.locator("#prompt").fill("half a thought");
  await f.page.keyboard.press("Escape");
  assert.equal(await f.page.evaluate(() => document.activeElement?.id), "");
  assert.equal(await f.page.locator("#prompt").inputValue(), "half a thought");
  assert.deepEqual(f.errors, []);
});

test("Q5 the helper line and the room meter share one row, clear of the message box", async (t) => {
  const f = await fixture(t);
  await f.page.evaluate(() => document.getElementById("meter-row").hidden = false);
  const boxes = await f.page.evaluate(() => {
    const rect = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
    return { composer: rect(".composer"), foot: rect(".composer-foot"), meter: rect("#meter-row"), note: rect(".composer-foot .composer-note") };
  });
  assert.ok(boxes.foot.top >= boxes.composer.bottom - 1, "the quiet row still overlaps the message box");
  assert.ok(boxes.meter.left >= boxes.note.right - 1, "the meter and the helper line overlap each other");
  assert.deepEqual(f.errors, []);
});

test("Q5 focus can be seen, and stillness is honoured", async (t) => {
  const f = await fixture(t);
  /* The message box shows its focus as the sample's does (DG-175): the whole box takes the accent edge and ring,
     easing in over a moment, so it is read once it has arrived. */
  await f.page.evaluate(() => document.getElementById("prompt").focus());
  await f.page.waitForFunction(() => / 0px 0px 0px 3px\b/.test(` ${getComputedStyle(document.getElementById("chat-form")).boxShadow}`), null, { timeout: 3000 }).catch(() => undefined);
  const ring = await f.page.evaluate(() => {
    const box = getComputedStyle(document.getElementById("chat-form"));
    const probe = document.createElement("i");
    probe.style.color = "var(--copper)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { edge: box.borderTopColor === accent, ring: / 0px 0px 0px 3px\b/.test(` ${box.boxShadow}`) };
  });
  assert.deepEqual(ring, { edge: true, ring: true }, "a focused message box shows the accent edge and ring");

  /* "Keep things still" writes data-motion onto the page, and every move is then instant. */
  const still = await f.page.evaluate(() => {
    document.documentElement.dataset.motion = "reduced";
    const measured = getComputedStyle(document.getElementById("send")).transitionDuration;
    delete document.documentElement.dataset.motion;
    return measured;
  });
  assert.ok(Number.parseFloat(still) < 0.01,
    `movement is still ${still} long when the owner asked for stillness`);
  assert.deepEqual(f.errors, []);
});
