/**
 * Follow-ups to mac7/lockdown-fix and R17-H: a copy of a flow run made by going back to a step, and the
 * checks and clean-up of a saved recipe a task asked for, keep to the tools of the task that started
 * them; a recipe step outside those tools is refused in a plain sentence; and the owner can stop a
 * program while Lockdown is on. Stand-in tools and temporary folders only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy, setLockdown } from "../dist/index.js";

/** What the calling task may use: its own flows, recipes and reading, but not commands. */
const TASK = ["workflows.manage", "workflows.read", "files.read", "procedures.use"];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-task-limit-followups-"));
  const provider = { name: "scripted", script: [], async complete() {
    return provider.script.shift() ?? { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  savePolicy(app.store, owner, { preset: "custom", rules: [{ tool: "*", decision: "allow", remember: "always" }] });
  const ran = [];
  const seen = [];
  app.registry.unregister("shell.execute");
  app.registry.register({ name: "shell.execute", permission: "shell.execute", description: "stand-in",
    parameters: z.object({}).passthrough(), execute: async () => { ran.push("shell.execute"); return { ok: true }; } });
  app.registry.register({ name: "tests.look", permission: "files.read", description: "stand-in look",
    parameters: z.object({}).passthrough(), execute: async (_args, context) => { seen.push([...context.permissions]); return { ok: true }; } });
  const taskCalls = (name, args) => {
    provider.script.push({ content: "", toolCalls: [{ id: `c-${name}`, name, arguments: JSON.stringify(args) }] });
    return app.runtime.run({ prompt: "please do it", permissions: TASK });
  };
  return { app, owner, ran, seen, taskCalls };
}

test("a copy made by going back to a step keeps the limit of the task that ran the flow", async (t) => {
  const { app, owner, ran, taskCalls } = await fixture(t);
  app.flowsBoards.setMode("time-travel", { mode: "on" });
  const graph = app.flows.saveGraph({
    name: "Look then command", input: {}, state: { seen: "text", out: "text" }, entry: "a",
    nodes: [
      { id: "a", name: "Look", kind: "tool", tool: "tests.look", args: {}, input: {}, output: { seen: "text" } },
      { id: "b", name: "Command", kind: "tool", tool: "shell.execute", args: {}, input: {}, output: { out: "text" } },
    ],
    edges: [{ from: "a", to: "b" }],
  });
  await taskCalls("flows.look-then-command", {});
  const runId = app.flowsBoards.timeTravel.runs().find((run) => run.flowId === graph.id)?.runId;
  assert.ok(runId, "the task's run was kept");
  const first = await app.flows.settled(runId);
  assert.equal(first.status, "failed");
  assert.match(first.error ?? "", /may not use shell\.execute/);
  const copy = app.flowsBoards.timeTravel.fork(runId, { seq: 1 });
  const done = await app.flowsBoards.timeTravel.settled(copy.runId);
  assert.equal(done.status, "failed", "the copy is held to the same tools");
  assert.match(done.error ?? "", /may not use shell\.execute/);
  assert.deepEqual(ran, [], "the command never ran");
  assert.deepEqual(app.store.get("settings", owner, `flow-run-limit:${copy.runId}`)?.data.within, TASK);
});

test("a finished run a task started can still be gone back into under its limit", async (t) => {
  const { app, owner, seen, taskCalls } = await fixture(t);
  app.flowsBoards.setMode("time-travel", { mode: "on" });
  const graph = app.flows.saveGraph({
    name: "Look twice", input: {}, state: { one: "text", two: "text" }, entry: "a",
    nodes: [
      { id: "a", name: "Look", kind: "tool", tool: "tests.look", args: {}, input: {}, output: { one: "text" } },
      { id: "b", name: "Look again", kind: "tool", tool: "tests.look", args: {}, input: {}, output: { two: "text" } },
    ],
    edges: [{ from: "a", to: "b" }],
  });
  await taskCalls("flows.look-twice", {});
  const runId = app.flowsBoards.timeTravel.runs().find((run) => run.flowId === graph.id)?.runId;
  assert.equal((await app.flows.settled(runId)).status, "completed");
  seen.length = 0;
  const copy = app.flowsBoards.timeTravel.fork(runId, { seq: 1 });
  assert.equal((await app.flowsBoards.timeTravel.settled(copy.runId)).status, "completed");
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].includes("shell.execute"), "the copy's box held only the task's tools");
  // A run the owner started themselves is copied with every tool, as before.
  const own = await app.flows.settled(app.flows.startGraph(graph.id, {}).runId);
  seen.length = 0;
  await app.flowsBoards.timeTravel.settled(app.flowsBoards.timeTravel.fork(own.runId, { seq: 1 }).runId);
  assert.ok(seen[0].includes("shell.execute"));
  assert.equal(app.store.get("settings", owner, `flow-run-limit:${own.runId}`), undefined);
});

