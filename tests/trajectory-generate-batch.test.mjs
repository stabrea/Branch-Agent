/**
 * FQ-packages.trajectories: `runs.generate_batch` runs several prompts as real new tasks and saves
 * their trajectories into the workspace as one gzip-compressed batch file — the other half of the
 * gap `tests/trajectory-batches.test.mjs` already covers (exporting tasks that already exist,
 * compressed for real). This file proves the batch really gets generated, that the saved file is
 * the same gzip shape `trajectoryBatchCap`'s route already produces, and that a generated task
 * cannot start another batch of its own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { runOrigin, underShortLivedKey } from "../dist/key-context.js";
import { generateBatchKeyRefusal } from "../dist/trajectory-batch.js";

const say = (content) => () => ({ content, toolCalls: [] });
const call = (name, args) => () => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }] });

/** A provider that answers by what the last thing said contains, scripted route by route. */
function scripted(routes) {
  const counts = new Map();
  return {
    name: "scripted",
    requests: [],
    async complete(request) {
      this.requests.push(request);
      const asked = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const route = routes.find(([needle]) => asked.includes(needle));
      if (!route) throw new Error(`Nothing scripted for: ${asked.slice(0, 120)}`);
      const seen = counts.get(route[0]) ?? 0;
      counts.set(route[0], seen + 1);
      return route[1][Math.min(seen, route[1].length - 1)](request);
    },
  };
}

async function fixture(t, routes) {
  const root = await mkdtemp(join(tmpdir(), "branch-generate-batch-"));
  const provider = scripted(routes);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, provider, root };
}

test("FQ runs.generate_batch runs real new tasks and saves a real gzip batch in the workspace", async (t) => {
  const { app } = await fixture(t, [
    ["run one prompt", [say("first task done")]],
    ["run two prompt", [say("second task done")]],
  ]);
  const before = app.store.runs(app.runtime.owner).length;
  const context = app.runtime.context();
  const result = await app.registry.execute(
    "runs.generate_batch", { prompts: ["run one prompt", "run two prompt"] }, context,
  );

  assert.equal(result.count, 2, "one link per prompt");
  assert.equal(result.links.length, 2);
  for (const link of result.links) assert.equal(link.status, "completed");

  // Real new tasks, not a reuse of anything: the run count grew by exactly two, in the order asked.
  assert.equal(app.store.runs(app.runtime.owner).length, before + 2);
  const runs = result.links.map((link) => app.store.run(link.runId));
  assert.deepEqual(runs.map((run) => run.prompt), ["run one prompt", "run two prompt"]);
  assert.deepEqual(runs.map((run) => run.status), ["completed", "completed"]);

  // The batch file is a real gzip (magic bytes), saved under the workspace at the returned path.
  const bytes = await readFile(join(app.runtime.workspace, result.path));
  assert.ok(bytes.byteLength > 0 && bytes.byteLength < result.bytes + 1, "the saved file is the gzip that was reported");
  assert.equal(bytes[0], 0x1f, "gzip magic byte 1");
  assert.equal(bytes[1], 0x8b, "gzip magic byte 2");

  // Gunzipped, it is exactly two trajectory documents, one a line, task and outcome linked.
  const lines = gunzipSync(bytes).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((doc) => doc.run.id), result.links.map((link) => link.runId), "task links: same order, same ids");
  for (const [i, doc] of lines.entries()) {
    assert.equal(doc.format, "branch-agent-trajectory");
    assert.equal(doc.run.status, "completed", "outcome link: the document agrees with the manifest");
    assert.equal(doc.run.prompt, ["run one prompt", "run two prompt"][i]);
    assert.ok(doc.receiptCounts && typeof doc.receiptCounts === "object", "the outcome counts travelled with it");
  }
});

test("FQ a generated task cannot start a batch of its own", async (t) => {
  // The child task really tries: it calls runs.generate_batch itself. The strip must leave it
  // without specialists.use, so the call is refused and no grandchild task is ever created.
  const { app, provider } = await fixture(t, [
    ["start the outer batch", [call("runs.generate_batch", { prompts: ["try to recurse"] }), say("outer batch started")]],
    ["try to recurse", [call("runs.generate_batch", { prompts: ["a grandchild task"] }), say("the inner task was refused")]],
    ["a grandchild task", [say("a grandchild ran, which must not happen")]],
  ]);
  const before = app.store.runs(app.runtime.owner).length;
  const run = await app.runtime.run({ prompt: "start the outer batch" });
  assert.equal(run.status, "completed");

  const runs = app.store.runs(app.runtime.owner);
  assert.equal(runs.length, before + 2, "the outer task and its one generated task, and nothing more");
  assert.ok(!runs.some((r) => r.prompt === "a grandchild task"), "no grandchild task was created");
  assert.ok(!provider.requests.some((request) =>
    request.messages.some((m) => m.role === "user" && String(m.content).includes("a grandchild task"))),
  "the grandchild prompt never reached the model");

  const child = runs.find((r) => r.prompt === "try to recurse");
  assert.ok(child, "the child task really ran");
  const started = app.store.events(child.id).find((event) => event.kind === "run.started").data;
  assert.ok(Array.isArray(started.permissions), "the child recorded what it was allowed");
  assert.ok(!started.permissions.includes("specialists.use"), "the child was not given specialists.use");

  const childRequest = provider.requests.find((request) =>
    request.messages.some((m) => m.role === "user" && String(m.content).includes("try to recurse")));
  assert.ok(!childRequest.tools.some((tool) => tool.name === "runs.generate_batch"),
    "a generated task is not offered the tool that would let it start another batch");
});

