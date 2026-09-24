import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, decideFolder, saveFolderTrustSettings, launchFileView } from "../dist/index.js";
import * as bootstrap from "../dist/integrations/bootstrap.js";
import { knobsApi } from "../dist/knobs/api.js";

/**
 * The launch-file card (Settings, Computer) after a start that left the integrations file out
 * because it sits in a workspace folder the owner has not trusted: the card names the sections that
 * were left out, in English and French, and lists nothing from them as set up.
 */
const sections = {
  channels: [{ type: "telegram", tokenEnv: "BRANCH_TEST_UNSET_TOKEN" }],
  shell: { executables: { node: { path: process.execPath } } },
  mcp: [{ id: "helper", transport: "stdio", command: "/no/such/server", tools: ["x"], expectedVersion: "1" }],
  hooks: [{ id: "on-finish", event: "run.finished", executable: "node" }],
};

test("the card lists no chat apps, programs, servers or hooks that were left out, and names what was", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-launch-held-back-"));
  t.after(() => discardTemp(root));
  const path = join(root, "integrations.json");
  await writeFile(path, JSON.stringify(sections));
  const used = await launchFileView(path);
  assert.deepEqual(used.facts.chatApps, ["telegram"], "a file that was used is described as before");
  assert.deepEqual(used.facts.programs, ["node"]);
  assert.deepEqual(used.facts.leftOut, []);
  const held = await launchFileView(path, ["channels", "shell", "mcp", "hooks"]);
  assert.deepEqual(held.facts.leftOut, ["channels", "shell", "mcp", "hooks"]);
  assert.deepEqual(held.facts.chatApps, [], "no chat app is listed as set up");
  assert.deepEqual(held.facts.programs, []);
  assert.equal(held.facts.servers, 0);
  assert.equal(held.facts.hooks, 0);
});

test("after a start leaves an untrusted folder's file out, the card says which sections", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-launch-held-back-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "cloned"), { recursive: true });
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  saveFolderTrustSettings(app.store, owner, { mode: "on" });
  decideFolder(app.store, owner, workspace, { folder: "cloned", decision: "distrust" });
  const path = join(workspace, "cloned", "integrations.json");
  await writeFile(path, JSON.stringify({ channels: sections.channels, shell: sections.shell }));
  const start = async (file) => {
    const original = console.warn;
    console.warn = () => undefined;
    try {
      const loaded = await bootstrap.loadIntegrations(app.registry, file, {}, app.secretsFor, app.channelHost);
      t.after(() => loaded.close());
    } finally { console.warn = original; }
    return knobsApi(app, { method: "GET" }, "/api/knobs/launch-file", async () => ({}), () => file);
  };
  const view = await start(path);
  assert.deepEqual(view.facts.leftOut, ["channels", "shell"]);
  assert.deepEqual(view.facts.chatApps, [], "the chat app that was not started is not listed");
  assert.deepEqual(view.facts.programs, []);
  // Trusted and started again, the card lists the file's programs and nothing as left out.
  decideFolder(app.store, owner, workspace, { folder: "cloned", decision: "trust" });
  const trusted = join(workspace, "cloned", "commands.json");
  await writeFile(trusted, JSON.stringify({ shell: sections.shell }));
  const again = await start(trusted);
  assert.deepEqual(again.facts.leftOut, []);
  assert.deepEqual(again.facts.programs, ["node"]);
});

test("every section of the file has a name in English and French, and the card's advice asks for a restart", async () => {
  const words = async (name) => JSON.parse(await readFile(new URL(`../public/locales/${name}.json`, import.meta.url), "utf8"));
  const [en, fr] = await Promise.all([words("en"), words("fr")]);
  const { launchSections } = bootstrap;
  assert.deepEqual([...(launchSections ?? [])], ["web", "channels", "mcp", "hooks", "browser", "shell", "git", "issues"]);
  for (const section of launchSections)
    for (const [language, list] of [["en", en], ["fr", fr]])
      assert.ok(list[`knobs.launch.section.${section}`], `${language} names the ${section} section`);
  assert.match(en["knobs.launch.left-out"], /\{sections\}.*then restart Branch/s);
  assert.match(fr["knobs.launch.left-out"], /\{sections\}.*puis redémarrez Branch/s);
});
