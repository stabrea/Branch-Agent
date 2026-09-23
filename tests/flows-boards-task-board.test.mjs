/**
 * FQ-workspace.task-board: a card on the shared board (R17-071, src/flows-boards/kanban.ts) is
 * assigned to a checked Trunk or team, never free text. The owner or the assistant picks a value
 * from `board.view().roster` (also served at GET /api/flows-boards/board, and drawn as a <select>
 * in public/flows-boards.js) instead of typing a name; the server checks it against the real
 * Trunk and team records every time, so a deleted Trunk or a made-up name is refused.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-task-board-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.flowsBoards.setMode("kanban", { mode: "on" });
  app.trunks.setMode("trunks", { mode: "on" });
  return { app, root };
}

/** A minimal specialist row, just so a team can point a member at a real id. */
function specialistStub(app) {
  const id = randomUUID();
  app.store.save("specialists", app.runtime.owner, id, { id, name: "Gardener", instructions: "", createdAt: new Date().toISOString() });
  return id;
}

test("a card is assigned to a checked Trunk, not free text", async (t) => {
  const { app } = await fixture(t);
  const trunk = app.trunks.create({ name: "Aria" });

  const withDefault = app.flowsBoards.kanban.add({ title: "Water the oak" }, "owner");
  assert.equal(withDefault.assignee, "Assistant", "the default is still the assistant");
  assert.equal(withDefault.assigneeType, "assistant");
  assert.equal(withDefault.assigneeId, null);

  const card = app.flowsBoards.kanban.add({ title: "Prune the roses", assignee: `trunk:${trunk.id}` }, "owner");
  assert.equal(card.assignee, "Aria", "the display name is read live from the Trunk record");
  assert.equal(card.assigneeType, "trunk");
  assert.equal(card.assigneeId, trunk.id);

  assert.throws(() => app.flowsBoards.kanban.add({ title: "Made up", assignee: "gardener" }, "owner"),
    /is not the owner, the assistant, a checked Trunk or a checked team/, "free text is refused, not silently accepted");
  assert.throws(() => app.flowsBoards.kanban.add({ title: "Fake id", assignee: "trunk:does-not-exist" }, "owner"),
    /That Trunk no longer exists/);

  const handedBack = app.flowsBoards.kanban.handoff(card.id, { to: "owner", note: "checking the cuts" }, "owner");
  assert.equal(handedBack.assignee, "Owner");
  assert.equal(handedBack.assigneeType, "owner");
  assert.equal(handedBack.assigneeId, null);

  // A Trunk removed after a card was handed to it: the stale id on the card is refused if reused,
  // but the earlier hand-off already recorded a plain name, not a dangling reference.
  app.trunks.remove(trunk.id);
  assert.throws(() => app.flowsBoards.kanban.handoff(card.id, { to: `trunk:${trunk.id}`, note: "still there?" }, "owner"),
    /That Trunk no longer exists/);
});

test("a card is assigned to a checked team, and the roster lists every checked option", async (t) => {
  const { app } = await fixture(t);
  const trunk = app.trunks.create({ name: "Bo" });
  const team = app.teams.save({ name: "Garden Crew", members: [{ specialistId: specialistStub(app), role: "Digger" }] });

  const card = app.flowsBoards.kanban.add({ title: "Turn the compost", assignee: `team:${team.id}` }, "owner");
  assert.equal(card.assignee, "Garden Crew");
  assert.equal(card.assigneeType, "team");
  assert.equal(card.assigneeId, team.id);

  const view = app.flowsBoards.kanban.view();
  assert.deepEqual(view.roster.slice(0, 2), [{ value: "owner", label: "Owner" }, { value: "assistant", label: "Assistant" }]);
  assert.ok(view.roster.some((o) => o.value === `trunk:${trunk.id}` && o.label === "Trunk: Bo"));
  assert.ok(view.roster.some((o) => o.value === `team:${team.id}` && o.label === "Team: Garden Crew"));

  app.teams.remove(team.id);
  assert.throws(() => app.flowsBoards.kanban.add({ title: "Later", assignee: `team:${team.id}` }, "owner"), /That team no longer exists/);
});

test("the owner's HTTP route serves and checks the same roster", async (t) => {
  const { app, root } = await fixture(t);
  const { startServer } = await import("../dist/server.js");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = (path, body) => fetch(server.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  const trunk = app.trunks.create({ name: "Cove" });
  const view = await (await call("/api/flows-boards/board")).json();
  assert.ok(view.roster.some((o) => o.value === `trunk:${trunk.id}`), "the picker's options are served, not built by the page");

  const refused = await call("/api/flows-boards/board/cards", { title: "Weed the beds", assignee: "some random guy" });
  assert.equal(refused.status, 400, "free text is refused over the API too, not only inside the tool");
  assert.match((await refused.json()).error, /owner|Trunk|team/i);

  const added = await (await call("/api/flows-boards/board/cards", { title: "Weed the beds", assignee: `trunk:${trunk.id}` })).json();
  assert.equal(added.card.assignee, "Cove");
  assert.equal(added.card.assigneeType, "trunk");
});
