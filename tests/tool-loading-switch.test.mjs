/**
 * Owner item 17: one Tool loading switch over everything switched on.
 * On (deferred, as shipped): a feature switched on keeps its tools a search away until a task calls
 * for them. Off (eager): everything switched on travels in full from the first round and is never
 * trimmed to fit, so the owner can make their agents follow it. "Off" features stay hidden, and
 * Lockdown still wins, whichever way the switch is.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { z } from "zod";
import { switchedToolTiers, toolLoading, loadsEagerly, toolLoadingKey, eagerFit } from "../dist/feature-switches.js";
import { saveKnobs } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { ToolLoader } from "../dist/tool-loading.js";
import { settingsCatalogue } from "../dist/settings-kit/catalogue.js";

async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-tool-loading-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: provider ?? { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
const setLoading = (app, mode) => app.store.save("settings", app.runtime.owner, toolLoadingKey, { mode });

test("the one rule: on always loads, when needed loads up front only with Tool loading off", () => {
  assert.equal(loadsEagerly("on", "deferred"), true);
  assert.equal(loadsEagerly("on", "eager"), true);
  assert.equal(loadsEagerly("when-needed", "deferred"), false);
  assert.equal(loadsEagerly("when-needed", "eager"), true);
  assert.equal(loadsEagerly("off", "eager"), false, "off is never loaded");
});

test("Tool loading ships on (deferred), and a damaged record reads as shipped", async (t) => {
  const app = await fixture(t);
  assert.equal(toolLoading(app.store, app.runtime.owner), "deferred");
  app.store.save("settings", app.runtime.owner, toolLoadingKey, { mode: "sideways" });
  assert.equal(toolLoading(app.store, app.runtime.owner), "deferred");
  const spec = settingsCatalogue.find((entry) => entry.key === toolLoadingKey);
  assert.deepEqual(spec.fields[0].kind, { type: "choice", options: ["deferred", "eager"] });
  assert.equal(spec.fields[0].initial, "deferred");
});

test("with Tool loading off, a feature switched on is preloaded and forced; off stays hidden; Lockdown wins", async (t) => {
  const app = await fixture(t);
  const owner = app.runtime.owner;
  app.store.save("settings", owner, "web-pages", { mode: "when-needed" });
  app.store.save("settings", owner, "page-notes", { mode: "off" });
  const available = [...app.registry.descriptions(new Set(app.registry.permissions())).map((tool) => tool.name), "browser.notes"];
  let tiers = switchedToolTiers(app.store, owner, available);
  assert.ok(!tiers.preload.some((entry) => entry.name === "web.page"), "deferred: a search away, as today");
  assert.deepEqual(tiers.forced, []);
  setLoading(app, "eager");
  tiers = switchedToolTiers(app.store, owner, available);
  assert.ok(tiers.preload.some((entry) => entry.name === "web.page") && tiers.forced.includes("web.crawl"), "eager: loaded up front and forced");
  assert.ok(tiers.hidden.includes("browser.notes"), "a feature switched off stays hidden");
  assert.ok(!tiers.preload.some((entry) => tiers.hidden.includes(entry.name)), "nothing hidden is preloaded");
  // Screen control is one Lockdown covers: switched on and forced, then Lockdown takes it away again.
  app.store.save("settings", owner, "desktop-control", { mode: "when-needed" });
  const withScreen = [...available, "desktop.screenshot"];
  assert.ok(switchedToolTiers(app.store, owner, withScreen).forced.includes("desktop.screenshot"));
  app.store.save("settings", owner, "lockdown", { on: true });
  tiers = switchedToolTiers(app.store, owner, withScreen);
  assert.ok(!tiers.forced.includes("desktop.screenshot") && tiers.hidden.includes("desktop.screenshot"), "Lockdown switches it off whatever Tool loading says");
});

test("a forced tool travels in full whatever the ceiling; without forcing, the ceiling trims it", () => {
  const big = (name) => ({ name, description: `${name} ${"does a great many careful things. ".repeat(40)}`, parameters: { type: "object", properties: {} } });
  const tools = ["alpha.one", "alpha.two", "alpha.three", "alpha.four"].map(big);
  const preload = tools.map((tool) => ({ name: tool.name, reason: "switched on" }));
  const names = (loader) => loader.descriptions().map((tool) => tool.name);
  const trimmed = new ToolLoader(tools, { preload, budgetTokens: 300 });
  assert.ok(names(trimmed).filter((name) => name.startsWith("alpha.")).length < 4, "the ceiling takes preloaded tools back");
  const forced = new ToolLoader(tools, { preload, forced: tools.map((tool) => tool.name), budgetTokens: 300 });
  assert.deepEqual(names(forced).filter((name) => name.startsWith("alpha.")).sort(), tools.map((tool) => tool.name).sort(), "forced: every one, in full");
  // Loaded means loaded: not listed again in the index, and not counted among the tools left undescribed.
  const indexText = (loader) => loader.descriptions().filter((tool) => !tool.name.startsWith("alpha.")).map((tool) => tool.description).join(" ");
  assert.equal(forced.stats().deferred, 0, "under a tight ceiling, nothing forced is counted as left out");
  assert.ok(!tools.some((tool) => indexText(forced).includes(tool.name)), "nothing forced is listed in the index");
  const roomy = new ToolLoader(tools.slice(0, 2), { preload: preload.slice(0, 2), forced: ["alpha.one", "alpha.two"], budgetTokens: 100000 });
  assert.deepEqual({ indexed: roomy.stats().indexed, deferred: roomy.stats().deferred }, { indexed: 0, deferred: 0 });
  assert.ok(!["alpha.one", "alpha.two"].some((name) => indexText(roomy).includes(name)), "with room: loaded once, not listed again");
});

test("end to end: the model receives the switched-on tools in full only with Tool loading off", async (t) => {
  const seen = [];
  const app = await fixture(t, { name: "scripted", async complete(request) { seen.push(request.tools.map((tool) => tool.name)); return { content: "ok", toolCalls: [] }; } });
  app.store.save("settings", app.runtime.owner, "web-pages", { mode: "when-needed" });
  await app.runtime.run({ prompt: "hello", permissions: ["web.read"] });
  assert.ok(!seen.at(-1).includes("web.page"), "deferred: not in the request");
  setLoading(app, "eager");
  await app.runtime.run({ prompt: "hello", permissions: ["web.read"] });
  assert.ok(seen.at(-1).includes("web.page") && seen.at(-1).includes("web.crawl"), "eager: both in full");
});

test("eager is honoured only when it fits a quarter of the model's room", () => {
  assert.deepEqual(eagerFit(2000, 8000), { fits: true, tokens: 2000, room: 8000, limit: 2000 });
  assert.equal(eagerFit(2001, 8000).fits, false);
});

test("when what Tool loading off would force is too big for this model, the task loads when needed and says why", async (t) => {
  const seen = [];
  const app = await fixture(t, { name: "scripted", async complete(request) { seen.push(request.tools.map((tool) => tool.name)); return { content: "ok", toolCalls: [] }; } });
  const owner = app.runtime.owner;
  // A switched feature whose one tool is far larger than a quarter of the smallest room a model may have.
  const fields = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`field${i}`, z.string().optional().describe(`What field ${i} holds, in a long careful sentence.`)]));
  app.registry.register({ name: "browser.notes", description: "Page notes.",
    permission: "files.read", parameters: z.object(fields).strict(), execute: async () => "ok" });
  app.store.save("settings", owner, "page-notes", { mode: "when-needed" });
  saveKnobs(app.store, owner, "compaction", { contextWindowTokens: 8000 });
  setLoading(app, "eager");
  const run = await app.runtime.run({ prompt: "hello", permissions: ["files.read"] });
  assert.ok(!seen.at(-1).includes("browser.notes"), "not sent in full: it would not fit");
  const note = app.store.events(run.id).find((event) => event.kind === "tools.eager_too_big");
  assert.ok(note && note.data.tokens > note.data.limit && note.data.limit === 2000, JSON.stringify(note?.data));
  assert.match(note.data.note, /more than the 2000 this model's room allows for tools, so this task loads them when needed/);
});

test("Settings can read what Tool loading off would cost, and switch it; a short-lived key cannot", async (t) => {
  const app = await fixture(t);
  const server = await startServer(app, { dataDir: app.store.folder, port: 0 });
  t.after(() => server.close());
  const call = async (body, key = server.token) => {
    const response = await fetch(server.url + "/api/tool-loading", { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  app.store.save("settings", app.runtime.owner, "web-pages", { mode: "when-needed" });
  const cost = (await call()).body;
  assert.equal(cost.mode, "deferred");
  assert.ok(cost.tools >= 2 && cost.tokens > 0 && cost.fits === true && cost.limit === Math.floor(cost.room / 4), JSON.stringify(cost));
  assert.equal((await call({ mode: "eager" })).body.mode, "eager");
  assert.equal((await call({ mode: "sideways" })).status, 400);
  const key = app.sessionTokens.create(app.runtime.owner, { name: "phone", scope: "run" }).token;
  assert.ok([401, 403].includes((await call({ mode: "deferred" }, key)).status));
  assert.ok([401, 403].includes((await call(undefined, key)).status), "nor read it");
  assert.equal(toolLoading(app.store, app.runtime.owner), "eager", "the key changed nothing");
});

test("the fit is measured on what the model receives: a saved note can push a set that looked small over", async (t) => {
  const seen = [];
  const app = await fixture(t, { name: "scripted", async complete(request) { seen.push(request.tools.map((tool) => tool.name)); return { content: "ok", toolCalls: [] }; } });
  const owner = app.runtime.owner;
  saveKnobs(app.store, owner, "compaction", { contextWindowTokens: 8000 }); // a quarter: 2,000 for forced tools
  app.store.save("settings", owner, "page-notes", { mode: "when-needed" });
  setLoading(app, "eager");
  const build = (fields, pad) => ({ name: "browser.notes", description: "Page notes." + " note".repeat(pad), permission: "files.read",
    parameters: z.object(Object.fromEntries(Array.from({ length: fields }, (_, i) => [`f${i}`, z.string().optional().describe(`Field ${i}.`)]))).strict(), execute: async () => "ok" });
  // Weighed exactly as a task weighs it: the registry's own description, through the runtime.
  const weigh = () => app.runtime.forcedToolTokens(owner, app.registry.descriptions(new Set(["files.read"])), ["browser.notes"]);
  let chosen = false;
  for (let fields = 1; fields < 600 && !chosen; fields += 5)
    for (let pad = 0; pad < 60; pad++) {
      app.registry.register(build(fields, pad));
      const raw = weigh();
      if (raw > 1990 && raw <= 2000) { chosen = true; break; }
      app.registry.unregister("browser.notes");
      if (raw > 2000) break;
    }
  assert.ok(chosen, "a tool that sits just under the limit");
  const raw = weigh();
  await app.runtime.run({ prompt: "hello", permissions: ["files.read"] });
  assert.ok(seen.at(-1).includes("browser.notes"), "as it stands it fits, and travels in full");
  // What is remembered about the tool travels with it, and that is what tips it over.
  app.store.toolUsage.addNote(owner, { tool: "browser.notes", note: "Keeps short notes beside a page you are reading, one per page, and finds them again by the page's address later." });
  const run = await app.runtime.run({ prompt: "hello", permissions: ["files.read"] });
  assert.ok(!seen.at(-1).includes("browser.notes"), "with its note it no longer fits: loaded when needed");
  const event = app.store.events(run.id).find((one) => one.kind === "tools.eager_too_big");
  assert.ok(event && event.data.tokens > 2000 && event.data.tokens > raw, JSON.stringify(event?.data));
  assert.equal(event.data.tokens, weigh(), "the task weighed the tool with its note");
  // Settings says the same, measured the same way.
  const server = await startServer(app, { dataDir: app.store.folder, port: 0 });
  t.after(() => server.close());
  const cost = await (await fetch(server.url + "/api/tool-loading", { headers: { authorization: `Bearer ${server.token}` } })).json();
  assert.deepEqual({ fits: cost.fits, tokens: cost.tokens }, { fits: false, tokens: event.data.tokens });
});

test("what Tool loading could not do is on the task's Look inside screen and in the terminal", async (t) => {
  const app = await fixture(t);
  const { inspectRun } = await import("../dist/inspect.js");
  const { progressLine } = await import("../dist/terminal.js");
  const run = app.store.createRun(app.runtime.owner, "anything");
  app.store.event(run.id, "tools.eager_too_big", { tokens: 3000, limit: 2000, room: 8000, fits: false, tools: 4, note: "Loading everything switched on up front would take about 3000 tokens, more than the 2000 this model's room allows for tools, so this task loads them when needed." });
  const view = inspectRun(app.store, run.id, { receipts: { items: [], counts: {} }, timeline: [], cost: null, version: "test" });
  assert.match(view.loading[0].text, /more than the 2000 this model's room allows for tools/);
  const event = app.store.events(run.id).find((one) => one.kind === "tools.eager_too_big");
  assert.match(progressLine(event), /^\[Loading everything switched on up front would take about 3000 tokens/);
});

test("a household profile cannot read or change how the assistant loads its tools", async (t) => {
  const app = await fixture(t);
  const server = await startServer(app, { dataDir: app.store.folder, port: 0 });
  t.after(() => server.close());
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  const post = await fetch(server.url + "/api/tool-loading", { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ mode: "eager" }) });
  assert.notEqual(post.status, 200);
  assert.equal(toolLoading(app.store, app.runtime.owner), "deferred", "nothing changed");
  assert.notEqual((await fetch(server.url + "/api/tool-loading", { headers: { authorization: `Bearer ${server.token}` } })).status, 200);
});
