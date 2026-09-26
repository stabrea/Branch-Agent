/**
 * setup-make-it-yours: setup's "How much it asks" now saves Auto for new conversations, which keeps a standing yes per
 * website, so POST /api/conversation-mode/settings is held to POST /api/policy's two rules (src/policy-change-guard.ts):
 * nothing changes under Lockdown, and a start that lets new conversations do more needs the owner's separate yes,
 * `confirmLoosening`. Each case names the mutation that turns it red (design/redesign/tools/mutate-new-conversation-guard.mjs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { savePolicy } from "../dist/policy.js";

const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
const path = "/api/conversation-mode/settings";

async function served(t, preset = "ask-before-changes") {
  const root = await mkdtemp(join(tmpdir(), "branch-mode-guard-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { app.store.profiles.switch({ profileId: null }); await server.close(); await app.close(); await discardTemp(root); });
  savePolicy(app.store, app.runtime.owner, { preset });
  const call = (method, route, body) => fetch(server.url + route, {
    method,
    headers: { authorization: `Bearer ${server.token}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const saved = async () => (await call("GET", path)).body.settings.newConversation;
  return { app, call, saved };
}

/* Mutation M1: make `if (confirmLoosening)` in newConversationRefusal read `if (true)` → Auto is saved without the yes.
   Mutation M2: delete the 409 throw after newConversationRefusal in conversationModeApi → the same. */
test("Auto for new conversations needs the owner's yes to loosening, and says why in the engine's words", async (t) => {
  const { call, saved } = await served(t);
  assert.equal(await saved(), "ask", "Ask first is the default");
  const unconfirmed = await call("POST", path, { newConversation: "auto" });
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.body.error, 'This makes Branch less careful: new conversations would start on Auto instead of Ask first. Tick "Yes, make it less careful" to go ahead.');
  assert.equal(await saved(), "ask", "a loosening without the yes saves nothing");
  const confirmed = await call("POST", path, { newConversation: "auto", confirmLoosening: true });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.settings.newConversation, "auto");
  assert.equal(await saved(), "auto", "read back: the owner's yes saves Auto");
  assert.equal((await call("POST", path, { newConversation: "full" })).status, 409, "Auto to No approvals loosens again");
  assert.equal((await call("POST", path, { newConversation: "auto" })).status, 200, "saving what is already saved changes nothing, so it needs no yes");
});

/* Control for M1/M2's shape: tightening is never asked about, and a bad confirmLoosening never reaches the strict schema as a field. */
test("a start that asks more needs no yes, going back from it does, and confirmLoosening is taken off before the strict schema", async (t) => {
  const { call, saved } = await served(t);
  assert.equal((await call("POST", path, { newConversation: "plan" })).status, 200, "Ask first to Plan tightens");
  assert.equal(await saved(), "plan");
  assert.equal((await call("POST", path, { newConversation: "ask" })).status, 409, "Plan back to Ask first loosens, so it asks too");
  const typo = await call("POST", path, { newConversation: "ask", confirmLoosening: "yes" });
  assert.notEqual(typo.status, 200, "confirmLoosening is true or false");
  assert.equal(await saved(), "plan");
});

/* Mutation M3: make the `lockdownActive` check in newConversationRefusal read `if (false)` → Auto is saved under Lockdown. */
test("under Lockdown nothing new conversations start on changes, even with the owner's yes", async (t) => {
  const { call, saved } = await served(t);
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  for (const value of ["auto", "follow", "plan"]) {
    const locked = await call("POST", path, { newConversation: value, confirmLoosening: true });
    assert.equal(locked.status, 409, value);
    assert.equal(locked.body.error, "Lockdown is on, so settings cannot be changed from here. Turn it off first.");
  }
  assert.equal(await saved(), "ask", "Lockdown kept Ask first");
  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200);
  assert.equal((await call("POST", path, { newConversation: "auto", confirmLoosening: true })).status, 200, "control: unlocked, the yes saves it");
});

/* Mutation M4: make startRank rank "follow" as Ask first (`modeRank.ask`) → following an owner's No approvals is saved without the yes. */
test("following the owner's setting is weighed as that setting: No approvals and the owner's own rules count as loosest", async (t) => {
  const off = await served(t, "off");
  const refused = await off.call("POST", path, { newConversation: "follow" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /start on the owner's own setting instead of Ask first/);
  assert.equal(await off.saved(), "ask");
  const custom = await served(t, "custom");
  assert.equal((await custom.call("POST", path, { newConversation: "follow" })).status, 409, "the owner's own rules may hold a broad yes");
  const careful = await served(t, "read-only");
  assert.equal((await careful.call("POST", path, { newConversation: "follow" })).status, 200, "control: following Read only asks more");
  assert.equal(await careful.saved(), "follow");
});

/* The owner-only door still answers first: a household person is refused, with or without the yes. */
test("somebody else in the house still cannot save it, even with the yes", async (t) => {
  const { app, call, saved } = await served(t);
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const refused = await call("POST", path, { newConversation: "auto", confirmLoosening: true });
  assert.ok([400, 403].includes(refused.status), `refused (${refused.status})`);
  app.store.profiles.switch({ profileId: null });
  assert.equal(await saved(), "ask");
});
