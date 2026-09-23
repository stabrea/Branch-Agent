/**
 * FQ-collaboration: a comment pinned to a moment in a media file, reopened at the same position.
 *
 * There is no video player screen in the app (no page anywhere renders a `<video>` element — see
 * the audit note in `src/media-comments.ts` and `public/media-comments.js`), so these tests cover
 * the two things that do exist: the owner API (add + list) and the small seek hook a future player
 * would call. The seek hook is exercised against a real `<video>` element loaded with a tiny
 * generated clip, headless, since Chromium can decode it fine from a data URL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { MediaCommentSchema } from "../dist/media-comments.js";

const here = dirname(fileURLToPath(import.meta.url));

async function fixture(t) {
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "media-comments-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, options = {}) => fetch(new URL(path, server.url), {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${server.token}`, ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  return { app, server, call };
}

test("a comment added at 12.5s on a video file is returned by the list, in order", async (t) => {
  const { call } = await fixture(t);
  const added = await call("/api/media-comments", { body: { fileId: "videos/clip.mp4", atSeconds: 12.5, text: "the turn happens here" } });
  assert.equal(added.status, 200);
  assert.equal(added.body.atSeconds, 12.5);
  assert.equal(added.body.fileId, "videos/clip.mp4");
  assert.equal(added.body.text, "the turn happens here");
  assert.ok(added.body.id && added.body.createdAt);

  // A second comment, earlier in the file, to check the list comes back ordered by moment, not by
  // when it was written.
  await call("/api/media-comments", { body: { fileId: "videos/clip.mp4", atSeconds: 2, text: "intro" } });
  const listed = await call("/api/media-comments?fileId=" + encodeURIComponent("videos/clip.mp4"));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.comments.map((c) => c.atSeconds), [2, 12.5]);
  assert.equal(listed.body.comments[1].text, "the turn happens here");

  // A different file's list stays empty: comments belong to the file they were left on.
  const other = await call("/api/media-comments?fileId=" + encodeURIComponent("videos/other.mp4"));
  assert.deepEqual(other.body.comments, []);
});

test("a negative time is rejected over the API; NaN is rejected by the schema JSON cannot carry", async (t) => {
  const { call } = await fixture(t);
  const negative = await call("/api/media-comments", { body: { fileId: "videos/clip.mp4", atSeconds: -1, text: "before the file starts" } });
  assert.equal(negative.status, 400);
  assert.match(negative.body.error, />=\s*0|too small/i);

  const empty = await call("/api/media-comments", { body: { fileId: "videos/clip.mp4", atSeconds: 0, text: "" } });
  assert.equal(empty.status, 400, "an empty comment is rejected too");

  // JSON has no NaN literal, so a NaN atSeconds can never actually arrive over HTTP as valid JSON;
  // the schema itself is what has to refuse it. `z.number()` treats NaN as the wrong type outright.
  assert.equal(MediaCommentSchema.safeParse({ fileId: "f", atSeconds: NaN, text: "x" }).success, false);
  assert.equal(MediaCommentSchema.safeParse({ fileId: "f", atSeconds: Infinity, text: "x" }).success, false);
  assert.equal(MediaCommentSchema.safeParse({ fileId: "f", atSeconds: 12.5, text: "x" }).success, true);

  const listed = await call("/api/media-comments?fileId=" + encodeURIComponent("videos/clip.mp4"));
  assert.deepEqual(listed.body.comments, [], "neither rejected write made it into the list");
});

test("clicking a comment's timestamp seeks the video to that position (the future player's hook)", async (t) => {
  const { call, server } = await fixture(t);
  await call("/api/media-comments", { body: { fileId: "videos/clip.mp4", atSeconds: 12.5, text: "the turn happens here" } });

  const clip = await readFile(join(here, "fixtures", "tiny-video.mp4"));
  const clipBase64 = clip.toString("base64");

  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 30000 });

  // No screen in the app builds this markup today (that is the gap this test names); it is built
  // here, in the page, purely as the harness a future video-player screen would provide, so the
  // seek hook in public/media-comments.js is exercised against a real <video> element.
  await page.evaluate(async (base64) => {
    // The page's CSP allows media from 'self' and blob:, not data:, so the clip is turned into a
    // blob URL here rather than loaded as a data: URL.
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
    const video = document.createElement("video");
    video.id = "media-comments-test-video";
    video.src = blobUrl;
    document.body.append(video);
    await new Promise((resolve, reject) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener("error", () => reject(new Error("video failed to load")), { once: true });
      setTimeout(() => reject(new Error("video load timed out")), 10000);
    });
    const container = document.createElement("div");
    container.id = "media-comments-test-list";
    document.body.append(container);
    const mod = await import("/media-comments.js");
    const comments = await mod.listMediaComments("videos/clip.mp4");
    mod.renderMediaComments(container, comments, video);
  }, clipBase64);

  const readyState = await page.locator("#media-comments-test-video").evaluate((v) => v.readyState);
  const button = page.locator("#media-comments-test-list .media-comments-time");
  assert.equal(await button.textContent(), "0:13"); // formatTimestamp rounds 12.5 -> 13s
  await button.click();

  if (readyState >= 1) {
    // HAVE_METADATA or better: the browser actually decoded the clip, so the seek is real.
    await page.waitForFunction(() => {
      const v = document.getElementById("media-comments-test-video");
      return Math.abs(v.currentTime - 12.5) < 0.5;
    }, undefined, { timeout: 5000 });
    const currentTime = await page.locator("#media-comments-test-video").evaluate((v) => v.currentTime);
    assert.ok(Math.abs(currentTime - 12.5) < 0.5, `expected currentTime near 12.5, got ${currentTime}`);
  } else {
    // Named per the task's own fallback: Chromium could not decode the tiny clip in this
    // environment, so only the seek call itself (button carries the right target) is checked.
    console.log("media-comments.test.mjs: video did not reach HAVE_METADATA; checking the seek call, not playback");
    assert.equal(await button.getAttribute("data-at-seconds"), "12.5");
  }
  assert.deepEqual(errors, []);
});
