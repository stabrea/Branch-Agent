/**
 * Q119 (NAS 000d4df, 3b14d0a): a saved workflow belongs to one principal — the owner, or the Trunk that
 * made it (or was given it). A Trunk sees, starts, stops, carries on and saves again only its own; another's
 * reads as not there. Every run of a Trunk's workflow is that Trunk's work, under what that Trunk could use,
 * whoever presses Run. Everything goes through real Trunk turns, a scripted model and the real tools.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { call, fixture, on } from "./trunks-helpers.mjs";

/** A turn "tool <name> <json>" calls that tool with those arguments, and says what came back. */
const rules = [({ last }) => {
  if (last?.role !== "user") return null;
  const match = /^tool (\S+) (.*)$/s.exec(String(last.content ?? ""));
  return match ? call(match[1], JSON.parse(match[2])) : null;
}, ({ last }) => (last?.role === "tool" ? `Result: ${last.content}` : null)];

const lastEvent = (app) => Number(app.store.sqlite.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get().id);
/** What one tool gave back (or refused with) since event `after`, as text. */
function outcomes(app, after, name) {
  return app.store.sqlite.prepare("SELECT data FROM events WHERE id > ? AND kind IN ('tool.completed','tool.failed') ORDER BY id")
    .all(after).map((row) => JSON.parse(row.data)).filter((data) => data.name === name)
    .map((data) => JSON.stringify(data.result ?? data.error ?? null)).join("\n");
}

async function setup(t, permissions = ["memory.read", "memory.write", "workflows.manage", "workflows.read"]) {
  const { app, provider } = await fixture(t, rules);
  on(app);
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { permissions });
  await app.trunks.introduced();
  const owner = app.runtime.owner;
  /** One tool call in a Trunk's own turn; returns what it gave back. */
  const use = async (trunk, name, args) => {
    const after = lastEvent(app);
    await app.trunks.say(trunk.id, `tool ${name} ${JSON.stringify(args)}`);
    return outcomes(app, after, name);
  };
  const saved = (name) => app.store.list("workflows", owner).find((record) => record.data.name === name);
  return { app, ada, bo, owner, use, saved, provider };
}

const approveThenSearch = [{ name: "ok?", kind: "approval", question: "Ship it?" },
  { name: "look", kind: "tool", tool: "memory.search", args: { query: "zebra" } }];

test("one Trunk cannot see, start, stop, carry on or save again another Trunk's workflow (X1)", async (t) => {
  const { app, ada, bo, owner, use, saved } = await setup(t);
  await use(ada, "memory.put", { text: "zebra Ada ADAOWN5150", source: "me" });
  await use(ada, "workflows.create", { name: "adas", steps: approveThenSearch });
  const id = saved("adas").id;
  await use(ada, "workflows.run", { id });
  assert.equal(app.workflows.view(owner, id).status, "waiting_approval");
  // Bo tries every way in. Each reads as not there, and nothing about Ada's workflow changes.
  const probe = [{ name: "look", kind: "tool", tool: "memory.search", args: { query: "zebra" } }];
  assert.match(await use(bo, "workflows.create", { id, name: "bos now", steps: probe }), /Workflow not found/);
  for (const name of ["workflows.run", "workflows.pause", "workflows.resume"])
    assert.match(await use(bo, name, { id }), /Workflow not found/, `${name} is refused to Bo`);
  const listed = await use(bo, "workflows.list", {});
  assert.doesNotMatch(listed, new RegExp(id), "Bo's list does not show Ada's workflow");
  assert.match(await use(bo, "flows.list", {}), /"flows":\[\]/, "nor does Bo's list of flows");
  const kept = app.workflows.view(owner, id);
  assert.equal(kept.name, "adas", "Bo's save never landed");
  assert.equal(kept.status, "waiting_approval");
  // The owner's yes: the rest runs as Ada. Afterwards Bo's list still holds nothing of hers.
  const done = await app.workflows.resume(owner, id);
  assert.equal(done.status, "completed");
  assert.match(JSON.stringify(done.state), /ADAOWN5150/);
  assert.doesNotMatch(await use(bo, "workflows.list", {}), /ADAOWN5150/, "Bo never reads Ada's fact through her workflow");
  // Ada still reaches her own, and saves it again as hers.
  assert.match(await use(ada, "workflows.list", {}), new RegExp(id));
  await use(ada, "workflows.create", { id, name: "adas again", steps: approveThenSearch });
  assert.equal(saved("adas again").data.startedBy, ada.id);
});

