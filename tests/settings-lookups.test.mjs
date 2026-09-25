/**
 * Dogfood A5 and B20: finding one of Branch's own settings costs one settings.find, then one change or one clear
 * answer, and a little context.
 *
 *   - settings.find reads the plain words people use for a setting (src/settings-kit/phrases.ts) as well as its
 *     name, label and window words. Updating by itself is the owner's own card, so it is named with where it is,
 *     in one step, and so is the window's look (dark mode, the text size), unless the words name one of Branch's own
 *     settings beside it. Words that fit no setting are never answered with a question that has nothing to choose from.
 *   - A request about Branch's own settings starts with settings.find and settings.change in reach, so no
 *     tools.search comes first. An unrelated request does not get them ("add a dark mode to my website"), and Plan
 *     still refuses the change.
 *   - settings.list: a search gives the few rows that fit, best first, without fields that only repeat the obvious.
 *
 * Every task runs on its own data folder with a scripted model; nothing reaches the network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { readComfort } from "../dist/comfort/settings.js";
import { preferences } from "../dist/preferences.js";
import * as settingsKit from "../dist/settings-kit/tools.js";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-lookups-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const context = () => app.runtime.context({ source: "owner" });
  const find = (input) => app.registry.execute("settings.find", input, context());
  const list = (input) => app.registry.execute("settings.list", input, context());
  return { app, find, list, context };
}

/**
 * A model that works the way B20's did, from the tools it is shown: settings.find when it can see it, a tool search
 * when it cannot. It then makes the change settings.find planned, or says what settings.find answered.
 */
function b20Model() {
  const calls = [], results = [], rounds = [];
  const step = (name, args) => { calls.push(name); return { content: "", toolCalls: [{ id: `call-${calls.length}`, name, arguments: JSON.stringify(args) }] }; };
  const provider = {
    name: "scripted",
    async complete(request) {
      const seen = request.tools.map((tool) => tool.name);
      rounds.push({ tools: seen, characters: JSON.stringify(request.messages).length + JSON.stringify(request.tools).length });
      const last = request.messages.at(-1);
      const asked = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
      if (last.role === "user") {
        if (/go ahead/i.test(asked)) return step("settings.change", provider.planned);
        return seen.includes("settings.find") ? step("settings.find", { request: asked }) : step("tools.search", { query: asked });
      }
      results.push({ name: calls.at(-1), characters: last.content.length });
      if (calls.at(-1) === "tools.search")
        return seen.includes("settings.find") ? step("settings.find", { request: asked }) : { content: "I could not find a way to do that.", toolCalls: [] };
      const found = JSON.parse(last.content).result ?? {};
      if (calls.at(-1) === "settings.find" && found.status === "ready") {
        provider.planned = { changes: found.preview.map((one) => ({ setting: one.setting, value: one.to })) };
        return step("settings.change", provider.planned);
      }
      return { content: found.question ?? found.note ?? "Done.", toolCalls: [] };
    },
  };
  return { provider, calls, results, rounds };
}

test("B20: \"turn on automatic updates\" names the owner's own card in one step, with nothing planned", async (t) => {
  const { app, find } = await fixture(t);
  for (const request of ["turn on automatic updates", "turn on update by itself", "please make Branch update itself"]) {
    const found = await find({ request });
    assert.equal(found.status, "elsewhere", `${request}: ${JSON.stringify(found)}`);
    assert.equal(found.setting, "Updating by itself");
    assert.equal(found.where, "settings:about");
    assert.equal(found.planned, false);
    assert.equal(found.question, undefined, `${request}: nothing to choose from, so no question`);
    assert.match(found.note, /changed only by the owner, in Settings, Updates & about, Updating by itself \(off, check or install\)/);
    assert.ok(JSON.stringify(found).length < 400, `${request}: a short answer, not ${JSON.stringify(found).length} characters`);
  }
  const channel = await find({ request: "switch to the dev channel" });
  assert.equal(channel.status, "elsewhere");
  assert.equal(channel.setting, "Update channel");
  const notify = readComfort(app.store, app.runtime.owner, "notify");
  assert.deepEqual([notify.autoUpdate, notify.releaseChannel], ["off", "stable"], "finding it changes nothing");
});

/**
 * The window's look is the owner's own, on the Appearance page: each request names its control there, in the words the
 * window shows (public/locales/en.json), with its choices. Nothing is planned and nothing changes, and the first
 * request, which is aimed at Branch, starts with the settings tools in reach.
 */
