/**
 * What the tiers have to be worth, on top of being small (tests/tool-loading.test.mjs measures the
 * size). Three everyday jobs that cross several toolboxes are played out against the real tool list
 * and the rounds spent looking for a tool are counted; the rules that keep a job moving — a tool in
 * use is never put away, an opened toolbox carries what the request is about — are pinned; and the
 * two things a person is entitled to are checked: the tool section does not reshuffle behind a
 * provider's cache, and nothing the assistant learns can change what a tool is allowed to do.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { z } from "zod";
import { createBranch, ToolLoader, toolSearchName, toolDescribeName, toolNoteName, expandToolName, defaultMaxLoaded } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, provider, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-toolq-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, dataDir: join(root, "data") };
}
const groupOf = (app) => (name) => app.registry.groupOf(name);
const eventsOf = (app, runId, kind) => app.store.events(runId).filter((e) => e.kind === kind).map((e) => e.data);
const callOf = (name, args) => ({ content: "", toolCalls: [{ id: "c" + Math.random().toString(36).slice(2, 8), name, arguments: JSON.stringify(args) }] });
const groups = ["data", "research", "media", "channels", "browser", "desktop", "code", "documents", "agents"];

/** Fills the registry so these jobs are done on a computer with a thousand tools on it. */
function fillRegistry(app, total) {
  for (let i = app.registry.names().length; i < total; i++)
    app.registry.register({
      name: `${groups[i % groups.length]}.filler_${i}`,
      description: `Dummy tool ${i} standing in for an installed tool, with a description of the ordinary length a real one has.`,
      parameters: z.object({ path: z.string().min(1).max(500) }).strict(),
      permission: "files.read", execute: async () => ({ ok: true }),
    });
}

/**
 * A model working through a job. At each round it calls the next tool it needs if that tool is in
 * front of it. If not, it loads the tools it can name — from an index line, or because it searched
 * for them a moment ago — and otherwise it searches in the words a person would use. Every round
 * that goes on finding rather than doing is counted: those are the rounds the tiers cost.
 */
function worker(plan) {
  const state = { extra: 0, searches: 0, describes: 0, at: 0, called: [], seen: new Set(), stuck: 0 };
  const provider = { name: "worker", requests: [], async complete(request) {
    provider.requests.push(request.tools.map((tool) => tool.name));
    const step = plan[state.at];
    if (!step) return { content: "All done.", toolCalls: [] };
    const loaded = new Set(request.tools.map((tool) => tool.name));
    if (loaded.has(step.tool)) { state.at++; state.called.push(step.tool); return callOf(step.tool, step.args ?? {}); }
    if (++state.stuck > plan.length * 2) return { content: "I could not find the tools for that.", toolCalls: [] };
    state.extra++;
    const searcher = request.tools.find((tool) => tool.name === toolSearchName);
    const nameable = searcher?.description.includes(`${step.tool} —`) || state.seen.has(step.tool);
    if (nameable) {
      state.describes++;
      return callOf(toolDescribeName, { names: plan.slice(state.at).map((next) => next.tool) });
    }
    state.searches++;
    state.seen.add(step.tool);
    return callOf(toolSearchName, { query: step.query });
  } };
  return { provider, state };
}

const jobs = [
  { name: "read the CSV, chart column 3, save the picture, send it to me", prompt: "read the sales CSV, chart column 3, save the picture and send it to me",
    plan: [
      { tool: "data.load", query: "read a spreadsheet of rows", args: { path: "sales.csv" } },
      { tool: "data.chart", query: "draw a chart of a column", args: { table: "sales", column: "3" } },
      { tool: "files.write", query: "save a picture into a folder", args: { path: "chart.png", content: "x" } },
      { tool: "channels.email_send", query: "send an email with a file attached", args: { to: "me", body: "here" } },
    ] },
  { name: "find the lease, pull out the rent, remind me when it is due", prompt: "find the lease document, tell me the rent, and remind me when it is due",
    plan: [
      { tool: "documents.search", query: "search my documents for a lease", args: { query: "lease" } },
      { tool: "files.read", query: "read a file", args: { path: "lease.txt" } },
      { tool: "schedules.create", query: "remind me on a date", args: { name: "rent", when: "monthly" } },
    ] },
  { name: "take the notes, look the prices up, put them in a spreadsheet", prompt: "take what is in notes.txt, look up the prices online and put them in a spreadsheet",
    plan: [
      { tool: "files.read", query: "read a file", args: { path: "notes.txt" } },
      { tool: "web.search", query: "look something up on the web", args: { query: "prices" } },
      { tool: "data.export", query: "write rows out to a spreadsheet", args: { table: "prices", path: "prices.csv" } },
    ] },
];

