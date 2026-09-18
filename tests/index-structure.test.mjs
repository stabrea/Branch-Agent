import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/* A merge once dropped a </form>, so the browser folded the next card into the one above and it never showed. */
test("every settings form in the page is closed before the next one opens", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const text = html.replace(/<!--[\s\S]*?-->/g, "");
  let open = null;
  for (const m of text.matchAll(/<(\/?)form\b[^>]*?(?:id="([^"]*)")?[^>]*>/g)) {
    if (m[1]) { assert.ok(open !== null, "a </form> closes nothing"); open = null; continue; }
    assert.equal(open, null, `form ${m[2] ?? "(no id)"} opens inside form ${open}`);
    open = m[2] ?? "(no id)";
  }
  assert.equal(open, null, `form ${open} is never closed`);
});

/* The merge helper once kept both sides of a script-tag conflict that already shared lines, loading scripts twice. */
test("every script in the page is listed once", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const sources = [...html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const twice = sources.filter((src, i) => sources.indexOf(src) !== i);
  assert.deepEqual(twice, [], `listed more than once: ${twice.join(", ")}`);
});
