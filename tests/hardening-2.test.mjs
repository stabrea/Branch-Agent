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
import { setTimeout as delay } from "node:timers/promises";
import { createBranch, savePolicy } from "../dist/index.js";

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
// 1. Reading passages by meaning goes through the same network rules as every
//    other call to a provider. Nothing here reaches the real network.
// ---------------------------------------------------------------------------

test("a provider on a refused address cannot be asked to read passages", async () => {
  const { NetworkPolicy } = await import("../dist/network-policy.js");
  const { embeddingsFor, embeddingFetch } = await import("../dist/embeddings.js");
  // The blocked list is checked before anything is looked up, so this needs no network at all.
  const policy = new NetworkPolicy({ blockedHosts: ["embeddings.example"] }, async () => ["203.0.113.9"]);
  let reached = 0;
  const guarded = policy.guard(async () => { reached++; return new Response("{}"); });
  for (const connection of [
    { shape: "openai", endpoint: "https://embeddings.example/v1", apiKey: "k", model: "text-embedding-3-small", local: false },
    { shape: "gemini", endpoint: "https://embeddings.example/v1", apiKey: "k", model: "text-embedding-004", local: false },
  ]) {
    const reader = embeddingsFor(connection, guarded);
    await assert.rejects(() => reader.embed(["hello"], AbortSignal.timeout(2000)), /blocked list/,
      `${connection.shape} must be refused before a passage leaves`);
  }
  assert.equal(reached, 0, "not one passage may reach a refused address");
  // An allowed address is still reached, so the rules narrow rather than switch the reading off.
  const open = new NetworkPolicy({}, async () => ["203.0.113.9"]);
  assert.notEqual(embeddingFetch("https://reader.example/v1", open.guard(async () => new Response("{}"))), globalThis.fetch);
  // A reader on this computer is reached directly: the rules refuse local addresses on purpose.
  assert.equal(embeddingFetch("http://127.0.0.1:11434/v1", guarded), globalThis.fetch);
});

test("the app hands its guarded fetch to every reader of passages", async (t) => {
  const { app } = await fixture(t);
  // The three readers the app builds all take the guard rather than a bare fetch.
  assert.notEqual(app.documents.embeddingFetch, globalThis.fetch, "the document library");
  assert.notEqual(app.memory.retrieval.embeddingFetch, globalThis.fetch, "saved facts");
  assert.notEqual(app.knowledgeBases.embeddingCall, globalThis.fetch, "knowledge bases and tool meaning search");
});

// ---------------------------------------------------------------------------
// 4. A study's cells take places from the one shared count, and a benchmark is
//    read only from the workspace or the folder the owner named.
// ---------------------------------------------------------------------------

test("a study reads a benchmark only from the workspace or the folder the owner named", async (t) => {
  const { app, root } = await fixture(t);
  const { benchmarkFolderRefusal } = await import("../dist/study.js");
  const outside = join(root, "somewhere-else");
  assert.match(benchmarkFolderRefusal(outside, app.files.base, "") ?? "", /outside that/);
  assert.equal(benchmarkFolderRefusal(join(app.files.base, "gaia"), app.files.base, ""), null);
  assert.equal(benchmarkFolderRefusal(app.files.base, app.files.base, ""), null, "the workspace itself counts");
  assert.equal(benchmarkFolderRefusal(join(outside, "gaia"), app.files.base, outside), null, "the named folder counts");
  // A near-miss of the named folder is not inside it, whatever the string looks like.
  assert.match(benchmarkFolderRefusal(`${outside}-other`, app.files.base, outside) ?? "", /outside that/);
  // Saving a study that points outside is refused, and so is running an older one that does.
  const study = { id: "away", name: "Away", source: { kind: "benchmark", benchmark: "gaia", directory: outside }, presets: ["default"] };
  assert.throws(() => app.studies.save(study), /outside that/);
  app.store.save("governance", app.runtime.owner, "study:away", { ...study, subset: [], limit: 20, repeats: 1, concurrency: 2, retries: 1, maxSteps: 30, maxTokens: 120000, bestOfN: 1, description: "" });
  await assert.rejects(() => app.studies.run("away"), /outside that/);
  // Naming the folder in Settings is what lets it through, and the study then runs.
  app.studies.configure({ benchmarksFolder: outside });
  assert.equal(app.studies.settings().benchmarksFolder, outside);
  assert.equal(app.studies.save(study).id, "away");
});