async function namesTheAppearanceCard(t, control, requests) {
  const { app, find, context } = await fixture(t);
  const shown = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const { name, choices } = control(shown);
  const place = [shown["settings.title"], shown["settings.page.appearance"], shown["settingsGrown.bucket.appearance.theme"], name].join(", ");
  for (const request of requests) {
    const found = await find({ request });
    assert.equal(found.status, "elsewhere", `${request}: ${JSON.stringify(found)}`);
    assert.equal(found.setting, name, request);
    assert.equal(found.where, "settings:appearance", `${request}: the Appearance page`);
    assert.equal(found.planned, false);
    assert.equal(found.question, undefined, `${request}: nothing to choose from, so no question`);
    assert.ok(found.note.includes(`changed only by the owner, in ${place} (${choices}).`), `${request}: ${found.note}`);
  }
  assert.deepEqual(settingsKit.settingsPreload(app.store, context(), requests[0], app.registry.names()).map((one) => one.name),
    ["settings.find", "settings.change"], `${requests[0]}: the settings tools are in reach from the first round`);
  const look = preferences(app.store, app.runtime.owner);
  assert.deepEqual([look.appearance, look.followSystem, look.textSize], ["forest", false, "medium"], "finding it changes nothing");
}

test("dark mode names Day or night on the Appearance card in one step, in the window's own words, with nothing planned", async (t) => {
  await namesTheAppearanceCard(t, (shown) => ({ name: shown["look.dayOrNight"],
    choices: `${shown["look.mode.follow"]}, ${shown["look.moonlight"]} or ${shown["look.daylight"]}` }),
  ["turn on dark mode", "dark mode", "switch to light mode", "use a dark theme", "night mode", "change the theme", "appearance"]);
});

test("bigger text names Text size on the Appearance card in one step, in the window's own words, with nothing planned", async (t) => {
  await namesTheAppearanceCard(t, (shown) => ({ name: shown["appearance.textSize"],
    choices: `${shown["appearance.textSize.small"]}, ${shown["appearance.textSize.medium"]} or ${shown["appearance.textSize.large"]}` }),
  ["make Branch's text bigger", "make the text bigger", "bigger text", "make the text smaller", "text size", "increase the font size"]);
});

test("the words for the window's look take nothing from the settings Branch can change", async (t) => {
  const { find } = await fixture(t);
  const wake = await find({ request: "turn the wake word on" });
  assert.equal(wake.status, "ready", JSON.stringify(wake));
  assert.equal(wake.setting, "wake-word.mode");
  assert.equal(wake.useTool, "settings.loosen");
  const updates = await find({ request: "turn on automatic updates" });
  assert.deepEqual([updates.status, updates.setting, updates.where], ["elsewhere", "Updating by itself", "settings:about"]);
  const unknown = await find({ request: "blue elephants" });
  assert.equal(unknown.status, "none", JSON.stringify(unknown));
  assert.match(unknown.note, /No setting Branch can change matches "blue elephants"/);
});

test("a word for the window's look beside one of Branch's own settings asks about that setting, not the Appearance card", async (t) => {
  const { find } = await fixture(t);
  for (const [request, settings] of [["change the appearance of the status line", ["comfort-display.timestamps"]],
    ["turn on the focus view theme", ["flowboards-focus.mode"]], ["make the status line text bigger", ["comfort-display.timestamps"]],
    ["change the theme of the notification sounds", ["comfort-notify.method", "comfort-notify.sound"]]]) {
    const found = await find({ request });
    assert.equal(found.status, "ask", `${request}: ${JSON.stringify(found)}`);
    assert.deepEqual(found.choices.map((one) => one.setting), settings, request);
    assert.match(found.question, /^No setting is called exactly that\. Do you mean /, request);
    assert.equal(found.planned, false);
  }
  for (const request of ["switch the whole window to dark mode", "bigger text everywhere", "the text size is too small"]) {
    const found = await find({ request });
    assert.equal(found.status, "elsewhere", `${request}: the other words name no setting, so the card is named: ${JSON.stringify(found)}`);
  }
});

