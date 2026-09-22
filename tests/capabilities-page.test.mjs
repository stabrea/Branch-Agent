/**
 * Owner item 17, slice 3: Settings › Capabilities. Every switchable capability as one on/off switch,
 * grouped, with the Tool loading switch and what switching it off would cost at the top. Stored values
 * are kept as they were (no migration): on writes "when needed", off writes "off", and a record
 * already "on" keeps it. Lockdown keeps what it covers off; a short-lived key changes nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace, openSettings } from "./places.mjs";
import { readFile } from "node:fs/promises";
import { toolFeatures } from "../dist/feature-switches.js";
import { slots } from "../dist/context-files.js";
import { labelKeyOf } from "../dist/capabilities-table.js";
import { trunkMode } from "../dist/trunks/settings.js";
import { capabilitiesRoute } from "../dist/capabilities.js";

/** Every parts module, read from its own lists: each part is a capability the page must show. */
const partsModules = await Promise.all([
  ["trunks", "trunkParts", "trunkKey"], ["interop", "interopParts", "interopKey"], ["asks", "askParts", "askKey"],
  ["autonomy", "autonomyParts", "autonomyKey"], ["coding", "codingParts", "codingKey"], ["personal", "personalParts", "personalKey"],
  ["reach", "reachParts", "reachKey"], ["safety-extras", "safetyParts", "safetyKey"], ["flows-boards", "boardParts", "boardKey"],
  ["learning-more", "learningParts", "learningKey"], ["add-ons", "addOnParts", null],
].map(async ([dir, parts, key]) => {
  const module = await import(`../dist/${dir}/settings.js`);
  return module[parts].map((part) => (key ? module[key](part) : `add-ons:${part}`));
}));
const LOCALES = join(import.meta.dirname, "..", "public", "locales");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-capabilities-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (body, key = server.token) => {
    const response = await fetch(server.url + "/api/capabilities", { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, server, call, owner: app.runtime.owner };
}
const row = (view, key) => view.rows.find((entry) => entry.key === key);

test("every switch is one row, and switching writes the three-way value without migrating anything", async (t) => {
  const { app, call, owner } = await fixture(t);
  const view = (await call()).body;
  assert.equal(view.toolLoading.mode, "deferred");
  assert.deepEqual(row(view, "web-pages"), { key: "web-pages", label: "Reading and crawling web pages", labelKey: "capabilities.label.web-pages", group: "research", on: false, always: false, tools: 2, locked: false });
  assert.equal((await call({ key: "web-pages", on: true })).body.on, true);
  assert.equal(app.store.get("settings", owner, "web-pages").data.mode, "when-needed", "on writes when needed");
  await call({ key: "web-pages", on: false });
  assert.equal(app.store.get("settings", owner, "web-pages").data.mode, "off");
  // A record saved as "on" before this page keeps it, and says it is always loaded.
  app.store.save("settings", owner, "troubleshoot", { mode: "on" });
  assert.deepEqual([row((await call()).body, "troubleshoot").on, row((await call()).body, "troubleshoot").always], [true, true]);
  await call({ key: "troubleshoot", on: true });
  assert.equal(app.store.get("settings", owner, "troubleshoot").data.mode, "on", "switching on again keeps a legacy on");
  // A field inside a bigger record, and the context files.
  await call({ key: "voice#systemVoice", on: true });
  assert.equal(app.store.get("settings", owner, "voice").data.systemVoice, "when-needed");
  await call({ key: "context-files:agents", on: true });
  assert.equal(app.store.get("settings", owner, "context-files").data.files.agents, "when-needed");
  assert.equal((await call({ key: "made-up", on: true })).status, 400);
});

test("the page shows every capability it promises, each once and nothing else, named in every language", async (t) => {
  const { call } = await fixture(t);
  const keys = (await call()).body.rows.map((entry) => entry.key);
  const promised = new Set([
    ...partsModules.flat(), // every part of every parts module, tool-less ones too (Trunks itself, Rooms …)
    ...toolFeatures.map((feature) => (feature.field && feature.field !== "mode" ? `${feature.key}#${feature.field}` : feature.key)),
    ...slots.map((slot) => `context-files:${slot.key}`),
  ]);
  assert.equal(keys.length, new Set(keys).size, "each once");
  assert.deepEqual([...keys].sort(), [...promised].sort(), "exactly what is promised");
  for (const must of ["trunks-trunks", "trunks-rooms", "trunks-routines", "trunks-teach", "trunks-conversations", "autonomy-session-commands"])
    assert.ok(keys.includes(must), `${must} is on the page`);
  for (const language of ["en", "fr"]) {
    const words = JSON.parse(await readFile(join(LOCALES, `${language}.json`), "utf8"));
    const missing = keys.map(labelKeyOf).filter((key) => !words[key]);
    assert.deepEqual(missing, [], `every capability is named in ${language}`);
  }
});

test("on a fresh install, switching on a Trunks part from the page makes it work, Trunks included", async (t) => {
  const { app, call, owner } = await fixture(t);
  const before = row((await call()).body, "trunks-messages");
  assert.deepEqual(before.needs, { key: "trunks-trunks", labelKey: "capabilities.label.trunks-trunks" }, "it says what it needs");
  const after = (await call({ key: "trunks-messages", on: true })).body;
  assert.equal(after.on, true, "the row reads on");
  assert.equal(after.needs, undefined);
  assert.notEqual(trunkMode(app.store, owner, "messages"), "off", "and it is in effect");
  assert.notEqual(trunkMode(app.store, owner, "trunks"), "off", "because Trunks itself was switched on too");
  // Trunks switched off: the part reads off where it is used and on the page, and keeps what it was set to.
  await call({ key: "trunks-trunks", on: false });
  const orphan = row((await call()).body, "trunks-messages");
  assert.deepEqual([orphan.on, orphan.needs?.key], [false, "trunks-trunks"]);
  assert.equal(trunkMode(app.store, owner, "messages"), "off");
  assert.equal(app.store.get("settings", owner, "trunks-messages").data.mode, "when-needed", "its own choice is kept");
});

test("switching from this page takes effect at once: the tool appears, goes, and switching off cleans up", async (t) => {
  const { app, call } = await fixture(t);
  const cancelled = [];
  const cancel = app.autonomy.runner.cancel.bind(app.autonomy.runner);
  app.autonomy.runner.cancel = (...args) => { cancelled.push(true); return cancel(...args); };
  assert.equal(app.registry.names().includes("orders.list"), false, "off as it ships");
  assert.equal((await call({ key: "autonomy-orders", on: true })).body.on, true);
  assert.equal(app.registry.names().includes("orders.list"), true, "its tool is in the running registry, no restart");
  await call({ key: "autonomy-orders", on: false });
  assert.equal(app.registry.names().includes("orders.list"), false, "and gone again");
  assert.deepEqual(cancelled, [true], "switching off ran the module's own cleanup");
});

test("a part that needs Trunks switches Trunks on through Trunks' own setter, and its tool appears", async (t) => {
  const { app, call } = await fixture(t);
  const calls = [];
  const setMode = app.trunks.setMode.bind(app.trunks);
  app.trunks.setMode = (part, input) => { calls.push([part, input.mode]); return setMode(part, input); };
  await call({ key: "trunks-messages", on: true });
  assert.deepEqual(calls, [["trunks", "when-needed"], ["messages", "when-needed"]], "the root first, by its own setter");
  assert.equal(app.registry.names().includes("trunk.message"), true);
});

test("Lockdown keeps what it covers off, and a short-lived key changes nothing", async (t) => {
  const { app, call, owner } = await fixture(t);
  app.store.save("settings", owner, "lockdown", { on: true });
  const screen = row((await call()).body, "desktop-control");
  assert.deepEqual([screen.on, screen.locked], [false, true]);
  assert.equal((await call({ key: "desktop-control", on: true })).status, 400);
  assert.ok(row((await call()).body, "web-pages").locked === false, "what Lockdown does not cover stays switchable");
  const key = app.sessionTokens.create(owner, { name: "phone", scope: "run" }).token;
  assert.ok([401, 403].includes((await call({ key: "web-pages", on: true }, key)).status));
  assert.ok([401, 403].includes((await call(undefined, key)).status), "nor read the page");
  assert.equal(app.store.get("settings", owner, "web-pages")?.data?.mode ?? "off", "off");
});

test("a household profile can neither read nor switch what the assistant can do", async (t) => {
  const { app, call, owner } = await fixture(t);
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  assert.notEqual((await call()).status, 200);
  assert.notEqual((await call({ key: "web-pages", on: true })).status, 200);
  // The route's own guard (it names itself) is what stays if the outer table is ever refactored.
  for (const method of ["GET", "POST"])
    await assert.rejects(capabilitiesRoute(app.store, owner, app, method, async () => ({ key: "web-pages", on: true }), () => null),
      /^Error: What the assistant can do belongs to the owner/);
  assert.equal(app.store.get("settings", owner, "web-pages")?.data?.mode ?? "off", "off", "nothing changed");
});

test("the Capabilities page shows the Tool loading switch with its cost, and a switch that saves", async (t) => {
  const { chromium } = await import("playwright");
  const { app, server, owner } = await fixture(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await openSettings(page, "capabilities");
  const loading = page.locator("#lx-page-capabilities #capabilities-loading");
  await loading.waitFor();
  assert.equal(await page.getByRole("switch", { name: "Load tools only when a task needs them" }).isChecked(), true, "Tool loading ships on");
  assert.match(await loading.innerText(), /Nothing with tools is switched on yet|Off would load/);
  const web = page.locator('#lx-page-capabilities [data-key="web-pages"] input[role="switch"]');
  await web.check();
  for (let i = 0; i < 50 && app.store.get("settings", owner, "web-pages")?.data?.mode !== "when-needed"; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.store.get("settings", owner, "web-pages").data.mode, "when-needed");
  await page.waitForFunction(() => /Off would load \d+ tools/.test(document.querySelector("#capabilities-loading")?.innerText ?? ""));
  await page.getByRole("switch", { name: "Load tools only when a task needs them" }).uncheck();
  for (let i = 0; i < 50 && app.store.get("settings", owner, "tool-loading")?.data?.mode !== "eager"; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.store.get("settings", owner, "tool-loading").data.mode, "eager");
  // In French the capabilities are named in French, not only the words around them.
  const fr = JSON.parse(await readFile(join(LOCALES, "fr.json"), "utf8"));
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openSettings(page, "capabilities");
  const rooms = page.locator('#lx-page-capabilities [data-key="trunks-rooms"] label');
  await page.waitForFunction((words) => document.querySelector('#lx-page-capabilities [data-key="trunks-rooms"] label')?.textContent === words, fr["capabilities.label.trunks-rooms"]);
  assert.notEqual(await rooms.textContent(), "Rooms where Trunks talk together");
  assert.match(await page.locator('#lx-page-capabilities [data-key="trunks-rooms"] + p').innerText(), new RegExp(fr["capabilities.row.no-tools"].slice(0, 20)));
  assert.deepEqual(errors, []);
});