test("every study cell takes a place from the shared count, and several studies cannot deadlock", async (t) => {
  const { ExecutionLimit } = await import("../dist/execution-limit.js");
  // Two places in all, and three studies each wanting two cells at once. Without the rule that a
  // study's first cell runs on the place it already holds, the two studies that got a place would
  // each wait for the other and nothing would ever finish.
  const limit = new ExecutionLimit(2);
  const held = [limit.take(), limit.take()];
  assert.ok(held.every(Boolean));
  assert.equal(limit.room, 0);
  // Waiting for a place is woken the moment one comes back, rather than polled blindly.
  let woke = false;
  const sleeping = limit.roomSoon(5000).then(() => { woke = true; });
  await delay(20);
  assert.equal(woke, false, "nothing came free yet");
  held[0]();
  await sleeping;
  assert.equal(woke, true, "giving a place up wakes whoever is waiting for one");
  assert.equal(limit.room, 1);
  // Giving the same place up twice cannot invent room, and the waiting line is still told.
  let told = 0;
  limit.onRoom = () => { told++; };
  held[0]();
  assert.equal(limit.room, 1);
  held[1]();
  assert.equal(limit.room, 2);
  assert.equal(told, 1);
  // A wait with nothing to wake it still comes back, which is what makes waiting safe at all.
  const began = Date.now();
  await new ExecutionLimit(0).roomSoon(50);
  assert.ok(Date.now() - began >= 40);
});

test("a study's own place is what stops it starving when the computer is full", async (t) => {
  const { app } = await fixture(t);
  const { ExecutionLimit } = await import("../dist/execution-limit.js");
  const limit = new ExecutionLimit(1);
  app.studies.executions = limit;
  app.studies.waitForPlaceMs = 300;
  // Every place is taken by something else, so no cell can get one of its own.
  const other = limit.take();
  t.after(() => other());
  const { saveSuite } = await import("../dist/evaluation-suites.js");
  saveSuite(app.store, app.runtime.owner, {
    id: "small", name: "Small", tasks: [{ id: "one", prompt: "one" }, { id: "two", prompt: "two" }, { id: "three", prompt: "three" }],
  });
  app.studies.save({ id: "busy", name: "Busy", source: { kind: "suite", suite: "small" }, presets: ["default"], concurrency: 3 });
  const result = await app.studies.run("busy");
  // Every cell still ran: the first worker uses the place the study itself holds.
  assert.equal(result.cells.length, 3, "a full computer must slow a study down, never stop it");
  assert.equal(limit.count, 1, "nothing the study took was left behind");
});

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

// ---------------------------------------------------------------------------
// 6. A service the owner turned into tools is still there after a restart, and
//    "forget this service" really forgets it. Nothing is fetched on the way back.
// ---------------------------------------------------------------------------

/** The smallest OpenAPI description that yields one tool, so nothing has to be reached. */
const tinyService = (base) => JSON.stringify({
  openapi: "3.0.0", info: { title: "Tiny", version: "1" }, servers: [{ url: base }],
  paths: { "/things/{id}": { get: { operationId: "getThing", summary: "Get one thing",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    responses: { "200": { description: "ok" } } } } },
});