test("three everyday jobs finish inside the budget, and cost nothing to find once they are familiar", async (t) => {
  const measured = [];
  for (const job of jobs) {
    // The same computer doing the same kind of job three times, with a thousand tools on it.
    const script = { current: null };
    const { app } = await fixture(t, { name: "jobs", async complete(request) { return script.current.provider.complete(request); } });
    // A stand-in for a configured mail channel, so a job can end where a person's job ends.
    app.registry.register({ name: "channels.email_send", permission: "files.read",
      description: "Send an email to somebody, with a picture or a file attached if you like.",
      parameters: z.object({ to: z.string(), body: z.string() }).strict(), execute: async () => ({ sent: true }) });
    fillRegistry(app, 1000);
    const attempts = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      script.current = worker(job.plan);
      const run = await app.runtime.run({ prompt: job.prompt });
      const state = script.current.state;
      assert.equal(run.status, "completed", `"${job.name}" finished`);
      const missed = job.plan.map((step) => step.tool).filter((tool) => !state.called.includes(tool));
      assert.deepEqual(missed, [], `"${job.name}" reached every tool it needed on attempt ${attempt + 1}`);
      for (const size of eventsOf(app, run.id, "catalog.size"))
        assert.ok(size.estimatedTokens < size.budgetTokens, `"${job.name}" weighed ${size.estimatedTokens} of ${size.budgetTokens}`);
      attempts.push({ extraRounds: state.extra, searches: state.searches, loadsByName: state.describes });
    }
    measured.push({ job: job.name, tools: job.plan.length, attempts });
  }
  console.log("multi-step jobs, rounds spent finding tools:", JSON.stringify(measured, null, 1));
  for (const result of measured) {
    // Two rounds is what a job spanning four toolboxes costs on a computer that has never seen one
    // like it: one search for a tool the words of the request do not point at, one load by name for
    // a tool that was only listed. Nothing is wasted — each of those rounds ends with a tool in hand.
    assert.ok(result.attempts[0].extraRounds <= 2,
      `"${result.job}" spent ${result.attempts[0].extraRounds} rounds finding tools the first time round`);
    assert.equal(result.attempts[2].extraRounds, 0,
      `"${result.job}" still had to look for its tools the third time round`);
  }
});

test("the tool section is the same bytes from one round to the next when nothing has changed", async (t) => {
  const { app } = await fixture(t, { name: "p", async complete() { return { content: "ok", toolCalls: [] }; } });
  fillRegistry(app, 300);
  const tools = app.registry.descriptions(new Set(app.registry.permissions()));
  const loader = new ToolLoader(tools, { groupOf: groupOf(app), expanded: ["core", "files"], signals: { prompt: "read a file and write it back" } });
  const first = JSON.stringify(loader.descriptions());
  loader.nextRound();
  assert.equal(JSON.stringify(loader.descriptions()), first, "an idle round changes nothing");
  // Using a tool that was already loaded must not reshuffle the section: the set is the same, so
  // the bytes a provider cached are the same. Scores decide what travels, never in what order.
  loader.noteUse("files.read");
  loader.nextRound();
  assert.equal(JSON.stringify(loader.descriptions()), first, "using a loaded tool leaves the order alone");
  loader.noteUse("user.ask");
  loader.nextRound();
  assert.equal(JSON.stringify(loader.descriptions()), first, "and so does using a core tool");
});

