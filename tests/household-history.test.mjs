/* Q147: a household person's task is filed under the owner while it works (their conversation is lent to it), yet
   what it looks through is that person's own conversations, never the owner's. Driven through runForCurrentPerson,
   the path a person's message takes, with a scripted model that calls one tool per message. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { runForCurrentPerson } from "../dist/collab-server.js";
import { brain, call } from "./trunks-helpers.mjs";
import { discardTemp } from "./temp-dir.mjs";

const rules = [
  ({ last }) => { if (last?.role !== "user") return null; const m = /^tool (\S+) (.*)$/s.exec(String(last.content ?? "")); return m ? call(m[1], JSON.parse(m[2])) : null; },
  ({ last }) => (last?.role === "tool" ? `Result: ${String(last.content).slice(0, 400)}` : null),
];

for (const role of ["adult", "child"]) {
  test(`Q147: a household ${role}'s task looks through their own conversations, never the owner's`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "branch-household-history-"));
    const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: brain(rules) });
    t.after(async () => { await app.close(); await discardTemp(root); });
    const said = (runId, name) => {
      const event = app.store.events(runId).find((e) => (e.kind === "tool.completed" || e.kind === "tool.failed") && e.data.name === name);
      return event ? JSON.stringify(event.kind === "tool.completed" ? event.data.result : event.data.error) : "never ran";
    };
    const ownerRun = await app.runtime.run({ prompt: "vegetable OWNERGARDEN1111 the owner's private plan", onTextDelta: () => undefined });
    const ownerSession = app.store.run(ownerRun.id).sessionId;
    const ownerMessage = Number(app.store.sqlite.prepare("SELECT source_id FROM messages WHERE session_id=? AND json_extract(body,'$.role')='user'").get(ownerSession).source_id);
    const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
    app.runtime.roles.save(sam.id, { role });
    app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
    await runForCurrentPerson(app, { prompt: `piano SAMPIANO2222 ${role}`, onTextDelta: () => undefined });

    const tries = [
      ["history.search", { query: "vegetable" }],
      ["history.attach", { conversation: ownerSession }],
      ["history.attach", { conversation: "vegetable" }],
      ["history.read", { sessionId: ownerSession, messageId: ownerMessage }],
      ["runs.export", { runId: ownerRun.id }],
      ["sessions.tree", { sessionId: ownerSession }],
    ];
    for (const [name, args] of tries) {
      const run = await runForCurrentPerson(app, { prompt: `tool ${name} ${JSON.stringify(args)}`, onTextDelta: () => undefined });
      assert.doesNotMatch(said(run.id, name), /OWNERGARDEN1111/, `${name} ${JSON.stringify(args)} gives Sam nothing of the owner's`);
    }
    const own = await runForCurrentPerson(app, { prompt: `tool history.search ${JSON.stringify({ query: "piano" })}`, onTextDelta: () => undefined });
    if (!/policy|not allowed|denied/i.test(said(own.id, "history.search")))
      assert.match(said(own.id, "history.search"), /SAMPIANO2222|piano/, "Sam finds their own earlier conversation");

    app.store.profiles.switch({ profileId: null });
    const owners = await app.runtime.run({ prompt: `tool history.search ${JSON.stringify({ query: "vegetable" })}`, onTextDelta: () => undefined });
    assert.match(said(owners.id, "history.search"), /OWNERGARDEN1111/, "the owner still finds their own");
  });
}
