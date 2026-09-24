/**
 * Q119 for graphs (NAS 167a6e2, GCARRY): a flow run a Trunk set going through its own flow tool keeps the
 * limit that task held, and every carry-on also keeps to what that Trunk may use now
 * (FlowGraphRunner.boxes). The owner's Carry on after taking a tool from the Trunk never uses it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { z } from "zod";
import { call, fixture, on } from "./trunks-helpers.mjs";

/** A turn "tool <name> <json>" calls that tool with those arguments, and says what came back. */
const rules = [({ last }) => {
  if (last?.role !== "user") return null;
  const match = /^tool (\S+) (.*)$/s.exec(String(last.content ?? ""));
  return match ? call(match[1], JSON.parse(match[2])) : null;
}, ({ last }) => (last?.role === "tool" ? `Result: ${last.content}` : null)];
const written = (root, name) => readdirSync(root, { recursive: true }).map(String).filter((path) => path.endsWith(name));

test("a Trunk's flow run that kept a limit when it started keeps to what that Trunk may use now, when the owner carries it on", async (t) => {
  const { app, root } = await fixture(t, rules);
  on(app);
  let calls = 0;
  app.registry.register({ name: "tests.flaky", permission: "workflows.read", description: "Fails the first time only.",
    parameters: z.object({}).passthrough(), execute: async () => { if (++calls === 1) throw new Error("not yet"); return { ok: true }; } });
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { permissions: ["files.read", "files.write", "workflows.manage", "workflows.read"] });
  await app.trunks.introduced();
  const graph = app.flows.saveGraph({ name: "Two", input: {}, state: { first: "text", write: "text" }, entry: "first",
    nodes: [
      { id: "first", name: "First", kind: "tool", tool: "tests.flaky", args: {}, output: { first: "text" } },
      { id: "write", name: "Write", kind: "tool", tool: "files.write", args: { path: "kept-7101.md", content: "x" }, output: { write: "text" } },
    ], edges: [{ from: "first", to: "write" }] });
  await app.trunks.say(ada.id, "tool flows.two {}"); // Ada sets it going through her own flow tool; the first box fails once
  const runId = app.flows.graphs.resumable(graph.id)?.runId;
  assert.ok(runId, "Ada's run stopped part way through");
  assert.equal(app.flows.graphs.trunkOf(runId), ada.id);
  assert.ok(app.flows.graphs.limitOf(runId)?.includes("files.write"), "the limit kept when Ada set it going holds files.write");
  app.trunks.edit(ada.id, { permissions: ["workflows.manage", "workflows.read"] }); // the owner takes the files away
  const carried = await app.flows.run(graph.id, { resume: true }); // then presses Carry on
  const done = await app.flows.settled(carried.runId);
  assert.equal(done.status, "failed", JSON.stringify(done).slice(0, 300));
  assert.match(done.error ?? "", /may not use files\.write/);
  assert.deepEqual(written(root, "kept-7101.md"), [], "no file was written");
  assert.ok(app.flows.graphs.limitOf(runId)?.includes("files.write"), "the kept limit itself is not rewritten");
});
