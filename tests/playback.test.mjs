import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { writeWav } from "../dist/media-audio.js";

/** FQ-surfaces.playback: an attached sound or video file plays inline in the conversation client,
 *  instead of only being turned into words (audio) or still pictures (video) — see public/playback.js. */

/** One second of silence at 8 kHz, mono, 16-bit, so nothing here depends on a real recording. */
const silentWav = () => writeWav({ channels: 1, sampleRate: 8000, bitsPerSample: 16, blockAlign: 2 }, Buffer.alloc(16000));

/** One second of a 32x32 VP8 WebM (770 bytes, made with ffmpeg's lavfi colour source). VP8 because the
 *  Chromium Playwright ships cannot play H.264, so an MP4 would never load its metadata here. */
const clipWebm = () => readFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "clip.webm"));
/** A 1x1 PNG, so a message can carry a picture beside its sound. */
const dotPng = () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

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

/** Sends what is in the message box and waits until the conversation has been redrawn from what the
 *  server saved: only a redrawn user message carries "Branch from here", the one drawn at send does not. */
async function sendAndAwaitRedraw(page, words, userMessages) {
  await page.fill("#prompt", words);
  await page.click("#send");
  await page.waitForFunction((count) => document.querySelectorAll(".message.user .message-controls .conversation-switch").length === count
    && !document.getElementById("send")?.disabled, userMessages, { timeout: 120000 });
}
async function attachSound(page) {
  await page.setInputFiles("#composer-media-file", { name: "note.wav", mimeType: "audio/wav", buffer: silentWav() });
  await page.waitForSelector("#composer-clips .clip-chip audio");
}
async function startPage(t) {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  return { page, errors: await openWorkspace(t, page, server) };
}
/** True once a <video> has loaded its metadata and knows a real, finite length. */
const videoReady = (sel) => {
  const video = document.querySelector(sel);
  return Boolean(video && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0);
};

test("an attached video file gets a working <video> player, on the message box and in the sent message after it is redrawn", async (t) => {
  const { page, errors } = await startPage(t);
  await page.setInputFiles("#composer-media-file", { name: "clip.webm", mimeType: "video/webm", buffer: await clipWebm() });
  await page.waitForFunction(videoReady, "#composer-clips .clip-chip video", { timeout: 60000 });

  await sendAndAwaitRedraw(page, "here is a clip", 1);
  await page.waitForFunction(videoReady, ".message.user .message-clips video", { timeout: 60000 });
  const duration = await page.evaluate(() => document.querySelector(".message.user .message-clips video").duration);
  assert.ok(Math.abs(duration - 1) < 0.2, `the player knows the clip is about one second long (was ${duration})`);
  assert.equal(await page.locator(".message.user .message-clips audio").count(), 0, "a video gets a video player, not a sound one");
  assert.deepEqual(errors, []);
});

test("a message that carried a picture and a sound keeps its player after the conversation is redrawn from what was saved", async (t) => {
  const { page, errors } = await startPage(t);
  await page.setInputFiles("#composer-media-file", { name: "dot.png", mimeType: "image/png", buffer: dotPng() });
  await page.waitForSelector("#composer-attachments img");
  await attachSound(page);

  // The server saves these words with "[attached picture: dot.png]" after them (src/runtime.ts picturesNote).
  await sendAndAwaitRedraw(page, "a picture and a note", 1);
  assert.match(await page.locator(".message.user").first().innerText(), /attached picture/, "this is the redrawn, saved message");
  assert.equal(await page.locator(".message.user .message-clips audio").count(), 1, "the redrawn message still carries its player");
  assert.deepEqual(errors, []);
});

test("a later message with the same words but no file gets no player, in the same conversation or a new one", async (t) => {
  const { page, errors } = await startPage(t);
  await attachSound(page);
  await sendAndAwaitRedraw(page, "same words", 1);
  assert.equal(await page.locator(".message.user .message-clips audio").count(), 1);

  await sendAndAwaitRedraw(page, "same words", 2);
  assert.equal(await page.locator(".message.user .message-clips").count(), 1, "only the message that carried the file plays it");
  assert.equal(await page.locator(".message.user").first().locator(".message-clips audio").count(), 1, "and it is the first one");

  await page.locator("#rail-new").click();
  await page.waitForFunction(() => document.querySelectorAll("#conversation .message").length === 0);
  await sendAndAwaitRedraw(page, "same words", 1);
  assert.equal(await page.locator(".message-clips").count(), 0, "another conversation never shows this one's clip");
  assert.deepEqual(errors, []);
});

test("a clip sent into a conversation whose messages were never drawn here is not handed to an older message", async (t) => {
  const { page, errors } = await startPage(t);
  // The first send's redraw fails, so this page never learns which messages that conversation already has
  // (public/app.js keeps going: "New messages will continue this saved conversation").
  let failed = false;
  await page.route(/\/api\/sessions\/[0-9a-f-]{36}$/, (route) => {
    if (failed || route.request().method() !== "GET") return route.continue();
    failed = true;
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "not now" }) });
  });
  await page.fill("#prompt", "first, with no file");
  await page.click("#send");
  await page.waitForFunction(() => document.getElementById("session-context")?.textContent.includes("could not be loaded")
    && !document.getElementById("send")?.disabled, undefined, { timeout: 120000 });

  await attachSound(page);
  await sendAndAwaitRedraw(page, "second, with a note", 2);
  const first = page.locator(".message.user").filter({ hasText: "first, with no file" });
  assert.equal(await first.locator(".message-clips").count(), 0, "the older message never takes a clip it did not carry");
  assert.deepEqual(errors, []);
});
