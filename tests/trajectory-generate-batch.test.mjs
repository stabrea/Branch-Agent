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
  // The inner prompt asks the model to call runs.generate_batch on itself; if the permission strip
  // failed, the scripted provider would be asked for a route for it and this test would throw
  // "Nothing scripted for" from inside the child task instead of the parent finishing cleanly.
  const { app, provider } = await fixture(t, [
    ["start the outer batch", [call("runs.generate_batch", { prompts: ["try to recurse"] }), say("outer batch started")]],
    ["try to recurse", [say("the inner task just answered directly")]],
  ]);
  const run = await app.runtime.run({ prompt: "start the outer batch" });
  assert.equal(run.status, "completed");

  // The child task's own round never had runs.generate_batch on offer, closed or open.
  const childRequest = provider.requests.find((request) =>
    [...request.messages].some((m) => m.role === "user" && m.content.includes("try to recurse")));
  assert.ok(childRequest, "the child task really ran");
  assert.ok(!childRequest.tools.includes("runs.generate_batch"),
    "a generated task is not given the tool that would let it start another batch");
});