test("the words for the window's look bring the settings tools only when the request is aimed at Branch", async (t) => {
  const model = b20Model();
  const { app, context } = await fixture(t, model.provider);
  const names = app.registry.names();
  const preload = (words) => settingsKit.settingsPreload(app.store, context(), words, names).map((one) => one.name);
  for (const words of ["turn on dark mode", "switch to light mode", "toggle dark mode", "make Branch's text bigger", "change your theme"])
    assert.deepEqual(preload(words), ["settings.find", "settings.change"], `${words}: aimed at Branch`);
  for (const words of ["add a dark mode to my website", "fix the theme of my React app", "change the font size in the CSS",
    "make the text bigger in my slides", "improve the appearance of the landing page", "summarize the main theme"])
    assert.deepEqual(preload(words), [], `${words}: about something else`);
  const opening = async (prompt) => { model.rounds.length = 0; await app.runtime.run({ prompt }); return model.rounds[0].tools; };
  assert.ok(!(await opening("add a dark mode to my website")).includes("settings.find"), "a task about a website starts without them");
  assert.ok((await opening("turn on dark mode")).includes("settings.find"), "a task that turns on dark mode starts with them");
});

test("B20: a phrase people use picks its setting, a phrase that fits two asks one question, and near words name their settings", async (t) => {
  const { find } = await fixture(t);
  const screen = await find({ request: "turn on computer use" });
  assert.equal(screen.status, "ready", JSON.stringify(screen));
  assert.equal(screen.setting, "desktop-control.mode", "the phrase, not every setting with \"computer\" in its name");
  assert.equal(screen.preview[0].lessCareful, true, "and it is still weighed as less careful, so the owner is asked every time");

  const telemetry = await find({ request: "turn off telemetry" });
  assert.equal(telemetry.status, "ask", JSON.stringify(telemetry));
  assert.deepEqual(telemetry.choices.map((one) => one.setting).sort(), ["asks-analytics.mode", "execution-metrics.mode"]);
  assert.equal((telemetry.question.match(/\?/g) ?? []).length, 1, "exactly one question");
  assert.match(telemetry.question, /Counting how Branch is used/);

  const near = await find({ request: "turn on the wake thing" });
  assert.equal(near.status, "ask", JSON.stringify(near));
  assert.deepEqual(near.choices.map((one) => one.setting), ["wake-word.mode"], "the switch, the one that can be on");
  assert.match(near.question, /Do you mean "A word that starts a turn: Switch"\?$/);
  assert.equal(near.preview, undefined, "a near guess is only ever asked about, never planned");
});

test("B20: a scripted task reaches the change in two tool calls, with no tools.search and no settings.list", async (t) => {
  const model = b20Model();
  const { app } = await fixture(t, model.provider);
  const paused = await app.runtime.run({ prompt: "turn on the learning core" });
  assert.deepEqual(model.calls, ["settings.find", "settings.change"], `calls: ${model.calls.join(", ")}`);
  assert.ok(model.rounds[0].tools.includes("settings.find") && model.rounds[0].tools.includes("settings.change"), "both are there from the first round");
  assert.equal(paused.status, "needs_input", "the change is put to the owner");
  const asked = app.runtime.approvals.questionFor(paused.sessionId);
  assert.match(asked.label, /What Branch learns from experience, Switch: off → on/, "with its exact before and after");
  assert.deepEqual(model.results.map((one) => one.name), ["settings.find"], "one answer went back to the model before the question");
  assert.ok(model.results[0].characters < 600, `settings.find sent back ${model.results[0].characters} characters`);
  assert.ok(model.rounds.at(-1).characters < 12000, `the last request was ${model.rounds.at(-1).characters} characters (B20 replayed: 38,900 by its 7th round)`);

  app.runtime.approve(paused.sessionId, "allow", "session");
  const done = await app.runtime.run({ prompt: "Yes, go ahead.", sessionId: paused.sessionId });
  assert.equal(done.status, "completed", done.output);
  assert.equal(app.learningCore.settings().mode, "on", "the owner's one yes made the one change");
  assert.ok(!model.calls.some((name) => name === "tools.search" || name === "settings.list"), `calls: ${model.calls.join(", ")}`);
});

test("B20: a scripted task asked to turn on automatic updates answers in one call and a few hundred characters", async (t) => {
  const model = b20Model();
  const { app } = await fixture(t, model.provider);
  const done = await app.runtime.run({ prompt: "turn on automatic updates" });
  assert.equal(done.status, "completed", done.output);
  assert.deepEqual(model.calls, ["settings.find"], `calls: ${model.calls.join(", ")}`);
  assert.match(done.output, /changed only by the owner, in Settings, Updates & about/);
  assert.doesNotMatch(done.output, /Which setting do you mean/);
  assert.ok(model.results[0].characters < 400, `settings.find sent back ${model.results[0].characters} characters`);
  assert.ok(model.rounds.at(-1).characters < 12000, `the last request was ${model.rounds.at(-1).characters} characters`);
  assert.equal(app.runtime.approvals.questionFor(done.sessionId), undefined, "nothing is put to the owner");
  assert.equal(readComfort(app.store, app.runtime.owner, "notify").autoUpdate, "off");
});

