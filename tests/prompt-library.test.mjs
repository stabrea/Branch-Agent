import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  Budget, createBranch, prompts, promptGroups, savePrompt, removePrompt, renameGroup, savedPromptText, maximumPrompts,
} from "../dist/index.js";

const asTask = (runId, permissions) => ({
  owner: "local", workspace: ".", runId, signal: new AbortController().signal,
  budget: new Budget(), permissions: new Set(permissions), depth: 0,
});

async function fixture(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-prompts-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
const written = (over = {}) => ({
  name: "Weekly numbers", group: "Work", description: "What moved this week",
  text: "Read the numbers for {{quarter}} and tell me what moved.",
  parameters: { quarter: { type: "string", required: true } }, ...over,
});

test("a prompt is saved, found under its group, and its placeholders are filled when it is used", async (t) => {
  const { app } = await fixture(t);
  assert.deepEqual(prompts(app.store, "local"), [], "nothing to begin with");

  const saved = savePrompt(app.store, "local", "p1", written());
  assert.equal(saved.name, "Weekly numbers");
  assert.deepEqual(promptGroups(app.store, "local"), [{ name: "Work", count: 1 }]);
  assert.equal(savedPromptText(app.store, "local", "p1", { quarter: "Q3" }),
    "Read the numbers for Q3 and tell me what moved.");
  assert.throws(() => savedPromptText(app.store, "local", "p1"), /required/,
    "and it says what it needs rather than sending the words with a gap in them");
});

test("a placeholder that was never declared is refused while the owner is still looking at it", async (t) => {
  const { app } = await fixture(t);
  /* Catching this at save time is the point: "you wrote {{region}} but never said what it is" is a
     sentence the owner can act on. A week later, mid-task, it is a puzzle. */
  assert.throws(() => savePrompt(app.store, "local", "p1",
    written({ text: "Read {{quarter}} for {{region}}." })), /region/);
  assert.deepEqual(prompts(app.store, "local"), [], "and nothing was saved");
});

test("two prompts cannot share a name in one group, but the same name in two groups is fine", async (t) => {
  const { app } = await fixture(t);
  savePrompt(app.store, "local", "p1", written());
  assert.throws(() => savePrompt(app.store, "local", "p2", written()), /already saved/);
  savePrompt(app.store, "local", "p2", written({ group: "Home" }));
  assert.equal(prompts(app.store, "local").length, 2);
  savePrompt(app.store, "local", "p1", written({ description: "Changed my mind" }));
  assert.equal(prompts(app.store, "local").find((entry) => entry.id === "p1").description, "Changed my mind",
    "and saving over one of them is not a clash with itself");
});

test("renaming a group moves everything in it at once", async (t) => {
  const { app } = await fixture(t);
  savePrompt(app.store, "local", "p1", written());
  savePrompt(app.store, "local", "p2", written({ name: "Monthly numbers" }));
  savePrompt(app.store, "local", "p3", written({ name: "Shopping", group: "Home" }));

  assert.deepEqual(renameGroup(app.store, "local", "Work", "The day job"), { moved: 2 });
  assert.deepEqual(promptGroups(app.store, "local"), [{ name: "Home", count: 1 }, { name: "The day job", count: 2 }]);
  assert.equal(savedPromptText(app.store, "local", "p1", { quarter: "Q1" }).startsWith("Read the numbers for Q1"), true,
    "and the words themselves are untouched");
});

test("a prompt with no group is filed somewhere, not nowhere", async (t) => {
  const { app } = await fixture(t);
  savePrompt(app.store, "local", "p1", written({ group: "" }));
  const [group] = promptGroups(app.store, "local");
  assert.equal(group.count, 1);
  assert.ok(group.name.trim().length > 0, `the group has a name a person can read (${group.name})`);
});

test("removing one leaves the rest, and the library has a bound", async (t) => {
  const { app } = await fixture(t);
  savePrompt(app.store, "local", "p1", written());
  savePrompt(app.store, "local", "p2", written({ name: "Another" }));
  assert.deepEqual(removePrompt(app.store, "local", "p1"), { removed: true });
  assert.deepEqual(prompts(app.store, "local").map((entry) => entry.id), ["p2"]);
  assert.deepEqual(removePrompt(app.store, "local", "p1"), { removed: false }, "removing it twice is not an error");
  assert.ok(maximumPrompts >= 100 && maximumPrompts <= 5000, "there is a stated ceiling");
});

test("the tools list saved prompts and hand back the words, and never send them", async (t) => {
  const { app } = await fixture(t, { name: "prompt-fixture", complete: async () => ({ content: "Done", toolCalls: [] }) });
  savePrompt(app.store, "local", "p1", written());
  const run = await app.runtime.run({ owner: "local", prompt: "anything" });
  const before = app.store.runs("local").length;

  const listed = await app.registry.execute("prompts.list", {}, asTask(run.id, ["memory.read"]));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "Weekly numbers");
  assert.equal("text" in listed[0], false, "the listing is a listing, not every prompt's full words");

  const used = await app.registry.execute("prompts.use", { id: "p1", inputs: { quarter: "Q4" } },
    asTask(run.id, ["memory.read"]));
  assert.match(used.text, /Q4/);
  assert.equal(app.store.runs("local").length, before, "reading a saved prompt starts no task of its own");
  assert.ok(app.store.events(run.id).some((event) => event.kind === "prompts.used"), "and the task's record says it was read");
});

test("saved prompts survive the app being closed and opened again", async (t) => {
  const { app, root } = await fixture(t);
  savePrompt(app.store, "local", "p1", written());
  await app.close();
  const reopened = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  try {
    assert.equal(prompts(reopened.store, "local")[0].name, "Weekly numbers");
  } finally { await reopened.close(); }
});
