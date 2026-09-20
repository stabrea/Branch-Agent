import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/**
 * The question, asked of trunk as it stands: the window redraws itself every 3 seconds, and six bugs
 * in this programme have come from that redraw destroying what the person was doing. Does it destroy
 * what they are TYPING?
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "probe-composer-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); await server.close(); await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.keyboard.press("Enter").catch(() => {});
  await page.waitForTimeout(1500);
  return page;
}

test("a half-typed sentence survives the 3-second redraw", async (t) => {
  const page = await fixture(t);
  const box = page.locator(".composer textarea, form.composer textarea").locator("visible=true").first();
  await box.waitFor({ state: "visible", timeout: 30000 });
  await box.click();
  const typed = "Compare the three supplier quotes and flag delivery";
  await page.keyboard.type(typed, { delay: 8 });

  // Put the caret in the middle and select a word, as a person revising a sentence would.
  const before = await page.evaluate(() => {
    const t = [...document.querySelectorAll("textarea")].find((e) => e.offsetParent !== null);
    t.setSelectionRange(8, 16);
    return { value: t.value, start: t.selectionStart, end: t.selectionEnd, focused: document.activeElement === t };
  });

  await page.waitForTimeout(7000); // at least two redraws

  const after = await page.evaluate(() => {
    const t = [...document.querySelectorAll("textarea")].find((e) => e.offsetParent !== null);
    return { value: t.value, start: t.selectionStart, end: t.selectionEnd, focused: document.activeElement === t };
  });

  console.log("BEFORE", JSON.stringify(before));
  console.log("AFTER ", JSON.stringify(after));
  assert.equal(after.value, before.value, "the typing was changed by a redraw");
  assert.equal(after.start, before.start, "the caret moved");
  assert.equal(after.end, before.end, "the selection was lost");
  assert.equal(after.focused, true, "focus was thrown out of the message box");
});

test("how tall the message box is, and whether Send stays on its line", async (t) => {
  const page = await fixture(t);
  await page.locator(".composer textarea, form.composer textarea").locator("visible=true").first().waitFor({ state: "visible", timeout: 30000 });
  for (const [w, h] of [[1440, 950], [1024, 700], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    const shape = await page.evaluate(() => {
      const form = document.querySelector("form.composer") || document.querySelector(".composer");
      if (!form) return null;
      const r = form.getBoundingClientRect();
      const kids = [...form.children].map((c) => c.getBoundingClientRect()).filter((b) => b.width || b.height);
      const rows = new Set(kids.map((b) => Math.round(b.top)));
      return { height: Math.round(r.height), children: kids.length, rows: rows.size };
    });
    console.log(`${w}x${h}`, JSON.stringify(shape));
  }
  assert.ok(true, "measurement only");
});