test("A5: a settings.list search gives the best few rows first, each without the fields that only repeat the obvious", async (t) => {
  const { app, list } = await fixture(t);
  const wake = (await list({ search: "wake words" })).shown;
  assert.deepEqual(wake.slice(0, 2).map((row) => row.setting), ["wake-word.mode", "wake-word.sureness"], "the rows holding both words come first");
  assert.ok(wake.slice(2).some((row) => row.setting === "live-dictation.mode"), "then rows holding one of them");
  assert.ok(wake.length <= 8, `${wake.length} rows`);
  assert.match(wake[0].lessCareful, /^turning it up/, "a less careful way is kept where there is one");
  const voice = (await list({ search: "voice mode" })).shown.map((row) => row.setting);
  assert.deepEqual(voice.slice(0, 3), ["speech-engines.mode", "wake-word.mode", "live-dictation.mode"], "rows holding both words first");
  assert.ok(voice.includes("voice.systemVoice"), "then the voice settings: \"mode\" ends every switch's name, so it picks none out");
  assert.equal((await list({ search: "dark mode" })).total, 0, "and on its own it finds nothing rather than every switch");

  const sounds = await list({ search: "notification sounds" });
  assert.deepEqual(sounds.shown.map((row) => row.setting), ["comfort-notify.method", "comfort-notify.sound"], "a plural still finds them");
  const sound = sounds.shown[1];
  for (const field of ["startsAs", "pinned", "lessCareful"]) assert.equal(field in sound, false, `${field} only repeats the obvious here`);
  assert.deepEqual(sound.choices, ["off", "chime", "knock"], "what settings.change takes is still there");

  const files = await list({ search: "files" });
  assert.ok(files.total > 8, `${files.total} rows hold the word`);
  assert.equal(files.shown.length, 8, "a search shows the few that fit unless it asks for more");
  assert.equal(files.nextOffset, 8);
  assert.equal((await list({ search: "files", limit: 40 })).shown.length, files.total, "a limit still asks for more");

  const made = await app.registry.execute("settings.change", { changes: [{ setting: sound.setting, value: sound.choices[1] }] },
    app.runtime.context({ source: "owner" }));
  assert.deepEqual(made.changed, ["Notifications and sound, Sound: off → chime"], "settings.change takes the names settings.list gives");
  const changed = (await list({ search: "notification sounds" })).shown[1];
  assert.deepEqual([changed.value, changed.startsAs], ["chime", "off"], "how it starts is shown once it differs");
  assert.deepEqual((await list({ onlyChanged: true })).shown.map((row) => row.setting), ["comfort-notify.sound"]);

  const updates = await list({ search: "automatic updates" });
  assert.match(updates.note, /"Updating by itself" is changed only by the owner/, "a search for the owner's own card says where it is");
});

test("B20: the opening catalog has settings.find and settings.change for a settings request, and not for an unrelated one", async (t) => {
  const model = b20Model();
  const { app, context } = await fixture(t, model.provider);
  const opening = async (prompt) => {
    model.rounds.length = 0;
    const run = await app.runtime.run({ prompt });
    const preselected = app.store.events(run.id).find((event) => event.kind === "catalog.preselected").data;
    return { tools: model.rounds[0].tools, preloaded: preselected.preloadedFromHistory.map((entry) => entry.name) };
  };
  for (const prompt of ["turn on automatic updates", "switch off the learning core", "please turn on the wake word so I can talk to you",
    "which of my settings are off?"]) {
    const { tools, preloaded } = await opening(prompt);
    for (const name of ["settings.find", "settings.change"]) {
      assert.ok(tools.includes(name), `${prompt}: ${name} is shown from the first round`);
      assert.ok(preloaded.includes(name), `${prompt}: and the run's record says why`);
    }
  }
  for (const prompt of ["turn on the lights in the kitchen", "switch to the other branch", "what is 17 x 23?", "write a haiku about autumn"]) {
    const { tools, preloaded } = await opening(prompt);
    assert.ok(!tools.includes("settings.find") && !tools.includes("settings.change"), `${prompt}: ${tools.join(", ")}`);
    assert.ok(!preloaded.includes("settings.find"), prompt);
  }
  const names = app.registry.names();
  assert.deepEqual(settingsKit.settingsPreload(app.store, context(), "turn on the wake word", names).map((one) => one.name), ["settings.find", "settings.change"]);
  for (const source of ["schedule", "channel", "trigger"])
    assert.deepEqual(settingsKit.settingsPreload(app.store, app.runtime.context({ source }), "turn on the wake word", names), [], `not for a ${source}`);
});

