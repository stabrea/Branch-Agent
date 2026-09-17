/**
 * mac7/lockdown-fix: a workflow a task starts keeps to that task's own tools. Its tool steps, its
 * prompt steps, a flow inside it and a graph flow the task carries on are limited to what the task
 * itself may use, through the one tool gate (src/tool-gate.ts); a workflow the owner starts is
 * unchanged. Stand-in tools and temporary folders only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";

/** The tools the calling task may use: it may manage workflows, but not run commands. */
const TASK = ["workflows.manage", "workflows.read", "files.read"];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-workflow-limit-"));
  const provider = { name: "scripted", requests: [], script: [], async complete(request) {
    provider.requests.push(request);
    const next = provider.script.shift();
    return next ?? { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [{ tool: "*", decision: "allow", remember: "always" }] });
  const ran = [];
  const shell = { failing: false };
  app.registry.unregister("shell.execute");
  app.registry.register({ name: "shell.execute", permission: "shell.execute", description: "stand-in",
    parameters: z.object({}).passthrough(),
    execute: async () => { if (shell.failing) throw new Error("not yet"); ran.push("shell.execute"); return { exitCode: 0 }; } });
  return { app, provider, ran, shell, owner: app.runtime.owner };
}
const call = (name, args) => ({ content: "", toolCalls: [{ id: `c-${name}`, name, arguments: JSON.stringify(args) }] });
/** A task holding only TASK asks for one tool call, as the model would. */
async function taskCalls(fx, name, args) {
  fx.provider.script.push(call(name, args));
  return fx.app.runtime.run({ prompt: "please do it", permissions: TASK });
}
const shellFlow = (app, owner, extra = []) =>
  app.workflows.create(owner, { name: "Runs a command", steps: [...extra, { name: "Command", kind: "tool", tool: "shell.execute", args: {} }] });

test("a workflow the owner starts still runs its command step", async (t) => {
  const fx = await fixture(t);
  const flow = shellFlow(fx.app, fx.owner);
  const done = await fx.app.workflows.run(fx.owner, flow.id);
  assert.equal(done.status, "completed", done.error ?? "");
  assert.deepEqual(fx.ran, ["shell.execute"]);
});

test("a task that may not run commands cannot run one through a workflow", async (t) => {
  const fx = await fixture(t);
  const flow = shellFlow(fx.app, fx.owner);
  await taskCalls(fx, "workflows.run", { id: flow.id });
  const view = fx.app.workflows.view(fx.owner, flow.id);
  assert.equal(view.status, "failed");
  assert.match(view.error, /task that started this workflow may not use shell\.execute/);
  assert.deepEqual(fx.ran, [], "the command never ran");
});

test("the limit outlasts a wait for the owner's yes", async (t) => {
  const fx = await fixture(t);
  const flow = shellFlow(fx.app, fx.owner, [{ name: "Check", kind: "approval", question: "Go on?" }]);
  await taskCalls(fx, "workflows.run", { id: flow.id });
  assert.equal(fx.app.workflows.view(fx.owner, flow.id).status, "waiting_approval");
  const after = await fx.app.workflows.resume(fx.owner, flow.id);
  assert.equal(after.status, "failed");
  assert.match(after.error, /may not use shell\.execute/);
  assert.deepEqual(fx.ran, []);
  // Started afresh by the owner, it is the owner's workflow again.
  assert.equal((await fx.app.workflows.run(fx.owner, flow.id)).status, "waiting_approval");
  const again = await fx.app.workflows.resume(fx.owner, flow.id);
  assert.equal(again.status, "completed", again.error ?? "");
  assert.deepEqual(fx.ran, ["shell.execute"]);
});

test("a task carrying a stopped workflow on is held to its own tools too", async (t) => {
  const fx = await fixture(t);
  const flow = shellFlow(fx.app, fx.owner, [{ name: "Look", kind: "tool", tool: "files.list", args: {} }]);
  fx.shell.failing = true;
  const stopped = await fx.app.workflows.run(fx.owner, flow.id);
  assert.equal(stopped.status, "failed");
  fx.shell.failing = false;
  await taskCalls(fx, "workflows.resume", { id: flow.id });
  const view = fx.app.workflows.view(fx.owner, flow.id);
  assert.match(view.error ?? "", /may not use shell\.execute/);
  assert.deepEqual(fx.ran, []);
});

