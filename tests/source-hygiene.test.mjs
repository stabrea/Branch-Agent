/**
 * Three separate branches have now committed a source file containing a literal NUL byte, written
 * by hand into a template or a regular expression. Git then treats the file as binary: it stops
 * normalising line endings, `git diff` shows nothing useful, and a later merge conflicts on the
 * whole file instead of the few lines that changed. Each time it cost somebody an afternoon.
 *
 * A NUL in source is always a mistake here; the escape is what was meant every time.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const roots = ["src", "public", "tests", "scripts", "docs"];
const endings = [".ts", ".js", ".mjs", ".cjs", ".json", ".html", ".css", ".md"];

async function sourceFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(path));
    else if (endings.some((end) => entry.name.endsWith(end))) found.push(path);
  }
  return found;
}

test("no source file carries a literal NUL byte", async () => {
  const offenders = [];
  for (const root of roots)
    for (const path of await sourceFiles(fileURLToPath(new URL("../" + root, import.meta.url)))) {
      const bytes = await readFile(path);
      const at = bytes.indexOf(0);
      if (at !== -1) offenders.push(`${path} at byte ${at}`);
    }
  assert.deepEqual(offenders, [],
    "these files contain a literal NUL, which makes git treat them as binary. Write the escape instead.");
});
