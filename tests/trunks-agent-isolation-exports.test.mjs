/**
 * FQ-routing.isolated-agents agent isolation for export tools: verify that a Trunk or specialist
 * cannot access another agent's data through runs.export, sessions.tree, sessions.branch, or knowledge.propose.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { call, on } from "./trunks-helpers.mjs";
import { createBranch } from "../dist/index.js";

const brain = (rules) => ({ complete: async (context) => { for (const rule of rules) { const got = rule(context); if (got) return got; } return { content: "ok", toolCalls: [] }; } });

async function twoTrunksFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-isolation-"));
  const workspace = join(root, "workspace");
  const provider = brain([() => null]);
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); });
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  const bo = app.trunks.create({ name: "Bo" });
  await app.trunks.introduced();
  return { app, ada, bo, workspace };
}

test("runs.export refuses another Trunk accessing a Trunk's run", async (t) => {
  const { app, ada, bo } = await twoTrunksFixture(t);
  
  // Ada creates a run
  const adaRun = await app.trunks.say(ada.id, "hello");
  const adaRunId = adaRun.runId;

  // Bo tries to export Ada's run
  await assert.rejects(
    app.registry.execute("runs.export", { runId: adaRunId }, { ...app.runtime.context(), agent: `trunk:${bo.id}` }),
    /no task of yours/,
    "Bo cannot export Ada's run"
  );

  // Ada can export her own run
  const exported = await app.registry.execute("runs.export", { runId: adaRunId }, { ...app.runtime.context(), agent: `trunk:${ada.id}` });
  assert.ok(exported, "Ada can export her own run");

  // A specialist is also refused
  await assert.rejects(
    app.registry.execute("runs.export", { runId: adaRunId }, { ...app.runtime.context(), agent: "researcher" }),
    /no task of yours/,
    "A specialist cannot export Ada's run"
  );
});

test("sessions.tree refuses another Trunk accessing a Trunk's conversation tree", async (t) => {
  const { app, ada, bo } = await twoTrunksFixture(t);

  const adaChatId = ada.chatSessionId;

  // Bo tries to get Ada's conversation tree
  await assert.rejects(
    app.registry.execute("sessions.tree", { sessionId: adaChatId }, { ...app.runtime.context(), agent: `trunk:${bo.id}` }),
    /Conversation not found/,
    "Bo cannot read Ada's conversation tree"
  );

  // Ada can read her own conversation tree
  const tree = await app.registry.execute("sessions.tree", { sessionId: adaChatId }, { ...app.runtime.context(), agent: `trunk:${ada.id}` });
  assert.ok(tree, "Ada can read her own conversation tree");

  // A specialist is also refused
  await assert.rejects(
    app.registry.execute("sessions.tree", { sessionId: adaChatId }, { ...app.runtime.context(), agent: "researcher" }),
    /Conversation not found/,
    "A specialist cannot read Ada's conversation tree"
  );
});

test("sessions.branch refuses another Trunk branching a Trunk's conversation", async (t) => {
  const { app, ada, bo } = await twoTrunksFixture(t);
  app.trunks.edit(ada.id, { permissions: ["history.read"] });
  app.trunks.edit(bo.id, { permissions: ["history.read"] });

  const adaChatId = ada.chatSessionId;
  const adaView = app.store.sessionView("local", adaChatId);
  const adaMessageId = adaView.messages[0]?.messageId;
  assert.ok(adaMessageId, "Ada has a message");

  // Bo tries to branch Ada's conversation
  await assert.rejects(
    app.registry.execute("sessions.branch",
      { sessionId: adaChatId, messageId: adaMessageId },
      { ...app.runtime.context(), agent: `trunk:${bo.id}` }
    ),
    /Conversation not found/,
    "Bo cannot branch Ada's conversation"
  );

  // Ada can branch her own conversation
  const branch = await app.registry.execute("sessions.branch",
    { sessionId: adaChatId, messageId: adaMessageId },
    { ...app.runtime.context(), agent: `trunk:${ada.id}` }
  );
  assert.ok(branch.sessionId, "Ada can branch her own conversation");

  // A specialist is also refused
  await assert.rejects(
    app.registry.execute("sessions.branch",
      { sessionId: adaChatId, messageId: adaMessageId },
      { ...app.runtime.context(), agent: "researcher" }
    ),
    /Conversation not found/,
    "A specialist cannot branch Ada's conversation"
  );
});

test("knowledge.propose refuses another Trunk proposing from a Trunk's conversation", async (t) => {
  const { app, ada, bo, workspace } = await twoTrunksFixture(t);
  app.trunks.edit(ada.id, { permissions: ["documents.write"] });

  const adaChatId = ada.chatSessionId;
  
  // Create a knowledge base for the owner
  await mkdir(join(workspace, "source"), { recursive: true });
  await writeFile(join(workspace, "source", "notes.md"), "# Notes\n\nSample text.\n", "utf8");
  const base = app.knowledgeBases.create("local", { name: "Notes", sources: [{ kind: "folder", path: "source" }] });

  // Add a message to Ada's chat
  app.store.message(adaChatId, { role: "user", content: "sample text here" });
  app.store.message(adaChatId, { role: "assistant", content: "Got it." });

  // Bo tries to propose cards from Ada's conversation
  await assert.rejects(
    app.registry.execute("knowledge.propose",
      { sessionId: adaChatId, collection: base.id },
      { ...app.runtime.context(), agent: `trunk:${bo.id}` }
    ),
    /not one you participated in/,
    "Bo cannot propose from Ada's conversation"
  );

  // Ada can propose from her own conversation
  const proposal = await app.registry.execute("knowledge.propose",
    { sessionId: adaChatId, collection: base.id },
    { ...app.runtime.context(), agent: `trunk:${ada.id}` }
  );
  assert.ok(proposal, "Ada can propose from her own conversation");

  // A specialist is also refused
  await assert.rejects(
    app.registry.execute("knowledge.propose",
      { sessionId: adaChatId, collection: base.id },
      { ...app.runtime.context(), agent: "researcher" }
    ),
    /not one you participated in/,
    "A specialist cannot propose from Ada's conversation"
  );
});
