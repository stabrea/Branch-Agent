/**
 * Dogfood B1 ("no thought process shown while it works"): the thinking a model writes reaches the live row as
 * `model.thinking` events while "show reasoning" is on (its default), a little at a time, and never when it is off.
 * A scripted model that thinks before it answers; nothing reaches a provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { saveKnobs } from "../dist/knobs/settings.js";

async function thinker(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-thinking-shown-"));
  const provider = { name: "scripted", async complete(request) {
    request.onReasoningDelta?.("Looking at what was asked. ");
    request.onReasoningDelta?.("The answer is short.");
    request.onTextDelta?.("Done.");
    return { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
const thinking = (app, run) => app.store.events(run.id).filter((event) => event.kind === "model.thinking");

test("with show reasoning on, the thinking reaches the live row while it is written", async (t) => {
  const app = await thinker(t);
  const run = await app.runtime.run({ prompt: "hi", onTextDelta: () => {} });
  const shown = thinking(app, run);
  assert.equal(shown.length, 1, "once a second at most: the second piece came within the same second");
  assert.match(shown[0].data.text, /Looking at what was asked/);
  assert.equal(run.output, "Done.", "the thinking never becomes the answer");
});

test("with show reasoning off, it is only heard, as before", async (t) => {
  const app = await thinker(t);
  saveKnobs(app.store, app.runtime.owner, "reasoning", { showReasoning: false });
  const run = await app.runtime.run({ prompt: "hi", onTextDelta: () => {} });
  assert.deepEqual(thinking(app, run), []);
});