test("a Trunk cannot save its own steps into the owner's workflow for the owner's yes to run (X2)", async (t) => {
  const { app, ada, owner, use } = await setup(t);
  const workflow = await app.registry.execute("workflows.create", { name: "owners", steps: approveThenSearch }, app.runtime.context());
  await app.workflows.run(owner, workflow.id);
  assert.equal(app.workflows.view(owner, workflow.id).status, "waiting_approval");
  assert.doesNotMatch(await use(ada, "workflows.list", {}), new RegExp(workflow.id), "Ada does not see the owner's workflow");
  const refused = await use(ada, "workflows.create", { id: workflow.id, name: "owners", steps: [
    { name: "ok?", kind: "approval", question: "Ship it?" },
    { name: "plant", kind: "tool", tool: "files.write", args: { path: "nas-root.md", content: "x" } },
    { name: "fact", kind: "tool", tool: "memory.put", args: { text: "INJECTED7731", source: "a step" } }] });
  assert.match(refused, /Workflow not found/);
  const done = await app.workflows.resume(owner, workflow.id); // the owner says yes, once
  assert.equal(done.status, "completed");
  assert.deepEqual(done.steps.map((step) => step.name), ["ok?", "look"], "only the owner's own steps ran");
  assert.equal(existsSync(join(app.runtime.workspace, "nas-root.md")), false);
  assert.equal(app.store.list("memory", owner).some((record) => String(record.data.text).includes("INJECTED7731")), false);
  assert.equal(app.workflows.view(owner, workflow.id).steps.length, 2);
  assert.notEqual(typeof app.store.get("workflows", owner, workflow.id).data.startedBy, "string", "still the owner's own");
});

test("the owner pressing Run on a Trunk's workflow runs it as that Trunk, under what that Trunk could use", async (t) => {
  const { app, ada, owner, use, saved } = await setup(t);
  await use(ada, "workflows.create", { name: "writes", steps: [
    { name: "write", kind: "tool", tool: "files.write", args: { path: "from-ada.md", content: "x" } }] });
  const id = saved("writes").id;
  const done = await app.workflows.run(owner, id); // the owner's own screen, with every tool
  assert.equal(done.status, "failed", "Ada holds no files.write, so her step does not get it from the owner's press");
  assert.equal(existsSync(join(app.runtime.workspace, "from-ada.md")), false);
  assert.equal(existsSync(join(app.runtime.workspace, ".branch-agents", ada.id, "from-ada.md")), false);
  assert.equal(saved("writes").data.startedBy, ada.id, "and it is still Ada's");
  assert.match(await use(ada, "workflows.list", {}), new RegExp(id));
});

test("a Trunk's workflow keeps to what that Trunk may use now, not what it could when it made it", async (t) => {
  const { app, ada, owner, use, saved } = await setup(t);
  await use(ada, "memory.put", { text: "zebra Ada ADAOWN5150", source: "me" });
  await use(ada, "workflows.create", { name: "looks", steps: [
    { name: "look", kind: "tool", tool: "memory.search", args: { query: "zebra" } }] });
  const id = saved("looks").id;
  app.trunks.edit(ada.id, { permissions: ["workflows.manage", "workflows.read"] }); // the owner takes memory.read away
  const done = await app.workflows.run(owner, id);
  assert.equal(done.status, "failed", "the step is refused, as it would be in Ada's own turn");
  assert.doesNotMatch(JSON.stringify(done.state), /ADAOWN5150/);
});