test("a prompt step and a flow inside it get only the task's tools", async (t) => {
  const fx = await fixture(t);
  const inner = shellFlow(fx.app, fx.owner);
  const outer = fx.app.workflows.create(fx.owner, { name: "Outer", steps: [
    { name: "Think", kind: "prompt", prompt: "Think about the week" },
    { name: "Inner", kind: "flow", flowId: inner.id },
  ] });
  await taskCalls(fx, "workflows.run", { id: outer.id });
  const stepRequest = fx.provider.requests.find((request) => request.messages.some((m) => m.role === "user" && /Think about the week/.test(m.content)));
  assert.ok(stepRequest, "the prompt step asked the model");
  const offered = (stepRequest.tools ?? []).map((tool) => tool.name);
  assert.ok(!offered.includes("shell.execute"), "the prompt step was not offered the command tool");
  const view = fx.app.workflows.view(fx.owner, outer.id);
  assert.equal(view.status, "failed");
  assert.match(view.error, /may not use shell\.execute/);
  assert.deepEqual(fx.ran, []);
});

test("a graph flow a task carries on keeps to the task's tools", async (t) => {
  const fx = await fixture(t);
  const graph = fx.app.flows.saveGraph({
    name: "One command", input: {}, state: { out: "text" }, entry: "a",
    nodes: [{ id: "a", name: "Command", kind: "tool", tool: "shell.execute", args: {}, input: {}, output: { out: "text" } }],
    edges: [],
  });
  fx.shell.failing = true;
  const stopped = await fx.app.flows.settled(fx.app.flows.startGraph(graph.id, {}).runId);
  assert.equal(stopped.status, "failed");
  fx.shell.failing = false;
  await taskCalls(fx, "workflows.resume", { id: graph.id });
  const finished = await fx.app.flows.settled(stopped.runId);
  assert.equal(finished.status, "failed");
  assert.match(finished.error ?? "", /may not use shell\.execute/);
  assert.deepEqual(fx.ran, []);
});

test("the tool gate itself refuses a call outside the task's permissions, before any question", async (t) => {
  const fx = await fixture(t);
  savePolicy(fx.app.store, fx.owner, { preset: "custom", rules: [{ tool: "*", decision: "ask", remember: "session" }] });
  for (const mode of ["policy", "owner"])
    await assert.rejects(fx.app.runtime.executeTool("shell.execute", {}, { mode, within: TASK }),
      (error) => error.name === "PolicyRefusedError" && /may not use shell\.execute/.test(error.message), mode);
  assert.deepEqual(fx.ran, []);
  await fx.app.runtime.executeTool("files.list", {}, { mode: "owner", within: TASK });
});

test("a graph flow's own tool, used by a task, keeps to the task's tools, and the owner's yes does not widen it", async (t) => {
  const fx = await fixture(t);
  savePolicy(fx.app.store, fx.owner, { preset: "custom", rules: [
    { tool: "files.list", decision: "ask", remember: "session" },
    { tool: "*", decision: "allow", remember: "always" },
  ] });
  const graph = fx.app.flows.saveGraph({
    name: "Look then command", input: {}, state: { seen: "text", out: "text" }, entry: "a",
    nodes: [
      { id: "a", name: "Look", kind: "tool", tool: "files.list", args: {}, input: {}, output: { seen: "text" } },
      { id: "b", name: "Command", kind: "tool", tool: "shell.execute", args: {}, input: {}, output: { out: "text" } },
    ],
    edges: [{ from: "a", to: "b" }],
  });
  assert.ok(fx.app.registry.permissionOf("flows.look-then-command"), "the flow has a tool of its own");
  await taskCalls(fx, "flows.look-then-command", {});
  const run = fx.app.flows.graphs.resumable(graph.id);
  assert.ok(run, "the flow stopped to ask about the look");
  const waiting = await fx.app.flows.settled(run.runId);
  assert.equal(waiting.status, "waiting_approval");
  fx.app.flows.resumeGraph(graph.id, { approve: true });
  const finished = await fx.app.flows.settled(run.runId);
  assert.equal(finished.status, "failed");
  assert.match(finished.error ?? "", /may not use shell\.execute/);
  assert.deepEqual(fx.ran, []);
});
