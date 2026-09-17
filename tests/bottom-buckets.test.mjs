import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Buckets 21, 22 and 23 of the public list were settled row by row in one section of
 * docs/configuration.md. This keeps that section honest: every row has a verdict, and every file it
 * names as proof is really there, so a rename cannot leave the list pointing at nothing.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HEADING = "## The smaller asks, the Python client and installing: where each one stands (wave mac2)";
const ROWS = {
  21: ["sdk-python", "A1509", "framework-adapters", "sdk-react", "app-building", "A2353", "A0758", "serialization"],
  22: ["installers", "desktop-packaging", "platform-support", "distributions"],
  23: ["A0794", "A2334", "A0612", "A2221", "A1895", "examples", "integration-blocks", "A0355", "A0354", "A2375",
    "A1012", "A2258", "A0032", "A0601", "A0464", "A2043", "research-pipeline", "gateway", "A0504", "A1620",
    "A1611", "A2240", "A2133", "A1932", "A1934", "A2367"],
};
const VERDICTS = /— (verified|built|partly|not built|not applicable)\b/;

async function section() {
  const text = await readFile(join(root, "docs", "configuration.md"), "utf8");
  const start = text.indexOf(HEADING);
  assert.ok(start >= 0, "the section is missing");
  const next = text.indexOf("\n## ", start + HEADING.length);
  return text.slice(start, next < 0 ? undefined : next);
}

test("every row of buckets 21, 22 and 23 has a verdict", async () => {
  const text = await section();
  const items = text.split("\n- ").slice(1);
  assert.equal(Object.values(ROWS).flat().length, 38, "the list has 38 rows in these buckets");
  for (const id of Object.values(ROWS).flat()) {
    const item = items.find((entry) => entry.includes(`**${id}**`));
    assert.ok(item, `${id} is not listed`);
    assert.match(item.replace(/\s+/g, " "), VERDICTS, `${id} has no verdict`);
  }
});

test("every file the section names as proof exists", async () => {
  const text = await section();
  const named = [...text.matchAll(/`((?:src|tests|packages|scripts|extras|public|data|docs)\/[^`\s]+)`/g)].map((m) => m[1]);
  assert.ok(named.length > 30, "the section names its proof");
  for (const path of new Set(named)) assert.ok(existsSync(join(root, path)), `${path} does not exist`);
});

test("a row called verified names both a source file and a test", async () => {
  const text = await section();
  for (const item of text.split("\n- ").slice(1)) {
    const flat = item.replace(/\s+/g, " ");
    if (!/— verified\b/.test(flat)) continue;
    assert.match(flat, /`(src|scripts|extras|public|packages)\/[^`]+`/, `no source file in: ${flat.slice(0, 60)}`);
    assert.match(flat, /`(tests\/[^`]+\.test\.mjs|packages\/[^`]*test[^`]*)`/, `no test in: ${flat.slice(0, 60)}`);
  }
});
