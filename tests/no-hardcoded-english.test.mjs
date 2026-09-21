import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pub = join(root, "public");

/**
 * Text a person reads must go through the locale files, or a French speaker sees English. A sentence
 * assigned straight to `textContent`, `placeholder` or `title` never reaches `public/locales/*.json`,
 * so it can never be translated -- and nothing complained, because the language files themselves were
 * valid (tests/locales-contract.test.mjs checks the files, not whether the page uses them).
 *
 * A file offends by default. The only way out is NOT_YET below, which costs a written reason.
 */
const NOT_YET = {
  "app.js": "Eight status lines. Left for a separate PR: this file is in open work on the rooms and health checks.",
  "shell.js": "Four status lines. Left for a separate PR: this file is in open work on the Grown-Up design.",
};

/** A capital, then at least two lower-case words: a sentence, not a key, a unit or a name. */
const SENTENCE = /\.(textContent|placeholder|title)\s*=\s*"([A-Z][a-z]+ [a-z][^"]*)"/g;

async function offenders() {
  const found = [];
  for (const name of (await readdir(pub)).filter((file) => file.endsWith(".js"))) {
    if (Object.hasOwn(NOT_YET, name)) continue;
    const source = await readFile(join(pub, name), "utf8");
    for (const match of source.matchAll(SENTENCE)) found.push(`${name}: ${match[1]} = "${match[2]}"`);
  }
  return found.sort();
}

test("no page script writes an English sentence the locale files cannot translate", async () => {
  assert.deepEqual(await offenders(), [],
    "route these through t() from ./i18n.js, with the words in public/locales/en.json and fr.json");
});

test("every file excused from translating has a written reason", () => {
  const thin = Object.entries(NOT_YET).filter(([, why]) => typeof why !== "string" || why.trim().length < 20);
  assert.deepEqual(thin.map(([name]) => name), []);
});

/** The keys these files now use must exist in both languages, and French must really be French. */
test("every key the translated scripts use is in English and in French", async () => {
  const en = JSON.parse(await readFile(join(pub, "locales", "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(pub, "locales", "fr.json"), "utf8"));
  const problems = [];
  for (const name of ["docs-3.js", "docs-memory-2.js", "learn.js", "collab.js", "other.js", "specialist-styles.js",
    "activity-log.js", "diagnostics.js", "model-profiles.js", "mcp-workbench.js", "charts.js", "markdown.js",
    "sandbox-remote.js", "flows.js", "labels-ui.js"]) {
    const source = await readFile(join(pub, name), "utf8");
    for (const [, key] of source.matchAll(/\bt\("([\w.-]+)"/g)) {
      if (typeof en[key] !== "string") problems.push(`${name}: ${key} has no English`);
      else if (typeof fr[key] !== "string") problems.push(`${name}: ${key} has no French`);
      else if (fr[key] === en[key] && /[a-z]{4} [a-z]/.test(en[key])) problems.push(`${name}: ${key} is still English in fr.json`);
    }
  }
  assert.deepEqual(problems, []);
});
