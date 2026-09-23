import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, decideFolder, saveFolderTrustSettings } from "../dist/index.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";

/**
 * The integrations file named by BRANCH_INTEGRATIONS, when it sits in a workspace folder the owner
 * has not trusted: it may still add tools a task has to choose to call, but it may not change the
 * network rules or start chat apps. Each case gets an app of its own, because the network rules a
 * load sets stay set for the rest of that app's life.
 */
async function fixture(t, mode = "on") {
  const root = await mkdtemp(join(tmpdir(), "branch-integrations-trust-"));
  const workspace = join(root, "workspace"), dataDir = join(root, "data");
  await mkdir(workspace, { recursive: true });
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace, dataDir, provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveFolderTrustSettings(app.store, app.runtime.owner, { mode });
  return { app, root, workspace, dataDir, owner: app.runtime.owner };
}

async function place(path, config) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config));
  return path;
}

/** Loads a file with an empty environment, keeping what Branch said about folder trust. */
async function load(t, app, path) {
  const warned = [], original = console.warn;
  console.warn = (...parts) => warned.push(parts.join(" "));
  try {
    const loaded = await loadIntegrations(app.registry, path, {}, app.secretsFor, app.channelHost);
    t.after(() => loaded.close());
    return { loaded, trustNotes: warned.filter((line) => /not trusted/.test(line)) };
  } finally { console.warn = original; }
}

const privateAddress = new URL("http://127.0.0.1:9/");
const reachesPrivate = { web: { allowPrivateAddresses: true } };
// A chat app whose token is read from an environment variable that is never set, so building it
// fails loudly and nothing is ever sent anywhere.
const chatApp = { channels: [{ type: "telegram", tokenEnv: "BRANCH_TEST_UNSET_TOKEN" }] };
const startsPrograms = (root) => ({
  mcp: [{ id: "stranger", transport: "stdio", command: join(root, "no-such-server"), tools: ["x"], expectedVersion: "1" }],
  hooks: [{ id: "on-finish", event: "run.finished", executable: "nothing" }],
});

test("a file in a folder the owner has not trusted cannot open private addresses, and the owner is told once", async (t) => {
  const { app, root, workspace, owner } = await fixture(t);
  const file = await place(join(workspace, "cloned", "integrations.json"), { ...reachesPrivate, ...startsPrograms(root) });
  decideFolder(app.store, owner, workspace, { folder: "cloned", decision: "distrust" });
  const { loaded, trustNotes } = await load(t, app, file);
  assert.equal(loaded.count, 0);
  assert.equal(app.web.settings().allowPrivateAddresses, false, "the network rules keep their defaults");
  await assert.rejects(app.web.policy.assertAllowed(privateAddress), /private or local address/);
  assert.equal(trustNotes.length, 1, "one note covers everything that was left out");
  assert.match(trustNotes[0], /network settings/);
  assert.match(trustNotes[0], /AI tool servers/);
  assert.match(trustNotes[0], /hooks/);
  assert.ok(trustNotes[0].includes(file), "the note names the file");
});

test("chat apps in a file in a folder the owner has not decided about are not started", async (t) => {
  const { app, workspace } = await fixture(t);
  const file = await place(join(workspace, "cloned", "integrations.json"), chatApp);
  const { trustNotes } = await load(t, app, file);
  assert.deepEqual(app.channels.summary().channels, [], "no chat app was attached");
  assert.equal(trustNotes.length, 1);
  assert.match(trustNotes[0], /chat apps/);
});

test("the owner's own file in the data folder still sets the network rules and starts chat apps", async (t) => {
  const { app, dataDir } = await fixture(t);
  const { trustNotes } = await load(t, app, await place(join(dataDir, "integrations.json"), reachesPrivate));
  assert.equal(trustNotes.length, 0);
  await app.web.policy.assertAllowed(privateAddress);
  await assert.rejects(load(t, app, await place(join(dataDir, "chat.json"), chatApp)), /no bot token/,
    "the chat app is built as before");
});

test("a folder the owner trusts still sets the network rules and starts chat apps", async (t) => {
  const { app, workspace, owner } = await fixture(t);
  decideFolder(app.store, owner, workspace, { folder: "cloned", decision: "trust" });
  const { trustNotes } = await load(t, app, await place(join(workspace, "cloned", "integrations.json"), reachesPrivate));
  assert.equal(trustNotes.length, 0);
  await app.web.policy.assertAllowed(privateAddress);
  await assert.rejects(load(t, app, await place(join(workspace, "cloned", "chat.json"), chatApp)), /no bot token/);
});

test("with folder trust off, a file in the workspace works exactly as before", async (t) => {
  const { app, workspace } = await fixture(t, "off");
  await load(t, app, await place(join(workspace, "cloned", "integrations.json"), reachesPrivate));
  await app.web.policy.assertAllowed(privateAddress);
  await assert.rejects(load(t, app, await place(join(workspace, "cloned", "chat.json"), chatApp)), /no bot token/);
});

test("a folder the owner has not trusted still adds tools a task has to choose to call", async (t) => {
  const { app, workspace } = await fixture(t);
  const file = await place(join(workspace, "cloned", "integrations.json"), {
    browser: { allowedOrigins: ["https://example.com"] }, git: { remote: true },
  });
  const { loaded, trustNotes } = await load(t, app, file);
  assert.deepEqual(loaded.hosted.browserOrigins, ["https://example.com"], "the browser section is still read");
  assert.ok(app.registry.names().includes("git.push"), "the git section is still read");
  assert.equal(trustNotes.length, 0, "nothing was left out, so there is nothing to tell");
});