async function verifiedRecipe(app, tool) {
  const context = app.runtime.context();
  const proposed = await app.registry.execute("procedures.propose", { name: `Use ${tool}`, preconditions: [],
    steps: [{ tool, args: {}, expected: { ok: true } }] }, context);
  await app.registry.execute("procedures.verify", { id: proposed.id }, context);
  return proposed.id;
}

test("a recipe step outside the task's tools is refused in a plain sentence", async (t) => {
  const { app, ran, taskCalls } = await fixture(t);
  const id = await verifiedRecipe(app, "shell.execute");
  ran.length = 0;
  const run = await taskCalls("procedures.replay", { id });
  const answer = app.store.messages(run.sessionId).filter((m) => m.role === "tool").map((m) => m.content).join("\n");
  assert.match(answer, /may not use shell\.execute/);
  assert.doesNotMatch(answer, /Permission denied/);
  app.flowsBoards.setMode("recipe-checks", { mode: "on" });
  // A refusal ends the checked run at once, in the same plain words.
  await assert.rejects(app.flowsBoards.recipes.run(id, {}, { mode: "policy", source: "owner", permissions: new Set(TASK) }),
    (error) => /may not use shell\.execute/.test(error.message) && !/Permission denied/.test(error.message));
  assert.deepEqual(ran, []);
});

test("a recipe's checks and clean-up that a task asked for hold only the task's tools", async (t) => {
  const { app, seen } = await fixture(t);
  const id = await verifiedRecipe(app, "tests.look");
  app.flowsBoards.setMode("recipe-checks", { mode: "on" });
  app.flowsBoards.recipes.save(id, { checks: [{ tool: "tests.look", args: {}, contains: "never" }], cleanup: [{ tool: "tests.look", args: {} }], retries: 0 });
  seen.length = 0;
  const checked = await app.flowsBoards.recipes.run(id, {}, { mode: "policy", source: "owner", permissions: new Set(TASK) });
  assert.equal(checked.status, "failed");
  assert.equal(seen.length, 3, "the step, the check and the clean-up each ran once");
  for (const held of seen) assert.ok(!held.includes("shell.execute"), `held ${held.join(", ")}`);
  app.flowsBoards.recipes.save(id, { checks: [{ tool: "shell.execute", args: {} }], retries: 0 });
  await assert.rejects(app.flowsBoards.recipes.run(id, {}, { mode: "policy", source: "owner", permissions: new Set(TASK) }),
    /The task that asked for this recipe may not use shell\.execute/);
});

test("the owner can stop a program while Lockdown is on; starting one is still refused", async (t) => {
  const { app, owner } = await fixture(t);
  setLockdown(app.store, owner, { on: true });
  const context = app.runtime.context();
  assert.notEqual(app.runtime.checkPolicy("process.stop", { id: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f" }, context).decision, "deny");
  const start = app.runtime.checkPolicy("process.start", { program: "node", args: [] }, context);
  assert.equal(start.decision, "deny");
  assert.match(start.reason ?? "", /Lockdown is on/);
  await assert.rejects(app.runtime.executeTool("process.stop", { id: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f" }, { mode: "owner" }),
    /There is no program with that number/, "stopping reaches the program list rather than Lockdown's refusal");
});
