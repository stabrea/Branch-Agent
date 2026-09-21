/**
 * Owner item 17, slice 2: with Tool loading off, text that "when needed" keeps to a pointer is carried
 * in full, as the owner switched it on: the project's AGENTS.md and the owner's standing instructions
 * (a likely reason agents ignored them). With Tool loading on, as shipped, nothing changes; anything
 * off stays off either way.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { toolLoadingKey } from "../dist/feature-switches.js";

async function fixture(t) {
  const prompts = [];
  const root = await mkdtemp(join(tmpdir(), "branch-context-eager-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), "# House rules\nUse British spelling everywhere, without exception.\n");
  const app = await createBranch({ workspace, dataDir: join(root, "data"),
    provider: { name: "scripted", async complete(request) { prompts.push(request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n")); return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const eager = (mode) => app.store.save("settings", app.runtime.owner, toolLoadingKey, { mode });
  return { app, prompts, eager };
}

test("AGENTS.md set to when needed is a pointer with Tool loading on, and carried in full with it off", async (t) => {
  const { app, prompts, eager } = await fixture(t);
  app.store.save("settings", app.runtime.owner, "context-files", { files: { agents: "when-needed" } });
  await app.runtime.run({ prompt: "Write a note", permissions: [] });
  assert.match(prompts.at(-1), /AGENTS\.md[^\n]*context\.read\("agents"\)/, "on (deferred): one line saying where it is");
  assert.ok(!prompts.at(-1).includes("British spelling"), "and not the text itself");
  eager("eager");
  await app.runtime.run({ prompt: "Write a note", permissions: [] });
  assert.ok(prompts.at(-1).includes("Use British spelling everywhere"), "off (eager): the whole file travels");
  app.store.save("settings", app.runtime.owner, "context-files", { files: { agents: "off" } });
  await app.runtime.run({ prompt: "Write a note", permissions: [] });
  assert.ok(!prompts.at(-1).includes("British spelling") && !prompts.at(-1).includes('context.read("agents")'), "off stays off");
});

test("standing instructions set to when needed are named with Tool loading on, and spelled out with it off", async (t) => {
  const { app, prompts, eager } = await fixture(t);
  app.store.save("settings", app.runtime.owner, "autonomy-instructions", { mode: "when-needed" });
  app.autonomy.instructions.add({ text: "Always sign emails as Taofik", scope: "everyone" });
  await app.runtime.run({ prompt: "Write an email", permissions: [] });
  assert.match(prompts.at(-1), /1 standing instruction for you; read them with instructions\.list/);
  assert.ok(!prompts.at(-1).includes("Always sign emails as Taofik"));
  eager("eager");
  await app.runtime.run({ prompt: "Write an email", permissions: [] });
  assert.match(prompts.at(-1), /Standing instructions from the owner[\s\S]*Always sign emails as Taofik/);
});
