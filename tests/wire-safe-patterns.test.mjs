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