test("a service turned into tools comes back after a restart, without fetching anything", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-openapi-restart-"));
  const where = { workspace: join(root, "workspace"), dataDir: join(root, "data") };
  const provider = { name: "scripted", async complete() { return say("done"); } };
  // One app at a time over the same data, each closed before the next opens, and the folder taken
  // away only once every one of them has let go of the database.
  const open = [];
  t.after(async () => {
    for (const app of open) await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const first = await createBranch({ ...where, provider });
  open.push(first);
  // A loopback address, and nothing listening on it: adding the service reads the description from
  // the workspace and never calls the service itself.
  first.web.policy.configure({ allowPrivateAddresses: true });
  await first.files.write("tiny.json", tinyService("http://127.0.0.1:9/v1"), AbortSignal.timeout(5000));
  const made = await first.runtime.executeTool("tools.from_openapi", {
    name: "tiny", file: "tiny.json", allowlist: ["getThing"], secret: "TINY_KEY", auth: "bearer",
  });
  assert.deepEqual(made.registered, ["api.tiny.get_thing"]);
  await first.close();

  // A fresh app over the same data: the tools are back, with their shapes, and no key was stored.
  const second = await createBranch({ ...where, provider });
  open.push(second);
  assert.ok(second.registry.names().includes("api.tiny.get_thing"), "the service's tools survive a restart");
  assert.equal(second.registry.groupOf("api.tiny.get_thing"), "services");
  assert.deepEqual(second.openApiTools.list().map((service) => service.name), ["tiny"]);
  const saved = second.store.get("settings", second.runtime.owner, "openapi-service:tiny").data;
  assert.equal(saved.secret, "TINY_KEY", "the name of the secret is kept");
  assert.equal(JSON.stringify(saved).includes("tiny-key-value"), false, "the key itself never leaves the locker");

  // Forgetting it takes the tools out and stops them coming back next time.
  await second.runtime.executeTool("tools.forget_service", { name: "tiny" });
  assert.equal(second.registry.names().includes("api.tiny.get_thing"), false);
  assert.ok(!second.store.get("settings", second.runtime.owner, "openapi-service:tiny"));
  await second.close();
  const third = await createBranch({ ...where, provider });
  open.push(third);
  assert.equal(third.registry.names().includes("api.tiny.get_thing"), false, "a forgotten service stays forgotten");
});

// ---------------------------------------------------------------------------
// 10. The tool checks really call the tools, so they run somewhere of their own
//     and leave the owner's folder and the owner's memory exactly as they were.
// ---------------------------------------------------------------------------

test("the tool checks touch neither the owner's folder nor the owner's memory", async (t) => {
  const { app } = await fixture(t);
  const { runToolChecksSafely, toolCheckFolder, toolCheckOwner } = await import("../dist/tool-evaluations.js");
  const owner = app.runtime.owner;
  await app.files.write("mine.txt", "the owner's own file", AbortSignal.timeout(5000));
  const before = { files: (await app.files.list(".")).entries.map((entry) => entry.name).sort(), memory: app.store.list("memory", owner).length };
  const result = await runToolChecksSafely(app, AbortSignal.timeout(60000));
  assert.ok(result.summary.total > 0, "the checks must actually have run");
  assert.equal(result.summary.passed, result.summary.total, JSON.stringify(result.cases.filter((one) => !one.passed)));
  // Nothing landed among the owner's own files — only the checks' own folder appeared beside them —
  // and the active project is back where it was.
  const after = (await app.files.list(".")).entries.map((entry) => entry.name).sort();
  assert.deepEqual(after.filter((name) => name !== toolCheckFolder), before.files);
  assert.equal(app.store.projects.active(owner).id, "default");
  // Nothing landed in the owner's memory; the facts the checks saved are under their own name.
  assert.equal(app.store.list("memory", owner).length, before.memory, "the owner's memory must be untouched");
  assert.ok(app.store.list("memory", toolCheckOwner).length > 0, "the checks' own facts are kept apart");
  // What the checks wrote is in their own folder inside the workspace, and nowhere else.
  const { readdir } = await import("node:fs/promises");
  const written = await readdir(join(app.files.root, toolCheckFolder));
  assert.ok(written.includes("tool-check-write.txt"), `the check's file belongs in its own folder: ${written.join(", ")}`);
});

test("the tool checks put the owner's project back even when the run itself goes wrong", async (t) => {
  const { app } = await fixture(t);
  const { runToolChecksSafely, toolCheckProject } = await import("../dist/tool-evaluations.js");
  const owner = app.runtime.owner;
  // A registry that throws stands in for anything going wrong part way through the checks.
  const broken = { ...app, registry: { names() { throw new Error("the catalog is unreadable"); } } };
  await assert.rejects(() => runToolChecksSafely(broken, AbortSignal.timeout(5000),
    [{ tool: "files.write", description: "one", cases: [{ name: "one", input: {}, contains: [] }] }]),
    /unreadable/);
  assert.equal(app.store.projects.active(owner).id, "default", "the owner's project is never left switched");
  assert.ok(app.store.projects.list(owner).some((project) => project.id === toolCheckProject),
    "the checks keep a folder of their own inside the workspace");
});

// ---------------------------------------------------------------------------
// 9. Every answer to an approval question is bound to the exact bytes it was
//    put for — the workflow/flow resume and `branch approve` included.
// ---------------------------------------------------------------------------

/** A workflow whose one step writes a file, which an "ask about this tool" rule stops on. */
const writingWorkflow = (app, content) => app.workflows.create("local", {
  name: "Writes one file",
  steps: [{ name: "Write it", kind: "tool", tool: "files.write", args: { path: "note.txt", content } }],
});

test("a workflow's yes is bound to the exact arguments the step asked about", async (t) => {
  const { app } = await fixture(t);
  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: "files.write", decision: "ask", remember: "session" }] });
  const made = writingWorkflow(app, "first");
  const held = await app.workflows.run("local", made.id);
  assert.equal(held.status, "waiting_approval");
  const asked = app.store.get("workflows", "local", made.id).data.pendingApproval;
  assert.match(String(asked.fingerprint ?? ""), /^[a-f0-9]{32}$/, "the question must carry the exact-bytes fingerprint");
  // The owner says yes, and the yes is remembered against that fingerprint and no other.
  const done = await app.workflows.resume("local", made.id);
  assert.equal(done.status, "completed", done.error ?? "");
  const key = `workflow:${made.id}`;
  assert.equal(app.runtime.approvals.answer(key, "files.write", asked.target, asked.fingerprint), "allow");
  assert.equal(app.runtime.approvals.answer(key, "files.write", asked.target, "0".repeat(32)), undefined,
    "a yes given for one request must not cover a different one");
});

test("`branch approve` binds its answer to the request the task actually stopped on", async (t) => {
  const tool = { id: "c1", name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hello" }) };
  const { app } = await fixture(t, (request) =>
    request.messages.some((message) => message.role === "tool") ? say("written") : { content: "", toolCalls: [tool] });
  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: "files.write", decision: "ask", remember: "session" }] });
  const { answerFromCommand } = await import("../dist/cli-run.js");
  const run = await app.runtime.run({ prompt: "write a note" });
  assert.equal(run.status, "needs_input");
  const asked = app.store.events(run.id).filter((event) => event.kind === "policy.ask").at(-1);
  assert.match(String(asked.data.fingerprint ?? ""), /^[a-f0-9]{32}$/);
  const target = String(asked.data.target ?? "");
  answerFromCommand(app.runtime, run.id, "yes");
  assert.equal(app.runtime.approvals.answer(run.sessionId, "files.write", target, asked.data.fingerprint), "allow");
  assert.equal(app.runtime.approvals.answer(run.sessionId, "files.write", target, "0".repeat(32)), undefined,
    "the answer must not cover a request the owner never saw");
});
