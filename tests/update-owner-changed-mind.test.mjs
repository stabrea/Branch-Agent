/**
 * Dogfood F1, NAS's check: a Dev install builds for many minutes, and the owner may change their mind meanwhile.
 * The last gate before Branch closes reads the owner's choice again: leaving the channel stops any install, and
 * turning "update by itself" off stops one it started. The Update button still works with it off. Node only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { changedMind, updateReadiness } from "../dist/desktop/update-readiness.js";

const idle = (channel, autoUpdate) => ({ channel, busyTasks: 0, ...(autoUpdate ? { autoUpdate } : {}) });

test("turning update by itself off, or leaving the channel, stops an install it started", () => {
  const automatic = { channel: "dev", automatic: true };
  assert.equal(changedMind(idle("dev", "install"), automatic), null, "control: nothing changed, it goes on");
  assert.match(changedMind(idle("dev", "check"), automatic) ?? "", /Update by itself was turned off/);
  assert.match(changedMind(idle("dev", "off"), automatic) ?? "", /Update by itself was turned off/);
  assert.match(changedMind(idle("stable", "install"), automatic) ?? "", /channel was changed/);
  assert.match(changedMind(idle("dev"), automatic) ?? "", /turned off/, "an engine that does not say leaves it waiting");
});

test("the Update button's install goes on with update by itself off, but not onto another channel", () => {
  const pressed = { channel: "dev", automatic: false };
  assert.equal(changedMind(idle("dev", "off"), pressed), null);
  assert.match(changedMind(idle("beta", "off"), pressed) ?? "", /channel was changed/);
  assert.equal(changedMind(idle("beta", "off"), null), null, "no install under way: nothing to stop");
});

test("the engine's readiness carries the owner's update-by-itself choice, read fresh each time", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-changed-mind-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const url = new URL(server.url);
  const loopback = `http://127.0.0.1:${url.port}`;
  app.store.save("settings", app.runtime.owner, "comfort-notify", { autoUpdate: "install", releaseChannel: "dev" });
  const first = await updateReadiness(loopback, server.token);
  assert.deepEqual(first, { channel: "dev", busyTasks: 0, autoUpdate: "install" });
  assert.equal(changedMind(first, { channel: "dev", automatic: true }), null);
  app.store.save("settings", app.runtime.owner, "comfort-notify", { autoUpdate: "off", releaseChannel: "dev" });
  const later = await updateReadiness(loopback, server.token);
  assert.match(changedMind(later, { channel: "dev", automatic: true }) ?? "", /turned off/);
});
