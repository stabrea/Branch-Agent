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
