/**
 * Q168 B: a restore brings back the owner's model accounts and connections, approved chat senders and the allow
 * list, sharing, groups, roles and approval rules only on the owner's yes, row by row. Until then this computer's
 * own stays. A changed backup could otherwise point the owner's words at another endpoint or let a sender in
 * (NAS 1edead2, f0a62c9). Node only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { restoreBackup } from "../dist/server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-backup-yes-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const setting = (key) => app.store.get("settings", owner, key)?.data;
  return { app, owner, setting };
}
const fromFile = { "accounts": { pool: "file's" }, "model-connections": { baseUrl: "https://elsewhere.example" },
  "channel-pair:telegram:777": { approved: true }, "sender-allowlist": { everyone: true }, "people-shares": { planted: true },
  "policy": { preset: "off", rules: [] } };
function changed(app, owner) {
  const archive = app.store.backup(app.version);
  const now = new Date().toISOString();
  archive.tables.settings = archive.tables.settings.filter((row) => !(row.id in fromFile));
  for (const [id, data] of Object.entries(fromFile)) archive.tables.settings.push({ id, owner, data: JSON.stringify(data), created_at: now, updated_at: now });
  return archive;
}
const groups = (held) => held.map((one) => one.group).sort();

test("into a fresh Branch, the owner's accounts, senders, sharing and rules wait for a yes instead of taking effect", async (t) => {
  const { app, owner } = await fixture(t);
  const archive = changed(app, owner);
  const fresh = await fixture(t);
  const answer = await restoreBackup(fresh.app, async () => archive, false);
  assert.deepEqual(groups(answer.held), ["accounts", "channel-pair:telegram:777", "people-shares", "policy", "sender-allowlist"]);
  assert.deepEqual(answer.held.find((one) => one.group === "accounts").ids, ["accounts", "model-connections"], "an account and its connection are one answer");
  for (const id of Object.keys(fromFile)) assert.equal(fresh.setting(id), undefined, `${id} is not in place yet`);
  assert.ok(!fresh.app.store.backup(fresh.app.version).tables.settings.some((row) => row.id === "restore-held"), "the waiting list is never in a backup");
});

test("over this Branch, this computer's own stays until the owner answers, and the answer puts in exactly what was chosen", async (t) => {
  const { app, owner, setting } = await fixture(t);
  app.store.save("settings", owner, "model-connections", { baseUrl: "https://mine.example" });
  app.store.save("settings", owner, "policy", { preset: "careful", rules: [] });
  const archive = changed(app, owner);
  await app.runtime.run({ prompt: "hello", onTextDelta: () => undefined });
  const answer = await restoreBackup(app, async () => archive, true);
  assert.ok(groups(answer.held).includes("accounts"));
  assert.deepEqual(setting("model-connections"), { baseUrl: "https://mine.example" }, "this computer's connection stays for now");
  assert.deepEqual(setting("policy"), { preset: "careful", rules: [] }, "and its rules");
  assert.throws(() => app.store.restoreHeld.answer({ use: ["policy"], keep: ["policy"] }), /either use or keep/);
  assert.throws(() => app.store.restoreHeld.answer({ use: ["remote-computers"] }), /Nothing from a restore is waiting/);
  const after = app.store.restoreHeld.answer({ use: ["accounts"], keep: ["policy"] });
  assert.deepEqual(setting("model-connections"), { baseUrl: "https://elsewhere.example" }, "the owner said use: the file's connection");
  assert.deepEqual(setting("accounts"), { pool: "file's" }, "with its account");
  assert.deepEqual(setting("policy"), { preset: "careful", rules: [] }, "the owner said keep: this computer's rules");
  assert.deepEqual(groups(after.held), ["channel-pair:telegram:777", "people-shares", "sender-allowlist"], "the rest still waits");
  assert.equal(setting("sender-allowlist"), undefined);
});

test("a restore point minutes old holds nothing, and a second restore adds to what is waiting without answering it", async (t) => {
  const { app, owner } = await fixture(t);
  app.store.save("settings", owner, "policy", { preset: "careful", rules: [] });
  app.store.save("settings", owner, "sender-allowlist", { everyone: false });
  const point = app.store.backup(app.version);
  await app.runtime.run({ prompt: "hello", onTextDelta: () => undefined });
  assert.deepEqual(app.store.restore(point, { replaceExisting: true }).held, [], "the same values are not held");
  const first = changed(app, owner);
  app.store.restore(first, { replaceExisting: true });
  const second = app.store.backup(app.version);
  const now = new Date().toISOString();
  second.tables.settings = second.tables.settings.filter((row) => row.id !== "policy");
  second.tables.settings.push({ id: "policy", owner, data: JSON.stringify({ preset: "strict", rules: [] }), created_at: now, updated_at: now });
  const held = app.store.restore(second, { replaceExisting: true }).held;
  assert.ok(groups(held).includes("sender-allowlist"), "the first restore's rows still wait");
  app.store.restoreHeld.answer({ use: ["policy"] });
  assert.deepEqual(app.store.get("settings", owner, "policy").data, { preset: "strict", rules: [] }, "the newer file's value is the one waiting");
});

test("only the owner's own window hears about it or answers", async (t) => {
  const { app, owner } = await fixture(t);
  const fresh = await fixture(t);
  await restoreBackup(fresh.app, async () => changed(app, owner), false);
  const sam = fresh.app.store.profiles.create({ name: "Sam", pin: "2468" });
  fresh.app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  assert.throws(() => fresh.app.store.restoreHeld.list(), /belongs to the owner/);
  assert.throws(() => fresh.app.store.restoreHeld.answer({ use: ["accounts"] }), /belongs to the owner/);
  fresh.app.store.profiles.switch({ profileId: null });
  assert.equal(fresh.setting("accounts"), undefined);
  assert.ok(fresh.app.store.restoreHeld.list().held.length > 0);
});
