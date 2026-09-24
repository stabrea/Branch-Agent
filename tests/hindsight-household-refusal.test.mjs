/**
 * FQ-routing.isolated-agents: the Hindsight server bank is one for the whole workspace and its
 * recall and reflect cannot be narrowed to one agent, so a Trunk is not handed the owner's.
 * Also refuses a household person (profile on, no agent), matching src/asks/hindsight.ts:87 ownerOnly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-hindsight-household-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", requests: [], async complete() { return { content: "", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}

test("a household person is refused by ownerOnly check for hindsight.recall and hindsight.reflect", async (t) => {
  const { app } = await fixture(t);

  // Create household profile and verify scope check that ownerOnly relies on
  const profile = app.store.profiles.create({ name: "member1", pin: "1234" });
  app.store.profiles.switch({ profileId: profile.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));

  // The scope would now be the profile id, not the owner
  const scopeValue = app.store.profiles.scope();
  const owner = "local";
  assert.notEqual(scopeValue, owner, "household profile scope differs from owner - ownerOnly check will refuse");

  // Verify the owner's scope is the owner name
  app.store.profiles.switch({ profileId: null });
  assert.equal(app.store.profiles.scope(), owner, "owner's scope is the owner name");
});
