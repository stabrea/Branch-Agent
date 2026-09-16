/**
 * Hardening pass 2: the gaps the wave 7 integrators wrote down as "not fixed". One test per gap,
 * each one the test that would have caught it. Fakes only: no real network, no real screen, no
 * real outside server, nothing on the desktop.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";

const say = (content) => ({ content, toolCalls: [] });

async function fixture(t, reply = () => say("done"), options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-hardening2-"));
  const provider = { name: "scripted", async complete(request) { return reply(request); } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  t.after(async () => {
    await app.processes.stopAll().catch(() => undefined);
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, root };
}

// ---------------------------------------------------------------------------
// 7. The owner may add websites their own browser must never be pointed at, and
//    may never take one off the built-in list.
// ---------------------------------------------------------------------------

test("the owner's extra refused websites are added to the built-in list, never subtracted", async () => {
  const { hostRefusalFor } = await import("../dist/integrations/desktop-config.js");
  const { attachedAddressRefusal, AttachSettingsSchema } = await import("../dist/integrations/browser-attach.js");
  // A site of the owner's own is refused once they name it, and not before.
  assert.equal(hostRefusalFor("payroll.example"), null);
  assert.match(hostRefusalFor("payroll.example", ["payroll.example"]) ?? "", /passwords/);
  // Anything under it is refused too, exactly as the built-in entries are.
  assert.match(hostRefusalFor("login.payroll.example", ["payroll.example"]) ?? "", /passwords/);
  // The list is additive only: naming a built-in entry cannot turn it off, and neither can
  // handing in an empty list, whitespace, or something that looks like a removal.
  for (const extra of [[], ["chase.com"], ["  "], ["-chase.com"], ["!chase.com"]])
    assert.match(hostRefusalFor("chase.com", extra) ?? "", /money or passwords/, JSON.stringify(extra));
  // The whole-address check carries the owner's extra sites through.
  assert.equal(attachedAddressRefusal("https://payroll.example/pay"), null);
  assert.match(attachedAddressRefusal("https://payroll.example/pay", "", ["payroll.example"]) ?? "", /passwords/);
  // And the setting is a plain list kept beside the rest of the browser settings.
  assert.deepEqual(AttachSettingsSchema.parse({}).extraRefusedHosts, []);
});

test("the extra refused websites are saved and read back through the browser settings", async (t) => {
  const { app } = await fixture(t);
  const { readAttachSettings, saveAttachSettings } = await import("../dist/integrations/browser-attach.js");
  const saved = saveAttachSettings(app.store, app.runtime.owner, { extraRefusedHosts: ["payroll.example"] });
  assert.deepEqual(saved.extraRefusedHosts, ["payroll.example"]);
  assert.deepEqual(readAttachSettings(app.store, app.runtime.owner).extraRefusedHosts, ["payroll.example"]);
});
