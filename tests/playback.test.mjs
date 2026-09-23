import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { writeWav } from "../dist/media-audio.js";

/** FQ-surfaces.playback: an attached sound or video file plays inline in the conversation client,
 *  instead of only being turned into words (audio) or still pictures (video) — see public/playback.js. */

/** One second of silence at 8 kHz, mono, 16-bit, so nothing here depends on a real recording. */
const silentWav = () => writeWav({ channels: 1, sampleRate: 8000, bitsPerSample: 16, blockAlign: 2 }, Buffer.alloc(16000));

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-playback-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Heard it.", toolCalls: [] }; } },
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}

async function openWorkspace(t, page, server) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return errors;
}

test("an attached sound file gets a playable chip on the message box, and it can be taken off again", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = await openWorkspace(t, page, server);

  await page.setInputFiles("#composer-media-file", { name: "note.wav", mimeType: "audio/wav", buffer: silentWav() });
  await page.waitForSelector("#composer-clips .clip-chip audio");
  assert.equal(await page.locator("#composer-clips .clip-chip").count(), 1);
  assert.equal(await page.locator("#composer-clips .clip-chip audio").getAttribute("src"), await page.evaluate(() => document.querySelector("#composer-clips audio").src));

  await page.click("#composer-clips .clip-chip button");
  assert.equal(await page.locator("#composer-clips .clip-chip").count(), 0, "the chip can be taken off again, same as a picture chip");
  assert.deepEqual(errors, []);
});

test("a sound file attached to a sent message plays inline in the conversation, next to the words it was turned into", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, permissions: [] });
  const errors = await openWorkspace(t, page, server);

  await page.setInputFiles("#composer-media-file", { name: "note.wav", mimeType: "audio/wav", buffer: silentWav() });
  await page.waitForSelector("#composer-clips .clip-chip audio");

  await page.fill("#prompt", "here is a note");
  await page.click("#send");
  await page.waitForSelector(".message.user .message-clips audio");
  assert.equal(await page.locator(".message.user .message-clips audio").count(), 1, "the message bubble itself carries the player");
  assert.equal(await page.locator("#composer-clips .clip-chip").count(), 0, "the composer chip is cleared once the file has moved into the sent message");
  assert.deepEqual(errors, []);
});
