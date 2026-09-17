/**
 * mac7/lockdown-fix: Lockdown wins over any saved mode. Each covered feature is switched on under a
 * saved mode, Lockdown goes on, and the feature is refused — also after a change saved while
 * Lockdown is on — and comes back as it was once Lockdown is off. Temporary folders only; the
 * screen, the browser and the command tool are stand-ins, so nothing real is touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy, setLockdown } from "../dist/index.js";
import { readDesktopSettings, saveDesktopSettings } from "../dist/integrations/desktop-config.js";
import { attachRefusal, readAttachSettings, saveAttachSettings } from "../dist/integrations/browser-attach.js";
import { codeRunSettings, saveCodeRunSettings } from "../dist/code-run.js";
import { switchedToolTiers } from "../dist/feature-switches.js";
import { autonomyMode, requirePart, saveAutonomyMode } from "../dist/autonomy/settings.js";
import { trunkMode } from "../dist/trunks/settings.js";
import { personalMode, requirePersonal, savePersonalMode } from "../dist/personal/settings.js";

const owner = "local";

async function app(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-lockdown-modes-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const branch = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await branch.close(); await discardTemp(root); });
  const ran = [];
  // Stand-ins for everything that would reach past the app, so a test can see whether it ran.
  const standIn = (name, permission) => {
    branch.registry.unregister(name);
    branch.registry.register({ name, permission, description: "stand-in", parameters: z.object({}).passthrough(),
      execute: async () => { ran.push(name); return { ok: true }; } });
  };
  standIn("shell.execute", "shell.execute");
  standIn("desktop.click", "desktop.control");
  standIn("browser.borrow", "browser.interact");
  standIn("process.start", "process.manage");
  return { branch, ran };
}
const byHand = { mode: "owner" };
const decision = (branch, tool) =>
  branch.runtime.checkPolicy(tool, {}, branch.runtime.context({ source: "owner" }), "f").decision;
const allowAll = (branch) =>
  savePolicy(branch.store, owner, { preset: "custom", rules: [{ tool: "*", decision: "allow", remember: "always" }] });

test("screen and keyboard: a saved mode is off under Lockdown, even one saved during it", async (t) => {
  const { branch, ran } = await app(t);
  allowAll(branch);
  saveDesktopSettings(branch.store, owner, { mode: "on" });
  assert.equal(readDesktopSettings(branch.store, owner).enabled, true);
  assert.deepEqual(switchedToolTiers(branch.store, owner, ["desktop.click"]).preload.map((p) => p.name), ["desktop.click"]);
  await branch.runtime.executeTool("desktop.click", {}, byHand);
  assert.deepEqual(ran, ["desktop.click"]);

  setLockdown(branch.store, owner, { on: true });
  assert.equal(readDesktopSettings(branch.store, owner).enabled, false, "the saved mode no longer wins");
  assert.equal(readDesktopSettings(branch.store, owner).mode, "off");
  assert.deepEqual(switchedToolTiers(branch.store, owner, ["desktop.click"]).hidden, ["desktop.click"]);
  saveDesktopSettings(branch.store, owner, { mode: "on" });
  assert.equal(readDesktopSettings(branch.store, owner).enabled, false, "a change saved during Lockdown does not switch it on");
  allowAll(branch);
  assert.equal(decision(branch, "desktop.click"), "deny");
  await assert.rejects(branch.runtime.executeTool("desktop.click", {}, byHand), /Lockdown is on/);
  assert.deepEqual(ran, ["desktop.click"], "nothing more ran");

  setLockdown(branch.store, owner, { on: false });
  assert.equal(readDesktopSettings(branch.store, owner).mode, "on", "the mode it had before comes back");
});

test("borrowing the browser: a saved permission is refused under Lockdown", async (t) => {
  const { branch, ran } = await app(t);
  allowAll(branch);
  saveAttachSettings(branch.store, owner, { enabled: true });
  assert.equal(attachRefusal(readAttachSettings(branch.store, owner), "run-1"), null);

  setLockdown(branch.store, owner, { on: true });
  saveAttachSettings(branch.store, owner, { enabled: true });
  allowAll(branch);
  assert.match(attachRefusal(readAttachSettings(branch.store, owner), "run-1"), /not allowed to use your own browser/);
  assert.equal(decision(branch, "browser.borrow"), "deny");
  await assert.rejects(branch.runtime.executeTool("browser.borrow", {}, byHand), /Lockdown is on/);
  assert.deepEqual(ran, []);
});

test("commands, scripts and programs: allowed before, refused under Lockdown whatever the rules say", async (t) => {
  const { branch, ran } = await app(t);
  allowAll(branch);
  await saveCodeRunSettings(branch.store, owner, { enabled: true });
  assert.equal(codeRunSettings(branch.store, owner).enabled, true);
  await branch.runtime.executeTool("shell.execute", {}, { mode: "policy" });
  assert.deepEqual(ran, ["shell.execute"]);

  setLockdown(branch.store, owner, { on: true });
  // Everything saved again while Lockdown is on, as if the owner had tried to get round it.
  allowAll(branch);
  await saveCodeRunSettings(branch.store, owner, { enabled: true });
  assert.equal(codeRunSettings(branch.store, owner).enabled, false);
  for (const tool of ["shell.execute", "process.start"]) {
    assert.equal(decision(branch, tool), "deny", tool);
    await assert.rejects(branch.runtime.executeTool(tool, {}, byHand), /Lockdown is on/);
    await assert.rejects(branch.runtime.executeTool(tool, {}, { mode: "policy" }), /Lockdown is on/);
  }
  assert.deepEqual(ran, ["shell.execute"], "nothing more ran");
  // A rule saved during Lockdown does not let anything else past without a yes either.
  assert.equal(decision(branch, "files.write"), "ask");
});

test("automations: a part switched on is off under Lockdown", async (t) => {
  const { branch } = await app(t);
  saveAutonomyMode(branch.store, owner, "orders", { mode: "on" });
  assert.equal(autonomyMode(branch.store, owner, "orders"), "on");
  assert.doesNotThrow(() => requirePart(branch.store, owner, "orders"));
  assert.ok(switchedToolTiers(branch.store, owner, ["orders.list"]).preload.length === 1);

  setLockdown(branch.store, owner, { on: true });
  saveAutonomyMode(branch.store, owner, "orders", { mode: "on" });
  assert.equal(autonomyMode(branch.store, owner, "orders"), "off");
  assert.throws(() => requirePart(branch.store, owner, "orders"), /switched off/);
  assert.deepEqual(switchedToolTiers(branch.store, owner, ["orders.list"]).hidden, ["orders.list"]);
  setLockdown(branch.store, owner, { on: false });
  assert.equal(autonomyMode(branch.store, owner, "orders"), "on");
});

test("routines a Trunk owns: fire when on, refused under Lockdown", async (t) => {
  const { branch } = await app(t);
  for (const part of ["trunks", "routines"]) branch.trunks.setMode(part, { mode: "on" });
  const fi = branch.trunks.create({ name: "Fi" });
  branch.trunks.edit(fi.id, { permissions: ["files.read"] });
  await branch.trunks.introduced();
  const routine = branch.trunks.routines.create(fi.id, { name: "Look", prompt: "Look around" });
  assert.ok((await branch.scheduler.trigger(owner, routine.id, null, owner)).id, "it runs while on");

  setLockdown(branch.store, owner, { on: true });
  branch.trunks.setMode("routines", { mode: "on" });
  assert.equal(trunkMode(branch.store, owner, "routines"), "off");
  assert.equal(trunkMode(branch.store, owner, "trunks"), "on", "Lockdown only covers what it names");
  const runs = branch.store.runs(owner).length;
  await assert.rejects(branch.scheduler.trigger(owner, routine.id, null, owner), /did not produce a run/);
  assert.equal(branch.store.runs(owner).length, runs, "nothing ran");
});

test("your other devices: switched on, then off under Lockdown, and their tools refused", async (t) => {
  const { branch } = await app(t);
  allowAll(branch);
  branch.devices.setMode({ mode: "on" });
  assert.equal(branch.devices.book.mode(), "on");
  const listed = await branch.runtime.executeTool("device.list", {}, byHand);
  assert.ok(listed, "device.list answers while on");

  setLockdown(branch.store, owner, { on: true });
  allowAll(branch);
  assert.equal(branch.devices.book.mode(), "off");
  assert.throws(() => branch.devices.book.requireOn());
  assert.deepEqual(switchedToolTiers(branch.store, owner, ["device.list"]).hidden, ["device.list"]);
  // The tools still registered from before are refused by the gate.
  assert.equal(decision(branch, "device.list"), "deny");
  await assert.rejects(branch.runtime.executeTool("device.list", {}, byHand), /Lockdown is on/);
  branch.devices.setMode({ mode: "on" });
  assert.equal(branch.devices.book.mode(), "off", "a change saved during Lockdown does not switch it on");
  setLockdown(branch.store, owner, { on: false });
  assert.equal(branch.devices.book.mode(), "on");
  assert.ok(await branch.runtime.executeTool("device.list", {}, byHand), "back without a restart");
});

test("personal connectors: a part switched on is off under Lockdown", async (t) => {
  const { branch } = await app(t);
  savePersonalMode(branch.store, owner, "google", { mode: "on" });
  assert.equal(personalMode(branch.store, owner, "google"), "on");
  assert.doesNotThrow(() => requirePersonal(branch.store, owner, "google"));
  assert.equal(switchedToolTiers(branch.store, owner, ["gmail.search"]).preload.length, 1);

  setLockdown(branch.store, owner, { on: true });
  savePersonalMode(branch.store, owner, "google", { mode: "on" });
  assert.equal(personalMode(branch.store, owner, "google"), "off");
  assert.throws(() => requirePersonal(branch.store, owner, "google"), /Lockdown is on, so your Gmail/);
  assert.deepEqual(switchedToolTiers(branch.store, owner, ["gmail.search"]).hidden, ["gmail.search"]);
  setLockdown(branch.store, owner, { on: false });
  assert.equal(personalMode(branch.store, owner, "google"), "on");
});
