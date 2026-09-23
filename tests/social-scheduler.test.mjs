import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { SocialScheduler } from "../dist/social-scheduler.js";
import { handlesSocialPath, socialApi } from "../dist/social-api.js";

/** A workspace, a private data directory and a Branch, all thrown away when the test ends. */
async function fixture(t) {
  const scratch = join(tmpdir(), "claude-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-social-scheduler-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

test("a scheduled post sits in the approval queue and is never sent until the owner says yes", async (t) => {
  const app = await fixture(t);
  const sent = [];
  const deliver = async (channel, chatId, text, key) => { sent.push({ channel, chatId, text, key }); return { messageId: `msg-${sent.length}` }; };
  const social = new SocialScheduler(app.store, deliver);
  const owner = app.runtime.owner;

  const past = new Date(Date.now() - 60000).toISOString();
  const post = social.prepare(owner, { platform: "bluesky", target: "feed", text: "Hello, Bluesky", scheduledFor: past });
  assert.equal(post.status, "queued");
  assert.equal(social.list(owner).length, 1);

  // The scheduled time has already come, but nobody has authorized it: sweep sends nothing.
  assert.deepEqual(social.due(owner), []);
  assert.deepEqual(await social.sweep(owner), []);
  assert.equal(sent.length, 0, "an unauthorized post must never reach the channel");
  await assert.rejects(() => social.publish(owner, post.id), /approved/);

  // The owner's yes: because the post's time has already come, approving sends it right away.
  const approved = await social.approve(owner, post.id);
  assert.equal(approved.status, "posted");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { channel: "bluesky", chatId: "feed", text: "Hello, Bluesky", key: `social:${post.id}` });
  assert.equal(social.list(owner)[0].messageId, "msg-1");

  // Approving twice, or rejecting an already-sent post, is refused rather than sending it again.
  await assert.rejects(() => social.approve(owner, post.id), /already posted/);
  assert.throws(() => social.reject(owner, post.id), /already posted/);
});

test("a post scheduled for later stays approved-but-unsent until its time comes, and sweep finds it then", async (t) => {
  const app = await fixture(t);
  const sent = [];
  const deliver = async (channel, chatId, text, key) => { sent.push({ channel, chatId, text, key }); return {}; };
  const social = new SocialScheduler(app.store, deliver);
  const owner = app.runtime.owner;

  const future = new Date(Date.now() + 3600000).toISOString();
  const post = social.prepare(owner, { platform: "mastodon", text: "Not yet", scheduledFor: future });
  const approved = await social.approve(owner, post.id, new Date());
  assert.equal(approved.status, "approved", "authorized ahead of time still waits for its scheduled time");
  assert.equal(sent.length, 0);
  assert.deepEqual(social.due(owner, new Date()), []);

  const later = new Date(Date.now() + 3600001);
  const delivered = await social.sweep(owner, later);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].status, "posted");
  assert.equal(sent.length, 1);
});

test("rejecting a queued post keeps it out of the queue for good, even after its scheduled time passes", async (t) => {
  const app = await fixture(t);
  const social = new SocialScheduler(app.store, async () => { throw new Error("must not be called"); });
  const owner = app.runtime.owner;

  const past = new Date(Date.now() - 1000).toISOString();
  const post = social.prepare(owner, { platform: "bluesky", text: "Never mind", scheduledFor: past });
  const rejected = social.reject(owner, post.id);
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(await social.sweep(owner), []);
  assert.equal(social.list(owner)[0].status, "rejected");
});

test("the /api/social/posts routes prepare, list, approve and reject through the queue", async (t) => {
  const app = await fixture(t);
  const owner = app.runtime.owner;
  assert.equal(handlesSocialPath("/api/social/posts"), true);
  assert.equal(handlesSocialPath("/api/unrelated"), false);

  const post = (path, jsonBody) => socialApi(app.social, owner, {
    method: "POST", headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(jsonBody)); },
  }, path);
  const get = (path) => socialApi(app.social, owner, { method: "GET", headers: {} }, path);

  const created = await post("/api/social/posts", { platform: "bluesky", target: "feed", text: "Queued from the API" });
  assert.equal(created.status, "queued");

  const listed = await get("/api/social/posts");
  assert.equal(listed.posts.length, 1);
  assert.equal(listed.posts[0].id, created.id);

  const rejected = await post(`/api/social/posts/${created.id}/reject`, {});
  assert.equal(rejected.status, "rejected");
});
