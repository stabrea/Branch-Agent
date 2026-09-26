/**
 * Q253: the live streams follow who is at the window. /api/events/stream and /api/runs/:id/stream check whose
 * events they are when they open; this proves they keep to it while open. A stream the owner's window opened
 * ends once the window is switched to a household profile, before any of the owner's later events is sent, and
 * a reconnect shows the new person's own. Nothing reaches a provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-stream-profile-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const headers = { authorization: "Bearer " + server.token, "content-type": "application/json" };
  /** Opens a stream and gathers what it sends, until it ends by itself or `ms` pass. */
  const open = (path, ms = 4000) => {
    const controller = new AbortController();
    const done = (async () => {
      const response = await fetch(server.url + path, { headers, signal: controller.signal });
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let text = "";
      try { for (;;) { const { done: finished, value } = await reader.read(); if (finished) break; text += decoder.decode(value, { stream: true }); } } catch { /* aborted */ }
      return text;
    })();
    const timer = setTimeout(() => controller.abort(), ms);
    return done.finally(() => clearTimeout(timer));
  };
  const switchTo = async () => {
    const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
    app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  };
  return { app, open, switchTo };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Q253 the owner's event stream ends when the window is switched to a household profile, before any later owner event", async (t) => {
  const { app, open, switchTo } = await served(t);
  const stream = open("/api/events/stream?maxMs=5000");
  await wait(700);
  await switchTo();
  // The owner's own work goes on after the switch (a schedule, a task left running).
  const run = app.store.createRun(app.runtime.owner, "owner's background task");
  app.store.event(run.id, "run.started", { prompt: "OWNER PRIVATE plan" });
  const text = await stream;
  assert.doesNotMatch(text, /OWNER PRIVATE/, "nothing of the owner's reaches a stream once the window is someone else's");
  assert.match(text, /event: end/, "the stream ends by itself, so the window reconnects as the person now at it");
});

test("Q253 a run's own stream ends when the window is switched to someone whose run it is not", async (t) => {
  const { app, open, switchTo } = await served(t);
  const run = app.store.createRun(app.runtime.owner, "owner's task");
  const stream = open(`/api/runs/${run.id}/stream`);
  await wait(600);
  await switchTo();
  app.store.event(run.id, "tool.started", { name: "files.read", path: "OWNER PRIVATE.txt" });
  const text = await stream;
  assert.doesNotMatch(text, /OWNER PRIVATE/);
  assert.match(text, /event: end\ndata: \{"status":"switched"\}/);
});

test("Q253 while the window stays the owner's, the owner's stream carries the owner's events as before", async (t) => {
  const { app, open } = await served(t);
  const stream = open("/api/events/stream?maxMs=2500");
  await wait(600);
  const run = app.store.createRun(app.runtime.owner, "owner's task");
  app.store.event(run.id, "run.started", { prompt: "the owner's own plan" });
  assert.match(await stream, /the owner's own plan/);
});
