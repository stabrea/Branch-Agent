/**
 * Trunk voice: each Trunk speaks in its own voice, or the owner's if empty.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveVoiceSettings } from "../dist/voice.js";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";
import { brain, call, fixture, on } from "./trunks-helpers.mjs";

test("voice schema: trimmed, max 80 chars, with default empty", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const trunk = app.trunks.create({ name: "Va" });
  assert.equal(trunk.voice, "", "defaults to empty string");

  const withVoice = app.trunks.edit(trunk.id, { voice: "  British Female  " });
  assert.equal(withVoice.voice, "British Female", "trimmed");

  assert.throws(
    () => app.trunks.edit(trunk.id, { voice: "x".repeat(81) }),
    /voice/,
    "rejects >80 chars"
  );

  assert.doesNotThrow(() => {
    app.trunks.edit(trunk.id, { voice: "x".repeat(80) });
  }, "accepts exactly 80 chars");

  await app.trunks.introduced();
});

test("voice travels in export and import; empty voice is preserved", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const vb = app.trunks.create({ name: "Vb", title: "Speaker" });

  // Export with default (empty) voice
  const fileDefault = app.trunks.exportFile(vb.id);
  assert.equal(fileDefault.trunk.voice, "", "empty voice exported");

  // Add voice and export
  app.trunks.edit(vb.id, { voice: "Deep Male" });
  const fileWithVoice = app.trunks.exportFile(vb.id);
  assert.equal(fileWithVoice.trunk.voice, "Deep Male", "voice exported");

  // Import file with voice
  const imported = app.trunks.importFile(fileWithVoice);
  assert.equal(imported.voice, "Deep Male", "voice imported");
  assert.equal(imported.id !== vb.id, true, "imported has new id");

  // Import file with empty voice
  const importedDefault = app.trunks.importFile(fileDefault);
  assert.equal(importedDefault.voice, "", "empty voice imported");

  await app.trunks.introduced();
});

test("TrunkBrief includes voice", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const vc = app.trunks.create({ name: "Vc" });
  app.trunks.edit(vc.id, { voice: "English Female" });

  const roster = app.trunks.roster();
  const brief = roster.trunks.find((t) => t.id === vc.id);
  assert.equal(brief.voice, "English Female", "TrunkBrief has voice");
  assert.equal(typeof brief.voice, "string");

  await app.trunks.introduced();
});

test("voice in conversation info: /api/trunks/conversations includes Trunk voice", async (t) => {
  const { app, root } = await fixture(t);
  on(app, "conversations");

  const ve = app.trunks.create({ name: "Ve" });
  app.trunks.edit(ve.id, { voice: "Australian" });
  await app.trunks.introduced();

  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());

  const ask = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };

  // Start a conversation with the Trunk
  const convResult = await ask("/api/trunks/conversations", { trunkId: ve.id });
  const sessionId = convResult.body.sessionId;

  // Fetch conversation info
  const infoResult = await ask(`/api/trunks/conversations/${sessionId}`);
  assert.equal(infoResult.status, 200, "conversation info retrieved");
  assert.equal(infoResult.body.trunk.voice, "Australian", "voice in TrunkBrief");
});

test("in the window: a Trunk's answer is read in its voice, chosen in the studio; any other answer in yours", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-trunk-voice-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: brain([]) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  on(app);
  saveVoiceSettings(app.store, app.runtime.owner, { autoReadAloud: true, useProviderVoice: true });
  const ada = app.trunks.create({ name: "Ada" });
  await app.trunks.introduced();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Nothing is heard: the sound is handed back and never played.
  await page.addInitScript(() => { HTMLMediaElement.prototype.play = () => Promise.resolve(); });
  const spoken = [];
  await page.route("**/api/voice/speak", async (route) => {
    spoken.push(JSON.parse(route.request().postData() ?? "{}"));
    await route.fulfill({ status: 200, contentType: "audio/mpeg", body: Buffer.from([0xff, 0xf3]) });
  });
  await page.goto(server.url + "/");
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });

  // The studio: a Voice field with its own sentence, from your list, saved with the Trunk.
  await openPlace(page, "customize:specialists");
  await page.getByRole("button", { name: "Edit Trunk" }).click();
  const picker = page.locator("#trunks-edit-voice");
  await picker.waitFor();
  assert.equal(await picker.inputValue(), "", "a Trunk starts in your own voice");
  assert.match(await page.locator(`#${await picker.getAttribute("aria-describedby")}`).innerText(), /reads its answers in/);
  await picker.evaluate((node) => node.append(Object.assign(document.createElement("option"), { value: "Test Voice", textContent: "Test Voice" })));
  await picker.selectOption("Test Voice");
  // Hear it reads a sample in the chosen voice, the way answers are read.
  await page.getByRole("button", { name: "Hear it" }).click();
  for (let i = 0; i < 50 && !spoken.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(spoken.at(-1)?.voice, "Test Voice", "Hear it uses the chosen voice");
  assert.match(spoken.at(-1)?.text ?? "", /this is how I sound/);
  spoken.length = 0;
  await page.getByRole("button", { name: "Save changes" }).click();
  for (let i = 0; i < 50 && app.trunks.records.list().find((one) => one.id === ada.id)?.voice !== "Test Voice"; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.trunks.records.list().find((one) => one.id === ada.id).voice, "Test Voice");

  // Its conversation is read in its voice.
  await page.getByRole("button", { name: "Talk" }).first().click();
  await page.waitForFunction(() => document.getElementById("rail-target-name")?.textContent === "Ada");
  await page.locator("#prompt").fill("Say hello");
  await page.locator("#prompt").press("Enter");
  for (let i = 0; i < 100 && !spoken.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(spoken.at(-1)?.voice, "Test Voice", "the Trunk's own voice");
  // Pressing Read aloud on the answer, and hold-to-talk, go through the same reading: its voice too.
  const manual = spoken.length;
  await page.getByRole("button", { name: "Read aloud" }).last().click();
  for (let i = 0; i < 50 && spoken.length === manual; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(spoken.at(-1)?.voice, "Test Voice", "Read aloud uses the Trunk's voice");

  // A conversation that is not a Trunk's is read in yours: no voice is sent, so Settings › Voice decides.
  await page.locator("#rail-new").click();
  await page.waitForFunction(() => !document.getElementById("conversation")?.dataset.sessionId);
  const before = spoken.length;
  await page.locator("#prompt").fill("Say hello again");
  await page.locator("#prompt").press("Enter");
  for (let i = 0; i < 100 && spoken.length === before; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(spoken.at(-1)?.voice, undefined, "your own voice");
  const plain = spoken.length;
  await page.getByRole("button", { name: "Read aloud" }).last().click();
  for (let i = 0; i < 50 && spoken.length === plain; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(spoken.at(-1)?.voice, undefined, "and Read aloud there uses yours");
  assert.deepEqual(errors, []);
});

test("a Trunk saved before voices existed reads as your own voice everywhere the window looks", async (t) => {
  const { app, root } = await fixture(t);
  on(app, "conversations");
  const old = app.trunks.create({ name: "Old" });
  await app.trunks.introduced();
  // Saved as a Trunk from before this change was: no voice at all.
  const key = `trunk:${old.id}`;
  const { voice: _gone, ...legacy } = app.store.get("governance", app.runtime.owner, key).data;
  app.store.save("governance", app.runtime.owner, key, legacy);
  assert.equal("voice" in app.store.get("governance", app.runtime.owner, key).data, false);
  assert.equal(app.trunks.roster().trunks.find((one) => one.id === old.id).voice, "", "the roster");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const ask = async (path, body) => (await fetch(server.url + path, { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  const { sessionId } = await ask("/api/trunks/conversations", { trunkId: old.id });
  assert.equal((await ask(`/api/trunks/conversations/${sessionId}`)).trunk.voice, "", "the conversation");
  assert.equal(app.trunks.exportFile(old.id).trunk.voice, "", "the Trunk's file");
});