test("a Trunk's workflow cannot run the owner's workflow as one of its steps, nor make it the Trunk's", async (t) => {
  const { app, ada, owner, use, saved } = await setup(t);
  const owners = await app.registry.execute("workflows.create", { name: "owners", steps: [
    { name: "look", kind: "tool", tool: "memory.search", args: { query: "zebra" } }] }, app.runtime.context());
  await use(ada, "workflows.create", { name: "nests", steps: [{ name: "inner", kind: "flow", flowId: owners.id }] });
  await use(ada, "workflows.run", { id: saved("nests").id });
  const outer = app.workflows.view(owner, saved("nests").id);
  assert.equal(outer.status, "failed");
  assert.match(outer.error ?? "", /Workflow not found/);
  const inner = app.store.get("workflows", owner, owners.id).data;
  assert.equal(inner.startedBy, undefined, "the owner's workflow carries no Trunk");
  assert.equal(inner.status, "idle", "and never ran");
});

test("a Trunk cannot carry on the owner's flow run, and asking stamps no Trunk on it", async (t) => {
  const { app, bo, use } = await setup(t);
  const graph = app.flows.saveGraph({ name: "Twice", input: {}, state: { first: "text", second: "text" }, entry: "a",
    nodes: [
      { id: "a", name: "First", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { first: "text" } },
      { id: "b", name: "Second", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { second: "text" } },
    ], edges: [{ from: "a", to: "b" }] });
  const { runId } = app.flows.startGraph(graph.id, {}); // the owner's own run
  await app.flows.settled(runId);
  // As a close in the middle leaves it: stopped, with the second box next and nothing to say yes to.
  app.store.sqlite.prepare("UPDATE flow_graph_runs SET status='interrupted', next_node='b' WHERE run_id=?").run(runId);
  app.store.delete("settings", app.runtime.owner, `flow-run-trunk:${runId}`); // never stamped, as an older run
  const answer = await use(bo, "workflows.resume", { id: graph.id });
  assert.match(answer, /nothing to carry on/);
  assert.equal((await app.flows.settled(runId)).status, "interrupted", "Bo did not carry it on");
  assert.equal(app.store.get("settings", app.runtime.owner, `flow-run-trunk:${runId}`), undefined, "and asking stamped nobody on it");
});

test("a specialist a Trunk hands work to sees only that Trunk's workflows", async (t) => {
  const { writeFile } = await import("node:fs/promises");
  const { app } = await fixture(t, [({ system, last }) => {
    if (!/You are the lister/.test(system)) return null;
    return last?.role === "tool" ? `Listed: ${last.content}` : call("workflows.list", {});
  }, ({ last }) => {
    if (last?.role === "tool") return "Done.";
    const text = String(last?.content ?? "");
    return text.startsWith("hand: ") ? call("delegate.handoff", { specialist: app.lister, brief: text.slice(6) }) : null;
  }]);
  on(app);
  const context = app.runtime.context();
  const proposed = await app.registry.execute("specialists.propose", { name: "lister", instructions: "You are the lister.",
    permissions: ["workflows.read"], evaluation: { prompt: "say ready", checks: [{ path: "lister.txt", expected: "ready" }] } }, context);
  await writeFile(join(app.runtime.workspace, "lister.txt"), "ready");
  await app.registry.execute("specialists.evaluate", { id: proposed.id }, context);
  await app.registry.execute("specialists.promote", { id: proposed.id }, context);
  app.lister = proposed.id;
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { permissions: ["specialists.use", "workflows.read", "workflows.manage"] });
  await app.trunks.introduced();
  const { withAccountCall } = await import("../dist/accounts/context.js");
  const adas = await withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } },
    async () => app.registry.execute("workflows.create", { name: "adas", steps: approveThenSearch }, app.runtime.context()));
  const after = lastEvent(app);
  await app.trunks.say(bo.id, "hand: list the workflows");
  for (let tries = 0; tries < 200 && !outcomes(app, after, "workflows.list"); tries++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const listed = outcomes(app, after, "workflows.list");
  assert.ok(listed, "Bo's lister listed");
  assert.doesNotMatch(listed, new RegExp(adas.id), "Bo's specialist does not see Ada's workflow");
});

