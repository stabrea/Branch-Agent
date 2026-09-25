/* DG-169: a three-way that a module builds as a plain select is drawn as the approved sample's segmented control
   (design/Branch-Grown-Up.html, `invControlHTML`: three buttons, Off · When needed · On). The select stays underneath
   as the control's source, so pressing a segment saves the real setting through the module's own code, and what
   was saved comes back pressed after a reload. It fits the window at 1440, 860 and 400 wide. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs";

async function signedIn(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-three-way-segments-"));
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

const segment = (page, id, value) => page.locator(`.segmented-control:has(> #${id}) .segmented-option[data-v="${value}"]`);
const state = (page, id) => page.evaluate((one) => {
  const source = document.getElementById(one), group = source.closest(".segmented-control");
  return { value: source.value, pressed: [...group.querySelectorAll(".segmented-option[aria-pressed=true]")].map((node) => node.dataset.v) };
}, id);
const saved = (page) => page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.startsWith("/api/"));

/* Three modules that build their own select: one saving on change, two with a Save button of their own. */
const SWITCHES = [
  { id: "security-audit-mode", page: "permissions" },
  { id: "context-switch-agents", page: "general", save: 'section:has(#context-switch-agents) > button[data-t="action.save"]' },
  { id: "goal-undo-snapshots", page: "data", save: "#goal-undo-form button:not([type=button])" },
];

test("DG-169 pressing a segment saves the real setting, and it comes back pressed after a reload", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  for (const one of SWITCHES) {
    await openSettings(page, one.page);
    assert.deepEqual((await state(page, one.id)).pressed.length, 1, `${one.id}: one position pressed`);
    const answer = one.save ? null : saved(page);
    await segment(page, one.id, "when-needed").click();
    assert.deepEqual(await state(page, one.id), { value: "when-needed", pressed: ["when-needed"] }, `${one.id}: the press moves the value`);
    if (one.save) { const done = saved(page); await page.locator(one.save).click(); assert.equal((await done).ok(), true); }
    else assert.equal((await answer).ok(), true, `${one.id}: saved`);
  }
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  for (const one of SWITCHES) {
    await openSettings(page, one.page);
    await page.waitForFunction((id) => document.getElementById(id)?.value === "when-needed", one.id, { timeout: 10000 }).catch(() => undefined);
    assert.deepEqual(await state(page, one.id), { value: "when-needed", pressed: ["when-needed"] }, `${one.id}: saved and shown after a reload`);
  }
  assert.deepEqual(errors, []);
});

for (const width of [1440, 860, 400]) {
  test(`DG-169 at ${width} px the dressed three-ways fit their card and answer a press`, async (t) => {
    const { page, errors } = await signedIn(t, width);
    await openSettings(page, "permissions");
    const fits = await page.evaluate(() => [...document.querySelectorAll(".segmented-control[data-dressed]")].filter((group) => group.checkVisibility())
      .map((group) => {
        const box = group.getBoundingClientRect(), card = group.closest("section, .card, [id$='-card']").getBoundingClientRect();
        return { id: group.querySelector(".segmented-source").id, inside: box.left >= card.left - 0.5 && box.right <= card.right + 0.5, words: group.querySelectorAll(".segmented-option").length };
      }));
    assert.ok(fits.length >= 2, `the security check's switches show (${fits.map((one) => one.id).join(", ")})`);
    for (const one of fits) assert.deepEqual(one, { id: one.id, inside: true, words: 3 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1), "nothing scrolls sideways");
    const answer = saved(page);
    await segment(page, "security-malware-mode", "on").click();
    assert.equal((await answer).ok(), true);
    assert.deepEqual(await state(page, "security-malware-mode"), { value: "on", pressed: ["on"] });
    assert.deepEqual(errors, []);
  });
}

test("DG-169 a module that swaps its select for a new one gets one control, not a second inside the first", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  await openSettings(page, "permissions");
  const after = await page.evaluate(async () => {
    const old = document.getElementById("security-audit-mode"), fresh = document.createElement("select");
    for (const value of ["off", "on", "when-needed"]) fresh.append(Object.assign(document.createElement("option"), { value, textContent: value }));
    fresh.value = "on";
    old.replaceWith(fresh);
    fresh.id = "security-audit-mode";
    await new Promise((done) => requestAnimationFrame(() => setTimeout(done, 50)));
    const groups = document.querySelectorAll(".segmented-control:has(#security-audit-mode)");
    return { groups: groups.length, nested: document.querySelectorAll(".segmented-control .segmented-control").length,
      segments: [...groups].at(-1)?.querySelectorAll(":scope > .segmented-option").length, pressed: [...groups].at(-1)?.querySelector("[aria-pressed=true]")?.dataset.v };
  });
  assert.deepEqual(after, { groups: 1, nested: 0, segments: 3, pressed: "on" });
  assert.deepEqual(errors, []);
});

test("DG-169 a switched-off source dims its segments, and a press on one changes nothing", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  await openSettings(page, "permissions");
  await page.evaluate(() => { document.getElementById("security-malware-mode").disabled = true; });
  const before = await state(page, "security-malware-mode");
  const look = await segment(page, "security-malware-mode", "on").evaluate((node) => ({ opacity: getComputedStyle(node).opacity, cursor: getComputedStyle(node).cursor }));
  assert.deepEqual(look, { opacity: "0.45", cursor: "not-allowed" });
  await segment(page, "security-malware-mode", before.value === "on" ? "off" : "on").click();
  assert.deepEqual(await state(page, "security-malware-mode"), before);
  assert.deepEqual(errors, []);
});
