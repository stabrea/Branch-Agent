import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ToolRegistry, wireSafePatterns } from "../dist/registry.js";

test("a NUL escape in a tool pattern is sent as \\x00, which the ChatGPT backend accepts", () => {
  const out = wireSafePatterns({ properties: { folder: { type: "string", pattern: "^[^\\\\:\\0-][^\\\\:\\0]*$" } } });
  assert.equal(out.properties.folder.pattern, "^[^\\\\:\\x00-][^\\\\:\\x00]*$");
  assert.ok(new RegExp(out.properties.folder.pattern).test("src"));
  assert.ok(!new RegExp(out.properties.folder.pattern).test("a\0b"));
});

test("escaped backslashes, back-references and other keys are left alone", () => {
  assert.equal(wireSafePatterns({ pattern: "a\\\\0b" }).pattern, "a\\\\0b", "a literal backslash then 0");
  assert.equal(wireSafePatterns({ pattern: "(a)\\01" }).pattern, "(a)\\01", "an octal-looking escape");
  assert.equal(wireSafePatterns({ description: "\\0 stays" }).description, "\\0 stays");
  assert.deepEqual(wireSafePatterns({ enum: ["a", "b"] }), { enum: ["a", "b"] });
});

test("every tool description the model sees is free of the NUL escape", () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "git.branches", description: "List lines of work.", permission: "read",
    parameters: z.object({ folder: z.string().regex(/^[^\\:\0-][^\\:\0]*$/) }),
    execute: async () => ({}),
  });
  const [tool] = registry.descriptions(new Set(["read"]), { diet: false });
  assert.ok(!JSON.stringify(tool.parameters).includes("\\\\0"), JSON.stringify(tool.parameters));
});

/**
 * The same endpoint checks every `pattern` against the RE2 subset, which has no lookahead or
 * lookbehind. One of them anywhere refuses the whole request, with no tokens used, and takes every
 * other tool in that round down with it: before this, a task that merely said "git" failed in three
 * seconds having run nothing, because three git schemas used `(?!-)`. A pattern can say the same
 * thing without one, and whatever it cannot say belongs in a check beside the schema.
 */
test("no tool the model is shown uses a lookahead or lookbehind in a pattern", async () => {
  const { createBranch } = await import("../dist/index.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "branch-re2-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } },
  });
  try {
    const offenders = [];
    const walk = (node, where) => {
      if (Array.isArray(node)) return node.forEach((item, at) => walk(item, `${where}[${at}]`));
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "pattern" && typeof value === "string" && /\((\?=|\?!|\?<=|\?<!)/.test(value))
          offenders.push(`${where}: ${value}`);
        else walk(value, `${where}.${key}`);
      }
    };
    for (const tool of app.registry.descriptions(new Set(app.registry.permissions?.() ?? []), { diet: false }))
      walk(tool.parameters, tool.name);
    assert.deepEqual(offenders, [], "these patterns would refuse the whole request on the ChatGPT endpoint");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The catalog is built in one go, so one tool that cannot be written out as JSON Schema takes every
 * other tool down with it. Switching on "search posts on X" did exactly that: a `.transform()` in
 * its schema left every task, on every model, answering only "Transforms cannot be represented in
 * JSON Schema". This walks every switchable feature, switched ON, and insists the whole catalog can
 * still be described.
 */
test("every tool can still be described with each feature switched on", async () => {
  const { createBranch } = await import("../dist/index.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "branch-describe-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } },
  });
  try {
    const groups = [app.personal, app.coding, app.safetyExtras, app.reachParts, app.flowsBoards, app.learningMore, app.autonomy, app.trunks, app.learn]
      .filter((group) => typeof group?.setMode === "function" && typeof group?.modes === "function");
    assert.ok(groups.length >= 3, "the switch groups were not found, so this test would prove nothing");
    const broken = [];
    let switched = 0;
    for (const group of groups) {
      for (const part of Object.keys(group.modes())) {
        // One part at a time, put back afterwards: otherwise the first broken one makes every part
        // switched on after it look broken too, and the report names the wrong feature.
        const was = group.modes()[part];
        try {
          await group.setMode(part, { mode: "on" });
          switched += 1;
          app.registry.descriptions(new Set(app.registry.permissions?.() ?? []), { diet: false });
        } catch (error) {
          const said = error instanceof Error ? error.message : String(error);
          // A part that refuses to switch on here (it wants a key, a connection or a real service) is
          // not this test's business; a catalog that cannot be described afterwards is.
          if (/Transforms|JSON Schema|toJSONSchema/i.test(said) || !/on|key|connect|not available|unsupported/i.test(said))
            broken.push(`${part}: ${said}`);
        } finally {
          try { await group.setMode(part, { mode: typeof was === "string" ? was : "off" }); } catch { /* put back as best we can */ }
        }
      }
    }
    assert.ok(switched >= 20, `only ${switched} features were switched on; this test would prove little`);
    assert.deepEqual(broken, [], "a feature switched on left the assistant with no tools at all");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
