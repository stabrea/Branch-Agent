/**
 * Q50: a settings request in the owner's own words is matched before anything is planned. Words that
 * fit several settings, or none, come back as one question and no plan; words that fit exactly one
 * come back as the exact before and after, with anything already as asked left out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, savePolicy } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-clarify-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const context = () => app.runtime.context({ source: "owner" });
  const find = (input) => app.registry.execute("settings.find", input, context());
  const values = async () => Object.fromEntries((await app.registry.execute("settings.list", {}, context())).shown.map((row) => [row.setting, row.value]));
  return { app, find, values };
}

test("two ambiguous phrasings each come back as one question, with nothing planned or changed", async (t) => {
  const { find, values } = await fixture(t);
  const before = await values();
  const board = await find({ request: "turn on the board" });
  assert.equal(board.status, "ask");
  assert.equal(board.planned, false);
  assert.deepEqual(board.choices.map((one) => one.setting).sort(), ["asks-project-board.mode", "flowboards-kanban.mode"]);
  assert.match(board.question, /Project boards/);
  assert.match(board.question, /The shared board/);
  assert.equal((board.question.match(/\?/g) ?? []).length, 1, "exactly one question");
  assert.equal(board.preview, undefined);

  const voice = await find({ request: "switch on voice" });
  assert.equal(voice.status, "ask");
  assert.equal(voice.planned, false);
  assert.ok(voice.choices.length > 1);
  assert.ok(voice.choices.every((one) => one.setting.startsWith("voice.")));
  assert.equal((voice.question.match(/\?/g) ?? []).length, 1, "exactly one question");
  assert.deepEqual(await values(), before);
});

test("a request that fits no setting asks which one is meant and lists none", async (t) => {
  const { find, values } = await fixture(t);
  const before = await values();
  const none = await find({ request: "turn on the flux capacitor" });
  assert.equal(none.status, "ask");
  assert.equal(none.planned, false);
  assert.deepEqual(none.choices, []);
  assert.match(none.question, /could not find a setting.*flux capacitor.*Which setting do you mean\?/);
  const empty = await find({ request: "turn it on" });
  assert.equal(empty.status, "ask");
  assert.deepEqual(empty.choices, []);
  assert.deepEqual(await values(), before);
});

test("a clear request gives the exact before and after, and one already as asked gives no change", async (t) => {
  const { app, find, values } = await fixture(t);
  const clear = await find({ request: "turn on the learning" });
  assert.equal(clear.status, "ready");
  assert.equal(clear.setting, "fly-core.mode");
  assert.deepEqual(clear.preview, [{ setting: "fly-core.mode", name: "What Branch learns from experience", label: "Switch",
    from: "off", to: "on", lessCareful: false, pinned: false }]);
  assert.equal(clear.useTool, "settings.change");
  assert.equal((await values())["fly-core.mode"], "off", "finding plans; it never writes");

  const said = await find({ request: "the wall", value: "on" });
  assert.equal(said.status, "ready", "a value only one field can hold settles which field");
  assert.equal(said.setting, "os-sandbox.mode");

  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  await app.registry.execute("settings.change", { changes: [{ setting: "fly-core.mode", value: "on" }] }, app.runtime.context({ source: "owner" }));
  const again = await find({ request: "turn on the learning" });
  assert.equal(again.status, "unchanged");
  assert.equal(again.preview, undefined, "a no-op is never shown as a change");
  assert.match(again.note, /already on/);
});

test("in a conversation, an ambiguous request reaches the model as a question and never asks to change anything", async (t) => {
  let calls = 0;
  const seen = [];
  const provider = {
    name: "scripted",
    async complete(request) {
      seen.push(JSON.stringify(request.messages));
      return calls++ === 0
        ? { content: "", toolCalls: [{ id: "find-call", name: "settings.find", arguments: JSON.stringify({ request: "turn on the board" }) }] }
        : { content: "Do you mean Project boards or The shared board?", toolCalls: [] };
    },
  };
  const { app, values } = await fixture(t, provider);
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  const before = await values();
  const done = await app.runtime.run({ prompt: "turn on the board" });
  assert.equal(done.status, "completed", done.output);
  assert.equal(app.runtime.approvals.questionFor(done.sessionId), undefined, "no change was put to the owner");
  assert.match(seen[1], /Which one do you mean|Do you mean/);
  assert.match(seen[1], /flowboards-kanban\.mode/);
  assert.deepEqual(await values(), before);
});

async function allRows(app) {
  const rows = [];
  for (let offset = 0; offset !== null;) {
    const page = await app.registry.execute("settings.list", { offset }, app.runtime.context({ source: "owner" }));
    rows.push(...page.shown);
    offset = page.nextOffset;
  }
  return rows;
}

function assertAsksOnly(result, phrasing) {
  assert.equal(result.status, "ask", `${phrasing}: ${JSON.stringify(result)}`);
  assert.equal(result.planned, false, phrasing);
  assert.equal(result.preview, undefined, `${phrasing}: nothing is planned`);
  assert.equal(result.useTool, undefined, phrasing);
  assert.equal((result.question.match(/\?/g) ?? []).length, 1, `${phrasing}: exactly one question`);
  assert.match(result.question, /say not to/, phrasing);
}

test("a request that says not to is never planned as a change, for loosening settings too", async (t) => {
  const { find, values } = await fixture(t);
  const before = await values();
  const screen = await find({ request: "don't turn on Your screen and keyboard" });
  assertAsksOnly(screen, "don't turn on Your screen and keyboard");
  assert.deepEqual(screen.choices, [{ setting: "desktop-control.mode", name: "Your screen and keyboard", value: "off" }]);
  assert.match(screen.question, /"Your screen and keyboard" change from off/);
  const phrasings = [
    "Don’t turn on your screen and keyboard",
    "do not turn on the wake word",
    "please never switch on the model arena",
    "no longer turn on skill bundles",
    "not your screen and keyboard, turn it on",
    "doesnt need the wake word on",
    "don't turn off the learning",
    "n'active pas le mot de réveil",
    "ne mets jamais l'écran",
    "n'allume plus la caméra",
  ];
  for (const request of phrasings) assertAsksOnly(await find({ request }), request);
  assertAsksOnly(await find({ request: "don't turn on Your screen and keyboard", value: "on" }), "a said value does not override the not");
  assert.equal((await find({ request: "turn on notes with rewriting" })).status, "ready", "notes is not a negation");
  assert.deepEqual(await values(), before);
});

test("every setting that would loosen when asked plainly still asks when the words say don't", async (t) => {
  const { app, find, values } = await fixture(t);
  const before = await values();
  let loosening = 0;
  for (const row of await allRows(app)) {
    const words = row.label === "Switch" ? row.name : `${row.name} ${row.label}`;
    const plain = await find({ request: `turn on ${words}` });
    if (plain.status !== "ready" || !plain.preview.some((one) => one.lessCareful)) continue;
    loosening += 1;
    assertAsksOnly(await find({ request: `don't turn on ${words}` }), `don't turn on ${words}`);
    assertAsksOnly(await find({ request: `never turn on ${words}` }), `never turn on ${words}`);
  }
  assert.ok(loosening >= 17, `found ${loosening} loosening settings`);
  assert.deepEqual(await values(), before);
});
