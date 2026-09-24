/**
 * What is about this computer and whom it trusts stays here, like the sign-ins (Q168 A): which workspaces'
 * integration files may load, the outside assistants and their keys, the SSH computers, the commands that
 * fetch secrets and the paired devices. A changed backup could otherwise point Branch at a program, a machine
 * or a person the owner never chose here (NAS 1edead2, f0a62c9). Node only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { restoreBackup } from "../dist/server.js";
import { staysOnThisComputer, thisComputerSettings } from "../dist/backup.js";
import { decideFolder, folderTrust, integrationsFileTrusted, realFolder, saveFolderTrustSettings } from "../dist/folder-trust.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-backup-computer-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const setting = (key) => app.store.get("settings", owner, key)?.data;
  return { app, owner, setting, workspace: join(root, "workspace") };
}
const keys = [...thisComputerSettings, "devices-book", "remote-agent:helper"];

test("the list is what Q168 A names, and devices-book stays too (named once, with the #186 fix's sign-ins)", () => {
  assert.deepEqual([...thisComputerSettings].sort(), ["folder-trust-copies", "folder-trust-real", "folder_trust", "folder_trust_mode",
    "keychain-entries", "reach-remote-trunks-keys", "remote-agent-pairing", "remote-computers", "secret-commands"]);
  assert.equal(staysOnThisComputer("devices-book"), true);
  assert.equal(thisComputerSettings.includes("devices-book"), false, "one list names it, not two");
});

test("a backup carries nothing about this computer's trust, and still carries the owner's other settings", async (t) => {
  const { app, owner } = await fixture(t);
  for (const key of keys) app.store.save("settings", owner, key, { mine: key });
  app.store.save("settings", owner, "theme-probe", { kept: true });
  const ids = app.store.backup(app.version).tables.settings.map((row) => row.id);
  for (const key of keys) assert.ok(!ids.includes(key), `${key} is not in the backup`);
  assert.ok(ids.includes("theme-probe"));
});

test("a changed backup plants none of them, and replacing keeps this computer's own", async (t) => {
  const { app, owner, setting } = await fixture(t);
  app.store.save("settings", owner, "remote-agent:mine", { url: "https://mine.example", key: "this computer's" });
  app.store.save("settings", owner, "secret-commands", { mine: true });
  const changed = app.store.backup(app.version);
  const now = new Date().toISOString();
  for (const key of [...keys, "remote-agent:planted"])
    changed.tables.settings.push({ id: key, owner, data: JSON.stringify({ planted: key }), created_at: now, updated_at: now });
  // Over this Branch, replacing it.
  await app.runtime.run({ prompt: "hello", onTextDelta: () => undefined });
  await restoreBackup(app, async () => changed, true);
  for (const key of [...keys, "remote-agent:planted"]) assert.ok(!setting(key)?.planted, `${key} is not taken from the file`);
  assert.deepEqual(setting("remote-agent:mine"), { url: "https://mine.example", key: "this computer's" }, "this computer's own stays");
  assert.deepEqual(setting("secret-commands"), { mine: true }, "even the commands that fetch secrets");
  // Into a fresh Branch.
  const fresh = await fixture(t);
  await restoreBackup(fresh.app, async () => changed, false);
  for (const key of [...keys, "remote-agent:planted"]) assert.equal(fresh.setting(key), undefined, `${key} is not planted in a fresh Branch`);
});

test("a changed backup cannot make a copy Branch never made share a trusted folder's decision (folder-trust-copies)", async (t) => {
  const { app, owner, workspace } = await fixture(t);
  const repo = join(workspace, "repo"), copy = join(repo, ".branch-worktrees", "x");
  await mkdir(repo, { recursive: true });
  const git = (...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, stdio: "ignore" });
  git("init", "-q"); await writeFile(join(repo, "README.md"), "hello\n"); git("add", "."); git("commit", "-qm", "first");
  git("worktree", "add", "-q", "-b", "x", copy);
  await writeFile(join(copy, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  saveFolderTrustSettings(app.store, owner, { mode: "on" });
  decideFolder(app.store, owner, workspace, { folder: "repo", decision: "trust" });
  const mayLoad = () => integrationsFileTrusted(app.store, owner, workspace, join(copy, ".mcp.json"));
  assert.equal(folderTrust(app.store, owner, copy), "unknown", "control: Branch has no record of this copy");
  assert.equal(mayLoad(), false);
  const changed = app.store.backup(app.version);
  const now = new Date().toISOString();
  changed.tables.settings.push({ id: "folder-trust-copies", owner, created_at: now, updated_at: now,
    data: JSON.stringify({ copies: [{ source: realFolder(repo), copy: realFolder(copy) }] }) });
  await restoreBackup(app, async () => changed, true);
  assert.equal(folderTrust(app.store, owner, copy), "unknown", "the file's record of a copy is not taken");
  assert.equal(mayLoad(), false, "so the copy's integrations file still may not load");
});

test("a replacing restore keeps this computer's own paired chat senders (NAS ecd115b, the #186 merge)", async (t) => {
  const { app, owner, setting } = await fixture(t);
  app.store.save("settings", owner, "channel-pair:telegram:5:88", { approved: true, mine: true });
  app.store.save("settings", owner, "sender-allowlist", { senders: ["telegram:5:88"] });
  // A backup from another computer (or an older one) carries no senders of this computer's at all.
  const changed = app.store.backup(app.version);
  changed.tables.settings = changed.tables.settings.filter((row) => !row.id.startsWith("channel-pair:") && row.id !== "sender-allowlist");
  await restoreBackup(app, async () => changed, true);
  assert.deepEqual(setting("channel-pair:telegram:5:88"), { approved: true, mine: true });
  assert.deepEqual(setting("sender-allowlist"), { senders: ["telegram:5:88"] });
});
