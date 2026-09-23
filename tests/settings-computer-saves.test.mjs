/**
 * Settings › Computer & browser, after DG-008 and DG-025.
 * DG-008: every card's title is an h3.settings-card-title under its section's h3, never an h2, and looks as it did;
 * a part inside a card is an h4. DG-025: the page saves as you go, as the sample does. A choice saves when it is
 * picked and a box when you leave it; no Save button is left. What stays is an action (Add, Try, Check, Put back),
 * and a certificate, whose name and text go together, waits for its Add. A refused value says why and is not kept.
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
import { wallSettings } from "../dist/sandbox.js";

/** The cards of the page and their titles, in page order, at Technical. */
const TITLES = [
  ["desktop-card", "Using your screen and keyboard"], ["screen-switch-card", "How Branch uses your screen"],
  ["reach-background-card", "Using apps in the background"], ["reach-usb-card", "Starting a task when a USB device is plugged in"],
  ["os-permissions-card", "What this computer allows"], ["sandbox-card", "Where scripts run"],
  ["os-sandbox-card", "The wall around programs"], ["knobs-commands-card", "How commands run"],
  ["firewall-card", "What can reach out"], ["knobs-launch-file-card", "Settings from the launch file"],
  ["browser-card", "Websites you stay signed in to"], ["comfort-browser-card", "How carefully the browser acts"],
  ["remote-card", "Your other computers"], ["asks-nodes-card", "Other computers running Branch"],
  ["reach-machines-card", "Other computers side by side"], ["comfort-network-card", "Proxy and trusted certificates"],
];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-computer-saves-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", body: JSON.stringify({ done: true }), headers });
  const get = (path) => fetch(new URL(path, server.url), { headers }).then((response) => response.json());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
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
  await page.locator('.lx-settings-link[data-page="computer"]').click();
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical"));
  for (const [id] of TITLES) await page.locator(`#${id} > :is(h2, h3)`).first().waitFor({ state: "attached", timeout: 30000 });
  return { app, page, errors, get };
}

/** Waits until the saved answer says so. */
async function until(page, read, want, what) {
  let got;
  for (let i = 0; i < 100; i++) { got = await read(); if (want(got)) return got; await page.waitForTimeout(50); }
  assert.fail(`${what}: ${JSON.stringify(got)}`);
}

test("DG-008: Computer & browser card titles are h3 under the section's h3, in English and French", async (t) => {
  const { page, errors } = await fixture(t);
  const heads = () => page.evaluate(() => [...document.querySelectorAll("#lx-page-computer > .card")]
    .filter((card) => card.querySelector(":scope > .settings-card-title"))
    .map((card) => [card.id, card.querySelector(":scope > .settings-card-title").textContent.trim()]));
  assert.deepEqual(await heads(), TITLES);
  const shape = await page.evaluate(() => [...document.querySelectorAll("#lx-page-computer > .card")].map((card) => {
    const title = card.querySelector(":scope > .settings-card-title");
    const css = title && getComputedStyle(title);
    return { id: card.id, h2: card.querySelectorAll("h2").length, title: title?.tagName,
      look: css && [css.fontSize, css.fontWeight, css.lineHeight, css.margin].join(" "),
      parts: [...card.querySelectorAll("h3:not(.settings-card-title), h4")].filter((node) => !node.closest(".item, .card .card"))
        .map((node) => `${node.tagName}.${node.className}`) };
  }).filter((one) => one.title || one.h2));
  for (const one of shape) {
    assert.equal(one.h2, 0, `${one.id} has no h2 under the section's h3`);
    assert.equal(one.title, "H3", `${one.id}'s title is an h3`);
    assert.equal(one.look, "16px 640 20.8px 0px 0px 6px", `${one.id}'s title looks as the card titles do`);
    for (const part of one.parts) assert.equal(part, "H4.settings-card-subtitle", `${one.id}: a part of a card is an h4`);
  }
  assert.deepEqual(shape.find((one) => one.id === "browser-card").parts, ["H4.settings-card-subtitle"]);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.querySelector("#asks-nodes-card > h3.settings-card-title")?.textContent !== "Other computers running Branch");
  assert.equal(await page.locator("#lx-page-computer > .card h2").count(), 0, "still no h2 in French");
  assert.equal(await page.locator("#os-sandbox-card > h3.settings-card-title").textContent(), "Le mur autour des programmes");
  assert.deepEqual(errors, []);
});