test("a Trunk's workflow step and flow box are asked as that Trunk, with none of the owner's documents", async (t) => {
  const { app, ada, owner, use, saved, provider } = await setup(t);
  await app.documents.add(owner, { name: "Owner note", text: "zebra owner ada step box: the code is OWNERDOC4242." });
  const asked = (prompt) => provider.requests
    .filter((request) => request.messages.some((message) => message.role === "user" && String(message.content).includes(prompt)))
    .map((request) => JSON.stringify(request.messages)).join("\n");
  // The control: the owner's own step is given the owner's documents, so they are really on.
  const owners = await app.registry.execute("workflows.create", { name: "owners", steps: [
    { name: "ask", kind: "prompt", prompt: "zebra owner step" }] }, app.runtime.context());
  await app.workflows.run(owner, owners.id);
  assert.match(asked("zebra owner step"), /OWNERDOC4242/, "the owner's own step gets the owner's documents");
  await use(ada, "workflows.create", { name: "adas", steps: [{ name: "ask", kind: "prompt", prompt: "zebra ada step" }] });
  await use(ada, "workflows.run", { id: saved("adas").id });
  const step = asked("zebra ada step");
  assert.ok(step, "Ada's step asked the model");
  assert.doesNotMatch(step, /OWNERDOC4242/, "Ada's step is not handed the owner's documents");
  const graph = app.flows.saveGraph({ name: "Ask", input: {}, state: { said: "text" }, entry: "ask",
    nodes: [{ id: "ask", name: "Ask", kind: "prompt", prompt: "zebra ada box", output: { said: "text" } }], edges: [] });
  const { withAccountCall } = await import("../dist/accounts/context.js");
  const { runId } = await withAccountCall({ owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } },
    async () => app.flows.startGraph(graph.id, {}));
  await app.flows.settled(runId);
  const box = asked("zebra ada box");
  assert.ok(box, "Ada's flow box asked the model");
  assert.doesNotMatch(box, /OWNERDOC4242/, "nor is Ada's flow box");
});

test("Q123: a Trunk's workflow tool step looks through history and lists as that Trunk, never as the owner", async (t) => {
  const { app, ada, owner, use, saved } = await setup(t, ["memory.read", "history.read", "workflows.manage", "workflows.read"]);
  await app.runtime.run({ prompt: "zebra OWNERHIST8812 was said here", onTextDelta: () => undefined }); // the owner's own conversation
  await app.registry.execute("todos.add", { text: "owner's errand OWNERTODO5521" }, app.runtime.context());
  const steps = [
    { name: "look back", kind: "tool", tool: "history.search", args: { query: "zebra" } },
    { name: "the list", kind: "tool", tool: "todos.list", args: {} }];
  // The control: the owner's own workflow finds both, so they are there to find.
  const owners = await app.registry.execute("workflows.create", { name: "owners", steps }, app.runtime.context());
  const control = JSON.stringify((await app.workflows.run(owner, owners.id)).state);
  assert.match(control, /OWNERHIST8812/);
  assert.match(control, /OWNERTODO5521/);
  await use(ada, "workflows.create", { name: "adas", steps: [steps[0]] });
  await use(ada, "workflows.run", { id: saved("adas").id });
  const looked = app.workflows.view(owner, saved("adas").id);
  assert.equal(looked.status, "completed", looked.error ?? "");
  assert.doesNotMatch(JSON.stringify(looked.state), /OWNERHIST8812/, "Ada's step does not search the owner's conversations");
  await use(ada, "workflows.create", { name: "adas list", steps: [steps[1]] });
  await use(ada, "workflows.run", { id: saved("adas list").id });
  const listed = app.workflows.view(owner, saved("adas list").id);
  assert.equal(listed.status, "failed", "the owner's to-do list is refused to Ada's step");
  assert.doesNotMatch(JSON.stringify(listed.state), /OWNERTODO5521/);
});

