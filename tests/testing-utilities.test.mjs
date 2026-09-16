/**
 * The deterministic test doubles as somebody else would get them: this file imports only the
 * package's public entry point, nothing from inside it, so it proves that a plugin or skill author
 * can write tests against Branch Agent without a model, a key or a network connection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, ScriptedProvider, ScriptedTools, say, callTool } from "../dist/index.js";

test("a scripted model answers by what it was asked, not by how often it has been called", async () => {
  const provider = new ScriptedProvider([
    ["weather", [say("It is raining."), say("It has stopped.")]],
    ["capital", [say("Paris.")]],
  ]);
  const ask = async (content) => (await provider.complete({
    messages: [{ role: "user", content }], tools: [], signal: AbortSignal.timeout(1000), maxTokens: 100,
  })).content;
  assert.equal(await ask("What is the capital of France?"), "Paris.");
  assert.equal(await ask("What is the weather?"), "It is raining.");
  assert.equal(await ask("What is the capital of France?"), "Paris.", "one route must not move another along");
  assert.equal(await ask("What is the weather?"), "It has stopped.");
  assert.equal(await ask("What is the weather?"), "It has stopped.", "the last reply repeats");
  assert.equal(provider.count("weather"), 3);
  assert.equal(provider.requests.length, 5);
  await assert.rejects(ask("Something nobody scripted"), /Nothing scripted for/);
  provider.set([["weather", [say("Sunny.")]]]);
  assert.equal(await ask("What is the weather?"), "Sunny.");
});

test("a scripted model can ask for a tool, and scripted tools record what they were given", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-doubles-"));
  const provider = new ScriptedProvider([
    ["greet Ada", [callTool("notes.add", { name: "Ada" }), say("I have greeted Ada.")]],
  ]);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const doubles = new ScriptedTools().reply("notes.add", { greeted: "Ada" });
  doubles.register(app.registry, ["notes.add"], "memory.write");
  const run = await app.runtime.run({ prompt: "Please greet Ada for me.", permissions: ["memory.write"] });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "I have greeted Ada.");
  assert.deepEqual(doubles.calls, [{ name: "notes.add", input: { name: "Ada" } }]);
  assert.deepEqual(doubles.calledWith("notes.add"), [{ name: "Ada" }]);
  doubles.reset();
  assert.deepEqual(doubles.calls, []);
});

test("a scripted reply can look at the request it is answering", async () => {
  const provider = new ScriptedProvider([
    ["how many tools", [(request) => ({ content: `There are ${request.tools.length}.`, toolCalls: [] })]],
  ]);
  const answer = await provider.complete({
    messages: [{ role: "user", content: "how many tools are there?" }],
    tools: [{ name: "a", description: "", parameters: {} }, { name: "b", description: "", parameters: {} }],
    signal: AbortSignal.timeout(1000), maxTokens: 100,
  });
  assert.equal(answer.content, "There are 2.");
});
