import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pub = join(root, "public");

/**
 * Text a person reads must go through the locale files, or a French speaker sees English. A sentence
 * written straight into the page never reaches `public/locales/*.json`, so it can never be translated --
 * and nothing complained, because the language files themselves were valid
 * (tests/locales-contract.test.mjs checks the files, not whether the page uses them).
 *
 * What counts as "written straight into the page": any string literal -- double, single or back quotes,
 * in a ternary, a `||` or a concatenation -- on the right of `.textContent`, `.innerText`,
 * `.placeholder` or `.title` =, inside `confirm(...)` or `alert(...)`, or as the value of
 * `setAttribute("aria-label" | "title" | "placeholder", ...)`. The English fallback handed to
 * `t()`, `say()`, `sayWith()` or `words()` is not an offender: those look the words up first.
 *
 * Not covered: text passed to a file's own helpers (`button("Read it again", ...)`). There is no way
 * to tell from here which helper arguments reach the screen.
 *
 * A file offends by default. The only way out is NOT_YET below, which costs a written reason.
 */
const NOT_YET = {
  "app.js": "Its status lines are left for a separate PR: this file is in open work on the rooms and health checks.",
  "shell.js": "Its status lines are left for a separate PR: this file is in open work on the Grown-Up design.",
  "update-screen.js": "The updater's own screen. Left to whoever owns the updater and release code, not changed in passing.",
  "widget.js": "Runs on the owner's own web pages, away from the app, where the language files cannot be loaded.",
};

const LIT = String.raw`(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\`(?:[^\`\\]|\\.)*\`)`;
/** Where visible words start: an assignment (not a `===` comparison), a dialog, or a spoken attribute. */
const SHOWN = /\.(?:textContent|innerText|placeholder|title)\s*=(?!=)|\b(?:confirm|alert)\(|setAttribute\(\s*["'](?:aria-label|title|placeholder)["']\s*,/g;
/** A translation call's English fallback: looked up first, so not an offender. */
const FALLBACK = new RegExp(String.raw`\b(?:t|say|sayWith|words)\(\s*[^,()]+,\s*${LIT}`, "g");
/** The statement's literals, up to the first `;` outside quotes -- a ternary may run over several lines. */
const TOKEN = new RegExp(String.raw`${LIT}|;`, "g");
/** A capital word then a lower-case one ("Saved as"), or one capital word ending a sentence ("Saved."). */
/*
 * Two words, or one word ending in punctuation -- and, since review, **one word on its own**. A button
 * that says `Copied` is as English as one that says `Copied.`, and the shape without the full stop was
 * the shape that got through: `markdown.js`, `mcp.js` and four others were showing single English words
 * in places this guard was already looking at, and it passed.
 */
const ENGLISH = /(^|[^\w$.{-])[A-Z][a-z]+[^\s"'`]*(?: 0)* [a-z]|^[A-Z][a-z]+[.!…]?$/;

/** The English sentences `source` shows without the locale files, one line of source each. */
function sentencesIn(source) {
  const found = [];
  for (const start of source.matchAll(SHOWN)) {
    const rest = source.slice(start.index + start[0].length).replace(FALLBACK, "");
    for (const [token] of rest.matchAll(TOKEN)) {
      if (token === ";") break;
      const words = token.slice(1, -1).replace(/\$\{[^}]*\}/g, "0");
      if (ENGLISH.test(words)) { found.push(source.slice(start.index).split("\n")[0].trim()); break; }
    }
  }
  return found;
}

async function offenders() {
  const found = [];
  for (const name of (await readdir(pub)).filter((file) => file.endsWith(".js"))) {
    if (Object.hasOwn(NOT_YET, name)) continue;
    for (const line of sentencesIn(await readFile(join(pub, name), "utf8"))) found.push(`${name}: ${line}`);
  }
  return found.sort();
}

test("the guard catches every way a sentence reaches the page, and lets a looked-up one through", () => {
  const caught = [
    'status.textContent = "Saved. It applies to your next task.";',
    "status.textContent = 'Saved as a copy';",
    "status.textContent = `Saved to ${folder} and nowhere else.`;",
    "remove.title = `Take ${item.name} off this message`;",
    'toggle.textContent = open ? "Put back" : "Remove";',
    'out.textContent = "Looking…";',
    'note.textContent = view.note || "Your vectors are kept here.";',
    'status.textContent = count + " files. Read them first.";',
    'if (!confirm("Clear the log? This cannot be undone.")) return;',
    'box.setAttribute("aria-label", "The label to add");',
    'host.textContent = on\n    ? "You are in the practice workspace."\n    : "Not switched on.";',
  ];
  for (const line of caught) assert.equal(sentencesIn(line).length, 1, `missed: ${line}`);
  const allowed = [
    'status.textContent = t("x.saved");',
    'status.textContent = say("x.saved", "Saved. It applies to your next task.");',
    'name.textContent = words("x.named", `Continue with ${label}`, { name: label });',
    'status.textContent = sayWith("x.back", "Brought back {count} items.", { count: rows });',
    "version.textContent = `Branch Agent ${version}`;",
    'if (node.textContent === "Read it again") go();',
    'cell.textContent = item.name;',
    'row.title = value; }, "x", ["x.hint", "For example: plans the beds"]);',
  ];
  for (const line of allowed) assert.deepEqual(sentencesIn(line), [], `wrongly caught: ${line}`);
});

test("no page script writes an English sentence the locale files cannot translate", async () => {
  assert.deepEqual(await offenders(), [],
    "route these through t() from ./i18n.js, with the words in public/locales/en.json and fr.json");
});

test("every file excused from translating has a written reason", () => {
  const thin = Object.entries(NOT_YET).filter(([, why]) => typeof why !== "string" || why.trim().length < 20);
  assert.deepEqual(thin.map(([name]) => name), []);
});

/** The files this guard made translate, whose keys are checked below. */
const TRANSLATED = ["docs-3.js", "docs-memory-2.js", "learn.js", "collab.js", "other.js", "specialist-styles.js",
  "activity-log.js", "diagnostics.js", "model-profiles.js", "mcp-workbench.js", "charts.js", "markdown.js",
  "sandbox-remote.js", "flows.js", "labels-ui.js", "flow-editor.js", "context-files.js", "knowledge.js", "media.js", "misc.js",
  "tool-catalog.js", "usage.js", "voice-live.js", "automations.js", "browser.js", "deployment.js", "mcp.js",
  "approvals.js", "documents.js", "memory-tidy.js", "self-improving.js", "restore-held.js"];

/** The keys page scripts use must exist in both languages, and French must really be French. */
test("every key a page script looks up is in English and in French", async () => {
  const en = JSON.parse(await readFile(join(pub, "locales", "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(pub, "locales", "fr.json"), "utf8"));
  const problems = [];
  for (const name of TRANSLATED) {
    const source = await readFile(join(pub, name), "utf8");
    for (const [, key] of source.matchAll(/\bt\("([\w.-]+)"/g)) {
      if (typeof en[key] !== "string") problems.push(`${name}: ${key} has no English`);
      else if (typeof fr[key] !== "string") problems.push(`${name}: ${key} has no French`);
      else if (fr[key] === en[key] && /[a-z]{4} [a-z]/.test(en[key])) problems.push(`${name}: ${key} is still English in fr.json`);
    }
  }
  assert.deepEqual(problems, []);
});
