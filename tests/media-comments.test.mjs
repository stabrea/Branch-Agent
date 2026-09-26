/**
 * FQ-collaboration: a comment pinned to a moment in a media file, reopened at the same position.
 *
 * The owner API (add + list) is checked directly; the reopening itself is checked through the real
 * screen it was wired into — the Files browser's video player (public/code-editor.js), opened from
 * the workspace it already lists, headless, with a tiny generated clip Chromium can decode. See
 * tests/media-file.test.mjs for the bytes route that player opens (`/api/media-comments/media`),
 * checked apart from the browser because it is plain HTTP.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, options = {}) => fetch(new URL(path, server.url), {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${server.token}`, ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  return { app, server, call, workspace };
}

/** A conversation to open, so the side pane (and its Files tab) has something to sit beside. */
async function fixtureWithConversation(t) {
  const parts = await fixture(t);
  const run = parts.app.store.createRun(parts.app.runtime.owner, "Look at the clip");
  parts.app.store.message(run.sessionId, { role: "user", content: run.prompt });
  parts.app.store.message(run.sessionId, { role: "assistant", content: "Here it is." });
  return { ...parts, sessionId: run.sessionId };
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

test.skip("the Files browser opens a workspace video, and clicking a comment's timestamp reopens it there (bucket-18 + FQ-collaboration, end to end)", async (t) => {
  // Redesign: replaced by the new window (the side panel's Files tab lists the files a conversation touched, chat/pane.js;
  // prototype.html has no workspace browser, video player or comments on a moment in a media file).
  const { call, server, workspace, sessionId } = await fixtureWithConversation(t);
  await call("/api/workspace-editor/settings", { body: { mode: "on" } });
  await writeFile(join(workspace, "clip.mp4"), await readFile(join(here, "fixtures", "tiny-video.mp4")));
  await call("/api/media-comments", { body: { fileId: "clip.mp4", atSeconds: 12.5, text: "the turn happens here" } });

  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const httpCall = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await httpCall("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 30000 });
  await page.evaluate(async (id) => { const { openConversation } = await import("/app.js"); await openConversation(id); }, sessionId);
  await page.locator(".message.assistant").first().waitFor();

  // The real screen this was wired into: the side pane's Files tab (bucket-18), which now opens a
  // video as a player instead of refusing it, with this file's own comments listed beside it.
  await page.locator("#aside-toggle").click();
  await page.locator("#context-panel").waitFor({ state: "visible" });
  await page.locator('#context-panel .lx-pane-tab[data-pane="files"]').click();
  await page.locator("#wsedit summary").click();
  await page.locator("#wsedit-list .wsedit-entry", { hasText: "clip.mp4" }).click();

  const video = page.locator("#wsedit-media-video");
  await video.waitFor({ state: "visible", timeout: 30000 });
  const button = page.locator("#wsedit-media-comments .media-comments-time");
  assert.equal(await button.textContent(), "0:13"); // formatTimestamp rounds 12.5 -> 13s
  const readyState = await video.evaluate((v) => v.readyState);
  await button.click();

  if (readyState >= 1) {
    // HAVE_METADATA or better: the browser actually decoded the clip, so the seek is real.
    await page.waitForFunction(() => Math.abs(document.getElementById("wsedit-media-video").currentTime - 12.5) < 0.5,
      undefined, { timeout: 5000 });
    const currentTime = await video.evaluate((v) => v.currentTime);
    assert.ok(Math.abs(currentTime - 12.5) < 0.5, `expected currentTime near 12.5, got ${currentTime}`);
  } else {
    // Chromium could not decode the tiny clip in this environment; only the seek call itself
    // (the button carries the right target) is checked.
    console.log("media-comments.test.mjs: video did not reach HAVE_METADATA; checking the seek call, not playback");
    assert.equal(await button.getAttribute("data-at-seconds"), "12.5");
  }

  // Adding one from the player itself (at whatever moment it is paused at) reaches the same list a
  // reload would show — the other direction of "attach a comment to a video timestamp".
  await video.evaluate((v) => { v.currentTime = 3; });
  await page.locator("#wsedit-media-comment-text").fill("a second moment");
  await page.locator("#wsedit-media-comment-form button[type=submit]").click();
  await page.locator("#wsedit-media-comments .media-comments-time", { hasText: "0:03" }).waitFor({ timeout: 5000 });
  const listed = await call("/api/media-comments?fileId=clip.mp4");
  assert.deepEqual(listed.body.comments.map((c) => c.text), ["a second moment", "the turn happens here"]);

  assert.deepEqual(errors, []);
});
