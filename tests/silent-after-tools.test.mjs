import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, saveKnobs } from "../dist/index.js";

/* Dogfood A7: after the owner's yes a task ran its tool and then said nothing, so all the owner saw
   was "Used settings change". A reply that is empty after the task used a tool is asked once more
   for its answer (silentAfterToolsNudge in src/runtime.ts). */
const listing = { content: "", toolCalls: [{ id: "c1", name: "files.list", arguments: "{\"path\":\".\"}" }] };
const empty = { content: "", toolCalls: [] };

/** A scripted model: the n-th reply is replies[n], and the last one repeats. */
async function scripted(t, replies) {
  const root = await mkdtemp(join(tmpdir(), "branch-silent-tools-"));
  await mkdir(join(root, "w"), { recursive: true });
  const seen = [];
  const provider = { name: "scripted", async complete(request) {
    seen.push(request.messages.at(-1) ?? null);
    const next = replies[Math.min(seen.length, replies.length) - 1];
    return typeof next === "function" ? next(request) : next;
  } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, seen };
}
const nudges = (app, run) => app.runtime.store.events(run.id).filter((event) => event.kind === "model.empty_reply");

test("a task that used a tool and then said nothing is asked once more, and ends with words", async (t) => {
  const { app, seen } = await scripted(t, [listing, empty, { content: "I listed the folder; it is empty.", toolCalls: [] }]);
  const run = await app.runtime.run({ prompt: "list the folder" });
  assert.equal(run.status, "completed");
  assert.match(run.output, /I listed the folder; it is empty\./, "the answer after the nudge is the task's answer");
  assert.equal(seen.length, 3, "one more round after the empty reply");
  assert.equal(seen[2].role, "user");
  assert.match(seen[2].content, /Your last reply was empty, so the owner has no answer/);
  assert.equal(nudges(app, run).length, 1);
});

test("a reply with words after a tool is the answer, with no extra round", async (t) => {
  const { app, seen } = await scripted(t, [listing, { content: "Done: the folder is empty.", toolCalls: [] }]);
  const run = await app.runtime.run({ prompt: "list the folder" });
  assert.equal(run.status, "completed");
  assert.match(run.output, /Done: the folder is empty\./);
  assert.equal(seen.length, 2);
  assert.equal(nudges(app, run).length, 0);
});

test("a model that stays empty after a tool is asked twice at most", async (t) => {
  const { app } = await scripted(t, [listing, empty]);
  const run = await app.runtime.run({ prompt: "list the folder" });
  assert.equal(nudges(app, run).length, 2, "the empty reply is asked about twice, no more");
});

test("the extra round counts against the round limit, and the limit still ends in words", async (t) => {
  const lastWord = (request) => /^What you were asked to do:/.test(request.messages.at(-1)?.content ?? "")
    ? { content: "Best I can say: I listed the folder.", toolCalls: [] } : empty;
  const { app, seen } = await scripted(t, [listing, empty, lastWord]);
  saveKnobs(app.store, app.runtime.owner, "limits", { maxModelRounds: 2 });
  const run = await app.runtime.run({ prompt: "list the folder" });
  assert.equal(nudges(app, run).length, 1, "the nudge used the second of the two rounds");
  assert.equal(seen.length, 3, "two rounds, then the one last question");
  assert.match(run.output, /Best I can say: I listed the folder\./);
  assert.match(run.output, /went back to the model 2 times/);
});