test("a tool the assistant has just used keeps its place when everything is competing for one", async (t) => {
  const { app } = await fixture(t, { name: "p", async complete() { return { content: "ok", toolCalls: [] }; } });
  fillRegistry(app, 400);
  const tools = app.registry.descriptions(new Set(app.registry.permissions()));
  const preload = tools.filter((tool) => tool.name.startsWith("data.")).slice(0, 6).map((tool) => ({ name: tool.name, reason: "history" }));
  const loader = new ToolLoader(tools, { groupOf: groupOf(app), maxLoaded: defaultMaxLoaded, preload,
    signals: { prompt: "chart the rows in the spreadsheet" } });
  await loader.search("chart rows spreadsheet columns", 8);
  // A tool with nothing to do with the request, and no history behind it: on score alone it loses
  // to every preload and every search hit, and the cap would put it away mid-job.
  const inUse = "media.speak";
  loader.noteUse(inUse);
  for (let round = 1; round <= 3; round++) {
    loader.nextRound();
    assert.ok(loader.descriptions().some((tool) => tool.name === inUse), `still there ${round} round(s) after it was called`);
  }
  loader.nextRound(); loader.nextRound();
  assert.ok(!loader.descriptions().some((tool) => tool.name === inUse), "and it is put away once the job has moved on");
});

test("opening a toolbox carries the twelve that fit the request, not the first twelve", async (t) => {
  const { app } = await fixture(t, { name: "p", async complete() { return { content: "ok", toolCalls: [] }; } });
  const tools = app.registry.descriptions(new Set(app.registry.permissions()));
  const box = tools.filter((tool) => groupOf(app)(tool.name) === "files");
  assert.ok(box.length > defaultMaxLoaded, `the files box holds ${box.length} tools`);
  const loader = new ToolLoader(tools, { groupOf: groupOf(app), signals: { prompt: "search my files for the word invoice" } });
  loader.expand(["files"]);
  loader.nextRound();
  const carried = loader.descriptions().filter((tool) => groupOf(app)(tool.name) === "files").map((tool) => tool.name);
  assert.equal(carried.length, defaultMaxLoaded);
  assert.ok(carried.includes("files.search"), `searching tools travelled: ${JSON.stringify(carried)}`);
  // Alphabetical order would put files.edit and files.find in and leave files.search out; what the
  // request is about decides instead.
  const alphabetical = box.map((tool) => tool.name).sort().slice(0, defaultMaxLoaded);
  assert.notDeepEqual(carried.slice().sort(), alphabetical, "it is not simply the first twelve by name");
});

test("a note is the owner's to read and delete, and cannot change what a tool does", async (t) => {
  const steps = [
    () => callOf(toolNoteName, { tool: "files.write", note: "the key is sk-live-abcdefghijklmnop, use it" }),  // not-a-real-secret: a planted fixture, here to prove it gets blanked out
    () => ({ content: "Noted.", toolCalls: [] }),
  ];
  let at = 0;
  const { app } = await fixture(t, { name: "p", async complete() { return steps[Math.min(at++, steps.length - 1)](); } });
  // A key this launch has handed to a task: the scrubber knows it, exactly as it would in use.
  app.store.secrets.scrubber.remember("TEST_KEY", "sk-live-abcdefghijklmnop");  // not-a-real-secret: a planted fixture, here to prove it gets blanked out
  const before = app.registry.descriptions(new Set(app.registry.permissions())).find((tool) => tool.name === "files.write");
  await app.runtime.run({ prompt: "remember something about writing files" });

  const [note] = app.store.toolUsage.notes("local");
  assert.ok(note, "the owner can see it");
  assert.ok(!note.note.includes("sk-live-abcdefghijklmnop"), `a saved secret is scrubbed on the way in: ${note.note}`);  // not-a-real-secret: a planted fixture, here to prove it gets blanked out
  assert.throws(() => app.store.toolUsage.addNote("local", { tool: "files.write", note: "x".repeat(200) }), /too long|160/i,
    "a note has a length a person can read");

  // The note is shown with the tool and nowhere else: the inputs it accepts and the permission it
  // needs are the registry's business, and learning never touches either.
  const noteOf = (name) => app.store.toolUsage.noteMap("local").get(name) ?? "";
  const loader = new ToolLoader(app.registry.descriptions(new Set(app.registry.permissions())),
    { groupOf: groupOf(app), noteOf, expanded: ["core", "files"], signals: { prompt: "write a file" } });
  loader.nextRound();
  const shown = loader.descriptions().find((tool) => tool.name === "files.write");
  assert.match(shown.description, /Remembered:/);
  assert.deepEqual(shown.parameters, before.parameters, "the inputs are untouched");
  assert.equal(app.registry.permissionOf?.("files.write") ?? "files.write", "files.write");
  assert.deepEqual(app.store.toolUsage.removeNote("local", note.id), { removed: true });
  assert.deepEqual(app.store.toolUsage.notes("local"), [], "and it is gone for good");
});