test("DG-025: Computer & browser saves as you go, with no Save button, and says why a value is refused", async (t) => {
  const { app, page, errors, get } = await fixture(t);
  const saves = await page.locator("#lx-page-computer button").evaluateAll((buttons) => buttons
    .map((button) => button.textContent.trim()).filter((words) => /^(Save|Enregistrer)\b/.test(words) && words !== "Save for the next start"));
  assert.deepEqual(saves, [], "no Save button on the page");

  /* A choice saves when it is picked. */
  await page.locator("#screen-switch-card-mode").selectOption("on");
  await until(page, () => get("/api/desktop/settings"), (s) => s.mode === "on", "the screen switch");
  /* The wall's switch is pressed as a person presses it: its "When needed" part. */
  await page.locator("#os-sandbox-card .segmented-option[data-v=\"when-needed\"]").click();
  await until(page, async () => wallSettings(app.store, app.runtime.owner), (s) => s.mode === "when-needed", "the wall");
  await page.locator("#comfort-confirmSensitive").selectOption("on");
  await until(page, () => get("/api/comfort"), (v) => v.values.browser.confirmSensitive === true, "the careful browser");
  await page.locator("#knobs-keptOpenShell").selectOption("off");
  await until(page, () => get("/api/knobs"), (v) => v.values.commands.keptOpenShell === false, "how commands run");

  /* A box saves when you leave it, and you stay where you moved to. */
  await page.locator("#os-sandbox-keys").fill("GITHUB_TOKEN api.github.com");
  await page.locator("#os-sandbox-keys").press("Tab");
  await until(page, async () => wallSettings(app.store, app.runtime.owner), (s) => s.keySites.GITHUB_TOKEN === "api.github.com", "the wall's keys");
  await page.locator("#comfort-proxy").fill("http://proxy.example:8080");
  await page.locator("#comfort-proxy").press("Tab");
  await until(page, () => get("/api/comfort"), (v) => v.values.network.proxy === "http://proxy.example:8080", "the proxy");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "comfort-noProxy", "the next box keeps you after the card is drawn again");
  await page.locator("#knobs-commandTimeoutSeconds").fill("45");
  await page.locator("#knobs-commandTimeoutSeconds").press("Tab");
  await until(page, () => get("/api/knobs"), (v) => v.values.commands.commandTimeoutSeconds === 45, "the command time limit");
  await page.locator("#asks-nodes-list").fill("studio | Studio | https://studio.example | STUDIO_KEY | mac");
  await page.locator("#asks-nodes-list").press("Tab");
  await until(page, () => get("/api/asks/nodes"), (v) => v.nodes[0]?.id === "studio", "the other computers");
  await page.locator("#reach-machine-name").fill("desk");
  await page.locator("#reach-machine-name").press("Tab");
  await until(page, () => get("/api/reach"), (v) => v.machineName === "desk", "this computer's name");

  /* A refused value says why, and what was kept stays. */
  await page.locator("#reach-machine-name").fill("Not A Name!");
  await page.locator("#reach-machine-name").press("Tab");
  await page.waitForFunction(() => !/^(Saved\.)?$/.test(document.querySelector("#reach-machines-card [role=status]")?.textContent ?? ""));
  assert.equal((await get("/api/reach")).machineName, "desk");

  /* A certificate waits for its Add: typing its name alone saves nothing. */
  const before = (await get("/api/comfort")).values.network.caCertificates.length;
  await page.locator("#comfort-caCertificates-name").fill("office");
  await page.locator("#comfort-caCertificates-name").press("Tab");
  await page.waitForTimeout(300);
  assert.equal((await get("/api/comfort")).values.network.caCertificates.length, before, "a name alone is not saved");
  assert.equal(await page.getByRole("button", { name: "Add this certificate" }).count(), 1);
  assert.deepEqual(errors, []);
});