test("Q123: a Trunk's workflow step is known as that Trunk by every guard that knows a Trunk by its keys", async (t) => {
  // NAS 24f2b9c: a step's context carried `trunk` but not `trunkKeys`, so the saved sign-in guard let Ada's own
  // workflow have the owner's password filled. The guards that remove Branch or install a program read the same.
  const { z } = await import("zod");
  const { autofillGuard, autofillTrunkRefusal, saveVaultAutofillSettings } = await import("../dist/vault-autofill.js");
  const { removalGuard, removeTrunkRefusal } = await import("../dist/remove-branch.js");
  const { callerGuard, installTrunkRefusal } = await import("../dist/local-one-button.js");
  const { app, ada, owner, use, saved } = await setup(t);
  const seen = [];
  app.registry.register({ name: "probe.context", permission: "probe.read", description: "Hands back nothing; keeps who asked.",
    parameters: z.object({}).strict(), execute: async (_input, context) => { seen.push(context); return { ok: true }; } });
  app.trunks.edit(ada.id, { permissions: ["workflows.manage", "workflows.read", "probe.read"] });
  saveVaultAutofillSettings(app.store, owner, { mode: "on" }); // so the autofill guard gets as far as asking who
  const step = [{ name: "who", kind: "tool", tool: "probe.context", args: {} }];
  const owners = await app.registry.execute("workflows.create", { name: "owners", steps: step }, app.runtime.context());
  await app.workflows.run(owner, owners.id);
  const ownerStep = seen.pop();
  assert.notEqual(autofillGuard(app.store, owner, ownerStep), autofillTrunkRefusal, "the control: the owner's own step is the owner's");
  await use(ada, "workflows.create", { name: "adas", steps: step });
  await use(ada, "workflows.run", { id: saved("adas").id });
  const adaStep = seen.pop();
  assert.ok(adaStep, "Ada's step ran");
  assert.equal(autofillGuard(app.store, owner, adaStep), autofillTrunkRefusal, "no saved sign-in is filled for Ada's step");
  assert.equal(removalGuard(app.store, adaStep), removeTrunkRefusal, "nor may it remove Branch");
  assert.equal(callerGuard(app.store, adaStep), installTrunkRefusal, "nor install a program");
});

test("Q123: a Trunk's workflow step cannot export the owner's task or branch the owner's conversation", async (t) => {
  const { app, ada, owner, use, saved } = await setup(t, ["history.read", "sessions.branch", "workflows.manage", "workflows.read"]);
  const run = await app.runtime.run({ prompt: "OWNERTASK6611 the owner's own", onTextDelta: () => undefined });
  const sessionId = app.store.run(run.id).sessionId;
  const messageId = Number(app.store.sqlite.prepare("SELECT source_id FROM messages WHERE session_id=? ORDER BY id LIMIT 1").get(sessionId).source_id);
  const steps = [{ name: "export", kind: "tool", tool: "runs.export", args: { runId: run.id } },
    { name: "branch", kind: "tool", tool: "sessions.branch", args: { sessionId, messageId } }];
  const branches = () => Number(app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM session_branches WHERE parent_session_id=?").get(sessionId).n);
  for (const [index, one] of steps.entries()) {
    await use(ada, "workflows.create", { name: `adas ${index}`, steps: [one] });
    await use(ada, "workflows.run", { id: saved(`adas ${index}`).id });
    const view = app.workflows.view(owner, saved(`adas ${index}`).id);
    assert.equal(view.status, "failed", `${one.tool} is refused to Ada's step`);
    assert.doesNotMatch(JSON.stringify(view.state), /OWNERTASK6611/);
  }
  assert.equal(branches(), 0, "no branch was made");
  // The control: the owner's own workflow does both.
  const owners = await app.registry.execute("workflows.create", { name: "owners", steps }, app.runtime.context());
  assert.equal((await app.workflows.run(owner, owners.id)).status, "completed");
  assert.equal(branches(), 1);
});
