/**
 * Sign-ins stay on this computer: a backup never carries them, and a restore neither brings one back nor adds one.
 * With "replace what is here" (#186), an older backup brought back a passkey the owner had taken away and switched
 * sign-in from elsewhere on again, and a changed file added a passkey for a person who lives here (Mac mini 6534228).
 * Node only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { restoreBackup } from "../dist/server.js";
import { signInSettings } from "../dist/backup.js";

const passkey = (id) => ({ credentialId: id.padEnd(22, "x"), jwk: { kty: "EC" }, alg: -7, signCount: 0 });
const device = (id) => ({ id: id.padEnd(16, "0"), name: "Phone", fingerprint: "a".repeat(64), createdAt: new Date().toISOString() });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-backup-signins-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  const setting = (key) => app.store.get("settings", owner, key)?.data;
  const samPasskeys = () => app.people.passkeys.of(sam.id).map((each) => each.credentialId.slice(0, 7));
  return { app, owner, sam, setting, samPasskeys };
}

test("a backup carries no sign-in settings", async (t) => {
  const { app, owner, sam } = await fixture(t);
  app.people.passkeys.add(sam.id, passkey("SAMKEY1"), "Sam's phone");
  app.store.save("settings", owner, "people-signin", { mode: "on" });
  app.store.save("settings", owner, "remote-devices", [device("d1")]);
  app.store.save("settings", owner, "theme-probe", { kept: true });
  const ids = app.store.backup(app.version).tables.settings.map((row) => row.id);
  for (const key of signInSettings) assert.ok(!ids.includes(key), `${key} is not in the backup`);
  assert.ok(ids.includes("theme-probe"), "other settings still are");
});

test("restoring an older backup over this Branch brings back no passkey the owner took away, and leaves sign-in as it is", async (t) => {
  const { app, owner, sam, setting, samPasskeys } = await fixture(t);
  app.people.passkeys.add(sam.id, passkey("LOSTPHO"), "Sam's old phone");
  app.store.save("settings", owner, "people-signin", { mode: "on" });
  const old = app.store.backup(app.version);
  app.people.passkeys.remove(sam.id, passkey("LOSTPHO").credentialId);
  app.store.save("settings", owner, "people-signin", { mode: "off" });
  app.people.passkeys.add(sam.id, passkey("NEWPHON"), "Sam's new phone");
  await app.runtime.run({ prompt: "hello", onTextDelta: () => undefined });
  await restoreBackup(app, async () => old, true);
  assert.deepEqual(samPasskeys(), ["NEWPHON"], "the lost phone stays taken away, and the new one stays");
  assert.deepEqual(setting("people-signin"), { mode: "off" });
});

test("a changed backup adds no passkey and no paired device, whether it replaces this Branch or fills a fresh one", async (t) => {
  const { app, owner, sam, setting, samPasskeys } = await fixture(t);
  const changed = app.store.backup(app.version);
  const plant = (key, data) => changed.tables.settings.push({ id: key, owner, data: JSON.stringify(data), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  plant("people-passkeys", { [sam.id]: [{ ...passkey("PLANTED"), name: "planted", createdAt: new Date().toISOString(), lastUsedAt: null }] });
  plant("remote-devices", [device("dead")]);
  plant("people-signin", { mode: "on" });
  // Over this Branch, replacing it.
  await app.runtime.run({ prompt: "hello", onTextDelta: () => undefined });
  await restoreBackup(app, async () => changed, true);
  assert.deepEqual(samPasskeys(), [], "no planted passkey");
  assert.equal(setting("remote-devices"), undefined, "no planted device");
  assert.equal(setting("people-signin"), undefined, "sign-in from elsewhere is not switched on");
  // Into a fresh Branch.
  const fresh = await fixture(t);
  await restoreBackup(fresh.app, async () => changed, false);
  assert.equal(fresh.setting("people-passkeys"), undefined);
  assert.equal(fresh.setting("remote-devices"), undefined);
  assert.equal(fresh.setting("people-signin"), undefined);
});
