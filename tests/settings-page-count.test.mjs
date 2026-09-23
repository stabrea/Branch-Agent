import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const currentSurfaces = [
  "public/locales/en.json",
  "public/locales/fr.json",
  "src/commands/catalog.ts",
  "src/terminal-parity.ts",
  "src/terminal-screen.ts",
  "src/terminal-tui.ts",
  "docs/design.md",
  "docs/configuration.md",
  "docs/places.md",
  "docs/features.md",
];

test("current product copy never hard-codes the changing Settings page count", async () => {
  for (const file of currentSurfaces) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /twelve Settings pages|twelve pages|douze pages des paramètres/i, file);
  }
});

test("the ledger's summary is the ledger's own counts, not a number somebody typed", async () => {
  // docs/features.md tells a reader how many rows are implemented, partial, external and missing.
  // Those numbers were written by hand beside a file that changes, so the two drifted apart: one row
  // moving from partial to implemented left the sentence describing a ledger that no longer existed.
  // The sentence is checked against the file it describes.
  const ledger = JSON.parse(await readFile("docs/features.json", "utf8"));
  const counted = {};
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (typeof node.status === "string") counted[node.status] = (counted[node.status] ?? 0) + 1;
    Object.values(node).forEach(walk);
  };
  walk(ledger);

  const words = await readFile("docs/features.md", "utf8");
  const said = /(\d+) implemented, (\d+) partial, (\d+) external, (\d+) missing/.exec(words);
  assert.ok(said, "the summary still says how many of each there are");
  assert.deepEqual(
    { implemented: Number(said[1]), partial: Number(said[2]), external: Number(said[3]), missing: Number(said[4]) },
    { implemented: counted.implemented ?? 0, partial: counted.partial ?? 0,
      external: counted.external ?? 0, missing: counted.missing ?? 0 },
    "the words and the file they describe say the same thing");
});