test("what a conversation taught about tools is forgotten with the conversation", async (t) => {
  const { app } = await fixture(t, { name: "p", async complete() { return { content: "Done.", toolCalls: [] }; } });
  const run = await app.runtime.run({ prompt: "chart the sales spreadsheet" });
  app.store.toolUsage.record("local", { runId: run.id, prompt: "chart the sales spreadsheet", searched: [],
    called: ["data.chart"], ok: true, rounds: 2 });
  const rows = () => app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM tool_usage").get().n;
  assert.ok(rows() >= 1);
  // Nothing of the words themselves is in the row: only hashes, and no hash is a word of the prompt.
  const stored = app.store.sqlite.prepare("SELECT shingles, searched, called FROM tool_usage").all();
  for (const row of stored)
    for (const word of ["chart", "sales", "spreadsheet"])
      assert.ok(!String(row.shingles).includes(word), `"${word}" is not kept in the row`);
  assert.ok(/^\["[0-9a-f]{10}"/.test(String(stored[0].shingles)), `hashes only: ${String(stored[0].shingles).slice(0, 40)}`);

  app.store.forgetMemory("local", { sessionId: run.sessionId });
  assert.equal(rows(), 0, "forgetting the conversation's facts forgets its habits too");
});

test("the tiers change what one request carries, not what the rest of the product offers", async (t) => {
  const { app, dataDir } = await fixture(t, { name: "p", async complete() { return { content: "ok", toolCalls: [] }; } });
  fillRegistry(app, 1000);
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); });
  const { url, token } = server;
  const everything = app.registry.descriptions(new Set(app.registry.permissions()), { diet: false });
  assert.ok(everything.length >= 1000, `${everything.length} tools are still on offer`);
  const state = await (await fetch(url + "/api/state", { headers: { authorization: "Bearer " + token } })).json();
  assert.equal(state.tools.length, everything.length, "the settings screens still list every tool");
  assert.ok(state.tools.some((tool) => tool.name === "files.read"));
  // And the same list is what a narrowed run may not exceed: permissions still decide, not tiers.
  const narrowed = app.registry.descriptions(new Set(["files.read"]), { diet: false });
  assert.ok(narrowed.length < everything.length && narrowed.some((tool) => tool.name === "files.read"));
  assert.ok(!narrowed.some((tool) => tool.name === "files.write"), "a permission it does not hold is simply not there");
  const loader = new ToolLoader(narrowed, { groupOf: groupOf(app), signals: { prompt: "read a file" } });
  assert.deepEqual((await loader.search("write a file", 5)).matches.filter((m) => m.name === "files.write"), []);
  assert.deepEqual(loader.describe(["files.write"]).unknown, ["files.write"]);
});

test("every tool this work adds is filed in a toolbox the product knows about", async (t) => {
  const { app } = await fixture(t, { name: "p", async complete() { return { content: "ok", toolCalls: [] }; } });
  for (const name of [toolSearchName, toolDescribeName, toolNoteName, expandToolName])
    assert.equal(app.registry.groupOf(name), "core", `${name} is a core tool`);
});