test("B20: the answer to settings.find's question starts with the settings tools too, and a tool's result never brings them", async (t) => {
  const model = b20Model();
  const { app } = await fixture(t, model.provider);
  const first = await app.runtime.run({ prompt: "turn on the board" });
  assert.deepEqual(model.calls, ["settings.find"]);
  assert.match(first.output, /Do you mean "Project boards" or "The shared board"\?/);
  model.rounds.length = 0;
  await app.runtime.run({ prompt: "the shared board", sessionId: first.sessionId });
  assert.ok(model.rounds[0].tools.includes("settings.find") && model.rounds[0].tools.includes("settings.change"),
    `the owner's answer is read with their question before it: ${model.rounds[0].tools.join(", ")}`);

  const seen = { tools: [] };
  const other = await fixture(t, {
    name: "scripted",
    async complete(request) {
      const last = request.messages.at(-1);
      if (last.role === "user" && /17 x 23/.test(last.content))
        return { content: "", toolCalls: [{ id: "help", name: "help.search", arguments: JSON.stringify({ question: "settings" }) }] };
      if (last.role === "tool") return { content: "391", toolCalls: [] };
      seen.tools = request.tools.map((tool) => tool.name);
      return { content: "Leaves fall slowly.", toolCalls: [] };
    },
  });
  const sum = await other.app.runtime.run({ prompt: "what is 17 x 23?" });
  const toolResult = other.app.store.messages(sum.sessionId).find((message) => message.role === "tool")?.content ?? "";
  assert.match(toolResult, /settings/i, "the earlier tool's result talks about settings");
  const haiku = await other.app.runtime.run({ prompt: "write a haiku about autumn", sessionId: sum.sessionId });
  const preloaded = other.app.store.events(haiku.id).find((event) => event.kind === "catalog.preselected").data.preloadedFromHistory;
  assert.deepEqual(preloaded.filter((entry) => entry.name.startsWith("settings.")), [], "only the person's own words bring the settings tools");
  assert.ok(seen.tools.length > 0);
});

test("Q59: in a Plan conversation the settings tools are shown, and a change is still refused, not asked", async (t) => {
  const tried = { change: false, tools: [] };
  const provider = {
    name: "scripted",
    async complete(request) {
      const tools = request.tools.map((tool) => tool.name);
      if (!tools.length) return { content: "1. Turn on the learning core.", toolCalls: [] }; // Plan's own round, which has no tools
      if (tried.change) return { content: "Plan refuses that.", toolCalls: [] };
      tried.change = true;
      tried.tools = tools;
      return { content: "", toolCalls: [{ id: "change", name: "settings.change", arguments: JSON.stringify({ changes: [{ setting: "fly-core.mode", value: "on" }] }) }] };
    },
  };
  const { app } = await fixture(t, provider);
  const run = await app.runtime.run({ prompt: "turn on the learning core", conversationMode: "plan" });
  assert.ok(tried.tools.includes("settings.find") && tried.tools.includes("settings.change"), `the tools are shown: ${tried.tools.join(", ")}`);
  assert.equal(run.status, "completed", run.output);
  const denied = app.store.events(run.id).filter((event) => event.kind === "policy.denied").map((event) => event.data.name);
  assert.deepEqual(denied, ["settings.change"], "Plan refuses the change");
  assert.equal(app.runtime.approvals.questionFor(run.sessionId), undefined, "and puts no question to the owner");
  assert.equal(app.learningCore.settings().mode, "off", "nothing changed");
  const planContext = app.runtime.context({ runId: run.id });
  assert.equal(app.runtime.checkPolicy("settings.change", { changes: [{ setting: "fly-core.mode", value: "on" }] }, planContext).decision, "deny");
  assert.equal(app.runtime.checkPolicy("settings.find", { request: "turn on the learning core" }, planContext).decision, "allow", "finding stays free");
});
