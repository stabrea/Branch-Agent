import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/*
 * Q65 review: zod 4's `.partial()` fills every field left out with its default, so a save that parsed the
 * patch that way and laid it over the saved record put the fields the window did not send back to how they
 * ship. Every such save now reads the patch through `optionalFields` (src/feature-switches.ts). Each window
 * route below is given a record with its other fields away from their defaults, is sent one field, and must
 * leave the others as they were.
 */

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-patch-routes-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(server.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, store: app.store, owner: app.runtime.owner, call };
}

/**
 * One row per route: the record it saves, what is there first (saved directly, or through the route when the
 * module keeps a copy in memory), the one field sent, and the fields that must be left as they were.
 */
const routes = [
  { path: "/api/shell-look", key: "shell-look", seed: { strip: "off", faces3d: "off" }, send: { faces3d: "on" }, keep: ["strip"] },
  { path: "/api/usage/glance/settings", key: "usage-glance", seed: { ring: "shown", saveProgress: "off" }, send: { ring: "hidden" }, keep: ["saveProgress"] },
  { path: "/api/browser/container", key: "browser-container", seed: { mode: "when-needed", where: "endpoint", endpoint: "wss://browser.example.com/" },
    send: { endpoint: "wss://other.example.com/" }, keep: ["mode", "where"] },
  { path: "/api/conversation-mode/settings", key: "conversation-mode-settings", seed: { newConversation: "follow" }, send: {}, keep: ["newConversation"] },
  { path: "/api/diagnostics/log/settings", key: "diagnostic-log", seed: { mode: "off", keepDays: 30, maxMegabytes: 50, crashCapture: "on" },
    send: { mode: "when-needed" }, keep: ["keepDays", "maxMegabytes", "crashCapture"] },
  { path: "/api/diagnostics/report/automatic", key: "automatic-problem-reports",
    seed: { mode: "off", destination: null, events: ["crash"], items: ["about"] }, send: { items: ["about", "log"] }, keep: ["events", "mode"] },
  { path: "/api/keychain/settings", key: "keychain-entries", seed: { enabled: true, mode: "on", entries: [] }, send: { entries: [] }, keep: ["mode", "enabled"] },
  { path: "/api/vault-autofill/settings", key: "vault-autofill", seed: { enabled: true, mode: "on", logins: [], timeoutMs: 5000 },
    send: { timeoutMs: 6000 }, keep: ["mode", "enabled"] },
  { path: "/api/desktop/settings", key: "desktop-control", seed: { enabled: true, mode: "on", maxActionsPerRun: 10 },
    send: { maxActionsPerRun: 12 }, keep: ["mode", "enabled"] },
  { path: "/api/approval-reviewer", key: "approval_reviewer", viaRoute: true,
    seed: { mode: "off", rules: "x", preset: "strict", maxTokens: 3000 }, send: { mode: "on" }, keep: ["rules", "preset", "maxTokens"] },
  { path: "/api/reflection/settings", key: "reflection", viaRoute: true,
    seed: { reflection: "off", everyTurns: 50, newSkills: "on", retireAfterDays: 90 }, send: { reflection: "on" }, keep: ["everyTurns", "newSkills", "retireAfterDays"] },
];

test("each window save changes only the field it was sent", async (t) => {
  const { store, owner, call } = await served(t);
  // One subtest each, so a route that loses a field is named on its own.
  for (const route of routes) await t.test(route.path, async () => {
    if (route.viaRoute) assert.equal((await call(route.path, route.seed)).status, 200, `${route.path}: the first save`);
    else store.save("settings", owner, route.key, route.seed);
    const answer = await call(route.path, route.send);
    assert.equal(answer.status, 200, `${route.path}: ${JSON.stringify(answer.body)}`);
    const saved = store.get("settings", owner, route.key)?.data ?? {};
    for (const [field, value] of Object.entries(route.send)) assert.deepEqual(saved[field], value, `${route.path}: ${field} is saved`);
    for (const field of route.keep) assert.deepEqual(saved[field], route.seed[field], `${route.path}: ${field} was not sent and must stay`);
  });
});

test("analytics: saving the address keeps the answer and the counts, and answering keeps the address", async (t) => {
  const { app, store, owner, call } = await served(t);
  store.save("settings", owner, "asks-analytics", { mode: "on" });
  const address = "https://collector.example.com/counts";
  assert.equal((await call("/api/asks/analytics", { consent: "yes" })).status, 200);
  assert.ok(app.asks.analytics.track("settings.opened"), "a count is kept once the owner said yes");
  assert.equal((await call("/api/asks/analytics", { sendTo: address })).status, 200);
  let seen = (await call("/api/asks/analytics")).body;
  assert.equal(seen.analytics.consent, "yes", "saving the address is not an answer to the question");
  assert.equal(seen.analytics.sendTo, address);
  assert.equal(seen.counts.length, 1, "and the counts are still there");
  assert.equal((await call("/api/asks/analytics", { consent: "yes" })).status, 200);
  seen = (await call("/api/asks/analytics")).body;
  assert.equal(seen.analytics.sendTo, address, "answering the question keeps the address");
});
