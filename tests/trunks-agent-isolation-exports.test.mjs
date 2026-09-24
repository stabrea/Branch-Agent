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

test("Q143: knowledge.refresh writes up only the conversations a Trunk took part in, never the owner's own", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-isolation-"));
  const workspace = join(root, "workspace");
  const shown = [];
  const provider = brain([(context) => {
    const system = context.messages?.[0]?.content ?? "";
    if (!/card/i.test(system)) return null;
    const digest = context.messages.at(-1).content;
    shown.push(digest);
    return { content: JSON.stringify({ cards: [{ title: `Card ${shown.length}`, body: digest.slice(0, 400), sourceTurn: digest.slice(0, 200) }] }), toolCalls: [] };
  }]);
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); });
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  await app.trunks.introduced();
  app.trunks.edit(ada.id, { permissions: ["documents.read", "documents.write"] });
  await mkdir(join(workspace, "house"), { recursive: true });
  await writeFile(join(workspace, "house", "notes.md"), "# House\n\nNotes.\n", "utf8");
  const base = app.knowledgeBases.create("local", { name: "House", sources: [{ kind: "folder", path: "house" }] });

  const ownersOwn = app.store.createSession("local");
  app.store.message(ownersOwn, { role: "user", content: "the gate code is OWNERSECRET4242" });
  app.store.message(ownersOwn, { role: "assistant", content: "Noted." });
  app.store.message(ada.chatSessionId, { role: "user", content: "Ada, the boiler is serviced in March ADAOWN77" });
  app.store.message(ada.chatSessionId, { role: "assistant", content: "Got it." });
  const asAda = { ...app.runtime.context(), agent: `trunk:${ada.id}` };

  const refreshed = await app.registry.execute("knowledge.refresh", { collection: base.id, conversations: 10 }, asAda);
  assert.equal(shown.some((digest) => digest.includes("OWNERSECRET4242")), false, "the owner's conversation is never sent to be written up for Ada");
  assert.equal(JSON.stringify(refreshed).includes("OWNERSECRET4242"), false, "nor does anything of it come back to her");
  assert.ok(shown.some((digest) => digest.includes("ADAOWN77")), "her own conversation is still written up");
  assert.equal(refreshed.conversations, 1);
  // The cost it reports is of what it read: the owner's conversations are not counted into it either.
  assert.equal(refreshed.cost?.conversations, 1, JSON.stringify(refreshed.cost));

  // A workflow's tool step Ada set going runs with no turn of its own: `trunk` set, `agent` unset.
  shown.length = 0;
  const stepRefresh = await app.registry.execute("knowledge.refresh", { collection: base.id, conversations: 10 }, { ...app.runtime.context(), trunk: ada.id });
  assert.equal(shown.some((digest) => digest.includes("OWNERSECRET4242")), false, "her workflow's step never has the owner's conversation written up");
  assert.equal(JSON.stringify(stepRefresh).includes("OWNERSECRET4242"), false, "nor does anything of it come back to the step");
  assert.equal(stepRefresh.conversations, 1);
  assert.equal(stepRefresh.cost?.conversations, 1);

  shown.length = 0;
  await app.registry.execute("knowledge.refresh", { collection: base.id, conversations: 10 }, app.runtime.context());
  assert.ok(shown.some((digest) => digest.includes("OWNERSECRET4242")), "the owner's own refresh still reads their conversations");
});

test("Q143: a conversation the owner takes back while a Trunk's knowledge refresh is under way is left out of it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-isolation-"));
  const workspace = join(root, "workspace");
  // A card-writing stand-in like the one above: it records every digest it is shown, and answers only the
  // write-up requests. `meanwhile` runs once, inside its reply for Ada's own chat: by then her refresh has
  // listed the conversations it will read, and has not yet written up the next one.
  const shown = [];
  let meanwhile = null;
  const provider = brain([(context) => {
    if (!String(context.messages?.[0]?.content ?? "").startsWith("You are reading one conversation")) return null;
    const digest = context.messages.at(-1).content;
    shown.push(digest);
    if (meanwhile && digest.includes("ADAOWN78")) { const now = meanwhile; meanwhile = null; now(); }
    return { content: JSON.stringify({ cards: [{ title: `Card ${shown.length}`, body: digest.slice(0, 400), sourceTurn: digest.slice(0, 200) }] }), toolCalls: [] };
  }]);
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); });
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  await app.trunks.introduced();
  app.trunks.edit(ada.id, { permissions: ["documents.read", "documents.write"] });
  await mkdir(join(workspace, "house"), { recursive: true });
  await writeFile(join(workspace, "house", "notes.md"), "# House\n\nNotes.\n", "utf8");
  const base = app.knowledgeBases.create("local", { name: "House", sources: [{ kind: "folder", path: "house" }] });
  app.store.message(ada.chatSessionId, { role: "user", content: "Ada, the boiler is serviced in March ADAOWN78" });
  app.store.message(ada.chatSessionId, { role: "assistant", content: "Got it." });

  // An older conversation of the owner's (begun well before her chat, so it is listed after it), handed to
  // Ada later. She answers there, so while it is hers she may read it.
  const handed = app.store.createSession("local");
  app.store.sqlite.prepare("UPDATE sessions SET created_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", handed);
  app.trunks.conversations.choose(handed, { trunkId: ada.id });
  await app.runtime.run({ prompt: "Ada, the shed key hangs by the back door HANDED5501", sessionId: handed, onTextDelta: () => undefined });
  const asAda = { ...app.runtime.context(), agent: `trunk:${ada.id}` };
  assert.deepEqual(app.knowledgeCards.recent("local", 10, asAda.agent), [ada.chatSessionId, handed],
    "her refresh reads her own chat first and the handed conversation after it");

  // While her own chat is being written up, the owner takes the conversation back and says something new there.
  meanwhile = () => {
    app.trunks.conversations.choose(handed, { trunkId: null });
    app.store.message(handed, { role: "user", content: "back with me now: the safe code is TAKENBACK6161" });
  };
  shown.length = 0;
  const refreshed = await app.registry.execute("knowledge.refresh", { collection: base.id, conversations: 10 }, asAda);
  assert.equal(meanwhile, null, "the owner took it back while her own chat was being written up");
  assert.equal(refreshed.conversations, 2, "her refresh had listed the handed conversation before it was taken back");
  assert.equal(refreshed.cost?.conversations, 2, JSON.stringify(refreshed.cost));
  assert.equal(shown.some((digest) => digest.includes("TAKENBACK6161")), false, "what the owner said after taking it back is never sent to be written up for Ada");
  assert.equal(JSON.stringify(refreshed).includes("TAKENBACK6161"), false, "nor does any of it come back to her");
  assert.equal(shown.some((digest) => digest.includes("HANDED5501")), false, "once it is taken back, none of that conversation is written up for her");
  assert.equal(shown.length, 1, "only her own chat was written up");
  assert.ok(shown[0].includes("ADAOWN78"), "her own chat is still written up");

  // The owner's own refresh still reads it, what they said after taking it back included.
  shown.length = 0;
  await app.registry.execute("knowledge.refresh", { collection: base.id, conversations: 10 }, app.runtime.context());
  assert.ok(shown.some((digest) => digest.includes("TAKENBACK6161")), "the owner's own refresh reads what they said there");
});
