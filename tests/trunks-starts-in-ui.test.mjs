/* Q44 (DG-107): the studio's "Starts in", headless on 127.0.0.1. It lists This computer and the owner's
   paired computers only (never a phone, never a made-up one), saves the choice, says plainly that
   Branch cannot start a Trunk there yet, and is in French too. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const scripted = { name: "scripted", async complete() { return { content: "Here it is.", toolCalls: [] }; } };
const tower = "a1b2c3d4e5f60718";
const device = (id, name, platform) => ({ id, name, platform, publicKey: "k".repeat(44), pairedAt: "2026-09-23T00:00:00.000Z",
  lastSeen: null, offers: [], enabled: [], folder: null, sharedWith: [] });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-starts-in-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  app.store.save("settings", app.runtime.owner, "devices-book", { mode: "on", requests: [],
    devices: [device(tower, "Tower", "linux"), device("0f1e2d3c4b5a6978", "Pixel", "android")] });
  assert.equal(app.devices.book.devices().length, 2);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const { trunk } = await call("/api/trunks", { name: "Scout", title: "Watches prices", description: "" });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#trunk-strip .strip-brand").waitFor({ state: "visible", timeout: 120000 });
  const raw = (path, body) => fetch(new URL(path, server.url), { method: "POST", body: JSON.stringify(body),
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { call, raw, page, errors, trunk };
}
const options = (page) => page.locator("#studio-starts-in option").evaluateAll((all) => all.map((o) => [o.value, o.textContent]));
async function openChange(f) {
  await f.page.evaluate((id) => import("/studio.js").then((studio) => studio.openEdit(id)), f.trunk.id);
  await f.page.locator("#studio-starts-in").waitFor();
}

test("Starts in lists This computer and the paired computers only, and saves the choice", async (t) => {
  const f = await fixture(t);
  await openChange(f);
  const dialog = f.page.locator("#studio");
  assert.deepEqual(await options(f.page), [["", "This computer"], [tower, "Tower"]], "no phone and nothing made up");
  const label = dialog.locator("label.studio-field", { has: f.page.locator("#studio-starts-in") });
  assert.equal(await label.locator("span").first().textContent(), "Starts in");
  const what = await dialog.locator("#studio-what").boundingBox(), select = await dialog.locator("#studio-starts-in").boundingBox();
  assert.ok(select.y > what.y, "it sits under what the Trunk does, as the sample has it");
  await dialog.getByLabel("Starts in").selectOption(tower);
  await dialog.getByText("Branch cannot start a Trunk on another computer yet").waitFor();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal((await f.call(`/api/trunks/${f.trunk.id}`)).trunk.startsIn, tower);
  await openChange(f);
  assert.equal(await f.page.locator("#studio-starts-in").inputValue(), tower, "it opens on the saved choice");
  await f.page.locator("#studio-name").fill("Scout Two");
  await f.page.getByRole("button", { name: "Save", exact: true }).click();
  await f.page.locator("#studio").waitFor({ state: "detached" });
  assert.equal((await f.call(`/api/trunks/${f.trunk.id}`)).trunk.startsIn, tower, "a rename keeps where it starts");
  const sent = await f.raw("/api/run", { prompt: "hello", sessionId: f.trunk.chatSessionId });
  assert.ok(sent.status >= 400 && sent.status < 500, `the window is refused, not run here (${sent.status})`);
  assert.match(JSON.stringify(sent.body), /starts on Tower/, "in the plain words the owner can act on");
  assert.deepEqual(f.errors, []);
});

test("Add a Trunk: choosing another computer saves it and never claims it introduced itself", async (t) => {
  const f = await fixture(t);
  await f.page.locator("#trunk-strip .strip-add").click();
  const dialog = f.page.locator("#studio");
  await dialog.locator("#studio-name").fill("Gardener");
  assert.deepEqual(await options(f.page), [["", "This computer"], [tower, "Tower"]]);
  await dialog.getByLabel("Starts in").selectOption(tower);
  assert.match(await dialog.locator("#studio-foot-note").textContent(), /cannot introduce itself/);
  await dialog.getByRole("button", { name: "Create the Trunk", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const toast = await f.page.locator("#toast").textContent();
  assert.match(toast, /starts on Tower/);
  assert.doesNotMatch(toast, /introduces itself/);
  const made = (await f.call("/api/trunks")).trunks.find((one) => one.name === "Gardener");
  assert.equal(made.startsIn, tower, "made with where it starts, so even its first turn is not run here");
  assert.deepEqual(f.errors, []);
});

test("in French the control and its choices follow", async (t) => {
  const f = await fixture(t);
  await openChange(f);
  await f.page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await f.page.locator("#studio-starts-in option", { hasText: "Cet ordinateur" }).waitFor({ state: "attached" });
  assert.deepEqual(await options(f.page), [["", "Cet ordinateur"], [tower, "Tower"]]);
  assert.equal(await f.page.locator("label.studio-field", { has: f.page.locator("#studio-starts-in") }).locator("span").first().textContent(), "Démarre sur");
});
