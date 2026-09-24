/**
 * FQ-routing.isolated-agents: per-agent file roots.
 *
 * Memory already narrows what a Trunk's turn can read to its own scope (src/trunks/memory-scope.ts,
 * `visibleTo` in src/memory.ts). Files did not: every Trunk's turn resolved paths against the same
 * shared project as the owner and every other Trunk. This pins both: a Trunk's files now live in a
 * folder of their own (src/trunks/file-root.ts, wired through src/coding/index.ts's `placeTask`), and
 * a Trunk's private memory was already out of another Trunk's reach.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { call, fixture, on } from "./trunks-helpers.mjs";

/** The result (or error) of one named tool call on a run, from its own event trail. */
function toolOutcome(app, runId, name) {
  const events = app.store.events(runId);
  const done = events.find((e) => e.kind === "tool.completed" && e.data.name === name);
  if (done) return { ok: true, result: done.data.result };
  const failed = events.find((e) => (e.kind === "tool.failed" || e.kind === "tool.stalled") && e.data.name === name);
  if (failed) return { ok: false, error: String(failed.data.error ?? "") };
  throw new Error(`${name} never ran in run ${runId}`);
}

test("a Trunk's own file root: another Trunk can neither read nor list nor escape into it", async (t) => {
  const rules = [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text === "write") return call("files.write", { path: "note.md", content: "Ada's plan" });
    if (text === "read own") return call("files.read", { path: "note.md" });
    if (text.startsWith("read ")) return call("files.read", { path: text.slice("read ".length) });
    if (text === "list") return call("files.list", { path: "." });
    if (text === "grep") return call("files.grep", { query: "plan" });
    if (text === "glob") return call("files.glob", { patterns: ["**/*.md"] });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)];
  const { app, root } = await fixture(t, rules);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  const bo = app.trunks.create({ name: "Bo" });
  app.trunks.edit(ada.id, { permissions: ["files.read", "files.write"] });
  app.trunks.edit(bo.id, { permissions: ["files.read", "files.write"] });
  await app.trunks.introduced();

  // Ada writes in her own turn; it lands on disk under her own folder, not the shared workspace root.
  const wrote = await app.trunks.say(ada.id, "write");
  assert.equal(toolOutcome(app, wrote.runId, "files.write").ok, true);
  const adaFile = join(root, "workspace", ".branch-agents", ada.id, "note.md");
  assert.equal(await readFile(adaFile, "utf8"), "Ada's plan");
  assert.equal(existsSync(join(root, "workspace", "note.md")), false, "never written to the shared workspace");

  // Ada can read her own file back.
  const readOwn = await app.trunks.say(ada.id, "read own");
  assert.deepEqual(toolOutcome(app, readOwn.runId, "files.read"), { ok: true, result: { path: "note.md", content: "Ada's plan" } });

  // Bo, asked for the very same relative path, gets nothing: his own folder has no such file.
  const boRead = await app.trunks.say(bo.id, "read own");
  const boOutcome = toolOutcome(app, boRead.runId, "files.read");
  assert.equal(boOutcome.ok, false);
  assert.match(boOutcome.error, /ENOENT|no such file/i);
  assert.equal(existsSync(join(root, "workspace", ".branch-agents", bo.id, "note.md")), false);

  // Bo cannot list his way to it either: his own folder is empty.
  const boList = await app.trunks.say(bo.id, "list");
  assert.deepEqual(toolOutcome(app, boList.runId, "files.list").result.entries, []);

  // Nor can he reach across with a traversal path — refused before the filesystem is even touched.
  const escape = await app.trunks.say(bo.id, `read ../${ada.id}/note.md`);
  const escapeOutcome = toolOutcome(app, escape.runId, "files.read");
  assert.equal(escapeOutcome.ok, false);
  assert.match(escapeOutcome.error, /denied|outside/i);

  // Grep and glob walk from his own folder too, not the workspace root: neither finds Ada's file.
  const boGrep = await app.trunks.say(bo.id, "grep");
  assert.deepEqual(toolOutcome(app, boGrep.runId, "files.grep").result.matches, []);
  const boGlob = await app.trunks.say(bo.id, "glob");
  assert.deepEqual(toolOutcome(app, boGlob.runId, "files.glob").result.files, []);
});

test("a Trunk's own memory stays out of another Trunk's search and lookup", async (t) => {
  const rules = [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text === "remember") return call("memory.put", { text: "Ada's secret plan is launch Tuesday", source: "Ada", entity: "launch" });
    if (text === "search") return call("memory.search", { query: "secret plan" });
    if (text === "lookup") return call("memory.at", { entity: "launch" });
    if (text === "timeline") return call("memory.timeline", { entity: "launch" });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)];
  const { app, provider } = await fixture(t, rules);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  const bo = app.trunks.create({ name: "Bo" });
  app.trunks.edit(ada.id, { permissions: ["memory.write", "memory.read"] });
  app.trunks.edit(bo.id, { permissions: ["memory.write", "memory.read"] });
  await app.trunks.introduced();

  const put = await app.trunks.say(ada.id, "remember");
  const saved = toolOutcome(app, put.runId, "memory.put");
  assert.equal(saved.ok, true);
  assert.equal(saved.result.data.scope, `agent:trunk:${ada.id}`, "saved under Ada's own agent scope, not shared");

  // Ada finds her own fact.
  const adaSearch = await app.trunks.say(ada.id, "search");
  const adaHits = toolOutcome(app, adaSearch.runId, "memory.search").result;
  assert.ok(adaHits.some((r) => r.id === saved.result.id));

  // Bo's search, direct lookup and timeline all come back empty: it is not shared and not his.
  const boSearch = await app.trunks.say(bo.id, "search");
  assert.deepEqual(toolOutcome(app, boSearch.runId, "memory.search").result, []);
  const boLookup = await app.trunks.say(bo.id, "lookup");
  assert.deepEqual(toolOutcome(app, boLookup.runId, "memory.at").result, []);
  const boTimeline = await app.trunks.say(bo.id, "timeline");
  assert.deepEqual(toolOutcome(app, boTimeline.runId, "memory.timeline").result, []);

  // It never reaches Bo's model at all: nothing sent to the provider for his turns names the fact.
  const priorRequests = provider.requests.length;
  await app.trunks.say(bo.id, "search");
  assert.doesNotMatch(JSON.stringify(provider.requests.slice(priorRequests)), /launch Tuesday/);
});
