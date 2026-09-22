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