test("FQ a short-lived key's task cannot start a batch, with the live mark or after a restart", async (t) => {
  const { app } = await fixture(t, [
    ["the key's own task", [say("key task done")]],
    ["should never run", [say("a generated task ran for a key")]],
  ]);
  const input = { prompts: ["should never run"] };

  // The live mark: the request itself came in on a short-lived key.
  const before = app.store.runs(app.runtime.owner).length;
  await assert.rejects(underShortLivedKey(() => app.registry.execute("runs.generate_batch", input, app.runtime.context())),
    { message: generateBatchKeyRefusal });
  assert.equal(app.store.runs(app.runtime.owner).length, before, "no task was created");

  // No live mark: the task a key started is carried on after a restart, so only its record says so.
  const keyRun = await underShortLivedKey(() => app.runtime.run({ prompt: "the key's own task" }), { keyId: "k-test" });
  assert.equal(runOrigin(app.store, keyRun.id).shortLivedKey, true, "the key's task recorded its mark");
  const resumedContext = { ...app.runtime.context(), runId: keyRun.id };
  const count = app.store.runs(app.runtime.owner).length;
  await assert.rejects(app.registry.execute("runs.generate_batch", input, resumedContext),
    { message: generateBatchKeyRefusal });
  assert.equal(app.store.runs(app.runtime.owner).length, count, "no task was created for the resumed key task");
});

test("FQ generated tasks name the task that asked for them and keep its origin", async (t) => {
  const { app } = await fixture(t, [
    ["the owner's own task", [call("runs.generate_batch", { prompts: ["owner generated"] }), say("done")]],
    ["owner generated", [say("generated done")]],
    ["an agent's task", [say("agent task done")]],
    ["agent generated", [say("generated done")]],
  ]);
  const owners = await app.runtime.run({ prompt: "the owner's own task" });
  assert.equal(owners.status, "completed");
  const ownerChild = app.store.runs(app.runtime.owner).find((r) => r.prompt === "owner generated");
  assert.ok(ownerChild, "the owner's batch ran");
  const ownerOrigin = runOrigin(app.store, ownerChild.id);
  assert.equal(ownerOrigin.shortLivedKey, false);
  assert.equal(ownerOrigin.source, "owner", "the owner's batch is the owner's own work");

  // An outside agent's task, carried on later: the context no longer says "mcp", only the record does.
  const agents = await app.runtime.run({ prompt: "an agent's task", source: "mcp" });
  assert.equal(agents.status, "completed");
  const { source: _dropped, ...ownerLooking } = app.runtime.context();
  await app.registry.execute("runs.generate_batch", { prompts: ["agent generated"] }, { ...ownerLooking, runId: agents.id });
  const agentChild = app.store.runs(app.runtime.owner).find((r) => r.prompt === "agent generated");
  assert.ok(agentChild, "the agent's batch ran");
  const started = app.store.events(agentChild.id).find((event) => event.kind === "run.started").data;
  assert.equal(started.originFrom, agents.id, "the generated task names the task that asked for it");
  assert.equal(runOrigin(app.store, agentChild.id).source, "mcp", "an outside task's batch is held as that outside work");
});

test("FQ a chat message's task cannot start a batch, even when its context no longer says so", async (t) => {
  const { app } = await fixture(t, [
    ["a chat's task", [say("chat task done")]],
    ["should never run", [say("a generated task ran for a chat")]],
  ]);
  const chats = await app.runtime.run({ prompt: "a chat's task", source: "channel" });
  const before = app.store.runs(app.runtime.owner).length;
  const { source: _dropped, ...ownerLooking } = app.runtime.context();
  await assert.rejects(app.registry.execute("runs.generate_batch", { prompts: ["should never run"] }, { ...ownerLooking, runId: chats.id }),
    /for the owner only/);
  assert.equal(app.store.runs(app.runtime.owner).length, before, "no task was created");
});
