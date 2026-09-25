/**
 * Dogfood B15: the first-run card ("How should Branch think?") came back after an update although a model had long
 * been answering. An older build left the answers but no Done, and B7 ends setup only at the next answer, so the
 * updated window opened on the card. At start, a real model's earlier answer now ends setup; the demonstration's does not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

async function folder(t, providerName) {
  const root = await mkdtemp(join(tmpdir(), "branch-first-run-update-"));
  t.after(() => discardTemp(root));
  const provider = { name: providerName, async complete() { return { content: "ok", toolCalls: [] }; } };
  return { workspace: join(root, "w"), dataDir: join(root, "d"), presets: [{ id: "main", name: "M", provider, model: "m" }] };
}
/** What an older build without B7 left behind: its answers kept, Done never saved. Then the update opens the folder. */
async function updatedAfter(options, answer) {
  const before = await createBranch(options);
  if (answer) assert.equal((await before.runtime.run({ prompt: "hello from long ago" })).status, "completed");
  before.store.delete("settings", before.runtime.owner, "onboarding");
  await before.close();
  const after = await createBranch(options);
  const done = after.store.get("settings", after.runtime.owner, "onboarding")?.data?.done === true;
  await after.close();
  return done;
}

test("dogfood B15: a folder a real model already answered in opens with setup done after an update", async (t) => {
  assert.equal(await updatedAfter(await folder(t, "chatgpt"), true), true);
});

test("dogfood B15: answers from the offline demonstration alone leave the card to show", async (t) => {
  assert.equal(await updatedAfter(await folder(t, "offline-demo-fixture"), true), false);
});

test("dogfood B15: a folder nothing answered in yet still shows the card", async (t) => {
  assert.equal(await updatedAfter(await folder(t, "chatgpt"), false), false);
});

// NAS 82ed54b: the history read parses each task's events, so one damaged row must never stop Branch from opening.
test("dogfood B15: a damaged task record leaves the card showing and never stops Branch from opening", async (t) => {
  const options = await folder(t, "chatgpt");
  const before = await createBranch(options);
  assert.equal((await before.runtime.run({ prompt: "hello from long ago" })).status, "completed");
  before.store.delete("settings", before.runtime.owner, "onboarding");
  const damaged = before.store.db.prepare("UPDATE events SET data='{not json' WHERE kind='model.completed'").run();
  assert.ok(damaged.changes >= 1, "the fixture damaged the answer's record");
  await before.close();
  const after = await createBranch(options);
  t.after(() => after.close());
  assert.equal(after.store.get("settings", after.runtime.owner, "onboarding")?.data?.done === true, false);
});
