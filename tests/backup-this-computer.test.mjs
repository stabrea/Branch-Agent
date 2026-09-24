/**
 * What is about this computer and whom it trusts stays here, like the sign-ins (Q168 A): which workspaces'
 * integration files may load, the outside assistants and their keys, the SSH computers, the commands that
 * fetch secrets and the paired devices. A changed backup could otherwise point Branch at a program, a machine
 * or a person the owner never chose here (NAS 1edead2, f0a62c9). Node only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { restoreBackup } from "../dist/server.js";
import { staysOnThisComputer, thisComputerSettings } from "../dist/backup.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-backup-computer-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const setting = (key) => app.store.get("settings", owner, key)?.data;
  return { app, owner, setting };
}
const keys = [...thisComputerSettings, "devices-book", "remote-agent:helper"];

test("the list is what Q168 A names, and devices-book stays too (named once, with the #186 fix's sign-ins)", () => {
  assert.deepEqual([...thisComputerSettings].sort(), ["folder-trust-real", "folder_trust", "folder_trust_mode",
    "remote-agent-pairing", "remote-computers", "secret-commands"]);
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
