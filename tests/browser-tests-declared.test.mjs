import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { testGroups } from "../scripts/run-tests.mjs";

/**
 * A test that starts a real browser must say so, or the lane that runs it starts none.
 *
 * The bug this comes from: `tests/browser-session.test.mjs` drove Chromium through Branch's **own**
 * browser tool instead of importing Playwright to steer it. Both selectors decide what a file needs by
 * one signal — a literal `playwright` import — so the file looked like a test that needed nothing. In a
 * full run that is invisible, because every group gets a browser anyway. In the narrow lane it is a red
 * tick reading `Executable doesn't exist`, and an hour spent on a failure that is not a failure.
 *
 * So this does not test behaviour. It reads every test file and asks one question: does it make one of
 * the browser-backed tools run? A file that does and is not in the browser group is an offender BY
 * DEFAULT, and the only way out is EXCUSED below.
 *
 * Two things make that list hard to lean on:
 *
 *   - **the tool names come from the product**, not from a list kept here, so a `browser.pdf` added
 *     tomorrow is covered the day it is written;
 *   - **an excuse is about a line, not a file.** The excused lines must be exactly the lines in the
 *     file — no more, no fewer. A file that gains a real call cannot hide behind an excuse written for
 *     the fake one beside it.
 */

const ROOT = join(import.meta.dirname, "..");

/** How a browser is made, and how a name is given to one that already exists. */
const MAKES_ONE = /new\s+BranchBrowser\b/;
/** Every construction, so they can be counted rather than merely noticed. */
const MAKES_EACH = /new\s+BranchBrowser\b/g;
const MADE_HERE = /(?:(?:const|let|var)\s+|,\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:await\s+)?new\s+BranchBrowser\b/g;
const RENAMED = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;/g;
/** How the product writes a tool's name where it registers it, in any of the three quote styles. */
const NAME_DECLARATION = /name:\s*["'`]((?:browser|computer)\.[A-Za-z_]+)["'`]/g;
/** How a method of the browser object is written, with `private` captured so it can be left out. */
const METHOD_DECLARATION = /^\s{2}(private\s+)?(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^(]*>)?\s*\(/gm;

/** Every `.ts` file under src, so a tool cannot hide by being registered somewhere new. */
async function productSources(dir = "src") {
  const found = [];
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true }).catch(() => [])) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await productSources(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

/**
 * Every browser-backed tool the product registers, read from the product itself — from **all** of it.
 * Naming the two files known to register them is how `browser.notes` stayed invisible: it is
 * registered in `src/integrations/browser-notes-tool.ts`, which was not one of the two. A list of
 * places is the same mistake as a list of names, one level up.
 */
export async function browserBackedNames(read = (file) => readFile(join(ROOT, file), "utf8"), files) {
  const sources = await Promise.all((files ?? await productSources()).map((file) => read(file).catch(() => "")));
  const names = new Set();
  for (const source of sources)
    for (const found of source.matchAll(NAME_DECLARATION)) names.add(found[1]);
  return [...names].sort();
}

/**
 * What the browser object itself can be asked to do, read off `BranchBrowser`. A written-out list of
 * method names left `annotate` and `extractShaped` unseen on the day they were added, and would have
 * left the next one unseen too. Private methods are left out: a test cannot call one.
 */
export async function browserMethods(read = (file) => readFile(join(ROOT, file), "utf8")) {
  const source = await read("src/integrations/browser.ts");
  const body = source.slice(source.indexOf("export class BranchBrowser"));
  const names = new Set();
  for (const found of body.matchAll(METHOD_DECLARATION)) if (!found[1]) names.add(found[2]);
  names.delete("constructor");
  return [...names].sort();
}

/** Whether a file makes a browser at all, however it then keeps hold of it. */
export const makesOne = (source) => MAKES_ONE.test(source);

/**
 * Constructions this cannot attribute to a name, counted one at a time.
 *
 * Refusing a *file* that makes a browser and yields no name at all was the first rule here, and it
 * had a hole the width of a second construction: one readable `const browser = new BranchBrowser(...)`
 * satisfied "a name was derived", and anything hidden after it — a later assignment, an array, a
 * property — rode in behind it with its calls unseen. A file is the wrong unit. Each construction
 * has to be one the reader can put a name to, so both numbers are counted and the difference is what
 * is refused.
 */
/**
 * The lines of a file that are code, for counting purposes: a comment is prose and a construction
 * written inside a quoted string is a fixture. This file is full of both — it explains the shapes it
 * refuses and holds them as test data — and counting those as real constructions would have it refuse
 * itself. Only the counting uses this; nothing else reads it.
 */
export function codeLines(source) {
  const out = [];
  let inBlock = false;
  for (const raw of source.split(/\r?\n/)) {
    let line = raw;
    if (inBlock) {
      const ends = line.indexOf("*/");
      if (ends < 0) { out.push(""); continue; }
      line = line.slice(ends + 2);
      inBlock = false;
    }
    const opens = line.indexOf("/*");
    if (opens >= 0) { inBlock = !line.includes("*/", opens); line = line.slice(0, opens); }
    const slashes = line.indexOf("//");
    if (slashes >= 0) line = line.slice(0, slashes);
    // A construction sitting inside a quoted string is test data, not a construction.
    out.push(line.replace(/(["'\`])(?:\\.|(?!\1)[^\\])*\1/g, (quoted) => " ".repeat(quoted.length)));
  }
  return out.join("\n");
}

export function unreadableConstructions(source) {
  const code = codeLines(source);
  const made = (code.match(MAKES_EACH) ?? []).length;
  const readable = [...code.matchAll(MADE_HERE)].length;
  return Math.max(0, made - readable);
}
/** The names a file is seen giving to a browser it makes — not counting the usual name, which is assumed. */
export function constructedIn(source) {
  return [...new Set([...source.matchAll(MADE_HERE)].map((made) => made[1]))].sort();
}
/**
 * What a file calls the browser it made. `browser` is the usual name and is always one of them, but a
 * file is free to call it anything — `const driver = new BranchBrowser(...)` — and a reader that only
 * knew the usual name would let every call on it through. A name given to one that already exists
 * counts too: any number of hops in the order they are written, and one hop written before its
 * source, both of which a helper handing a browser back into a test will do.
 *
 * **What this cannot follow at all:** a browser handed in as an argument and named by the parameter,
 * and one made by a factory rather than by `new`. Neither constructs anything here, so nothing below
 * catches them either; they are the two shapes that are genuinely on trust, and no test in the
 * repository does one today.
 *
 * Every other way of holding on to a browser it makes — assigned on a later line, destructured out
 * of an array, kept in an object property — is not enumerated, because enumerating is the thing that
 * went wrong: a list of shapes is a promise that the list is complete, and mine was not. A file that
 * makes a browser and whose name for it this cannot read is **refused** instead (`makesOne` and
 * `constructedIn` above, used by the first test below). Measured before choosing it: of the thirteen
 * test files that make a browser today, **none** would be refused.
 */
export function receiversIn(source) {
  const found = new Set(["browser", ...constructedIn(source)]);
  for (const renamed of source.matchAll(RENAMED)) if (found.has(renamed[2])) found.add(renamed[1]);
  return [...found].sort();
}

/**
 * Every line of a test that makes one of those tools run. Deliberately generous about *how*: through
 * the registry, through the runtime's own dispatch, as a tool call a scripted model makes, or straight
 * at a browser object. What it does not do is guess which of those is "really" a launch — that
 * judgement belongs in EXCUSED, where somebody has to write it down.
 *
 * Read whole rather than line by line. A dispatch written across two lines — the opening bracket on
 * one, the tool's name on the next — is the ordinary way a long call is laid out, and a reader that
 * took one line at a time could not see one. The line reported is the line the call starts on, which
 * is the line an excuse quotes.
 */
export function callsitesIn(source, names, methods = [], receivers = receiversIn(source)) {
  // Every character that is not a letter, a digit or an underscore is escaped one at a time. A
  // character class would do the same job in one line and is exactly the kind of line that arrives
  // here with a backslash missing.
  const escaped = (text) => [...text].map((one) => (/[A-Za-z0-9_]/.test(one) ? one : "\\" + one)).join("");
  const anyName = names.map(escaped).join("|") || "(?!)";
  const anyMethod = methods.map(escaped).join("|") || "(?!)";
  const gap = "\\s*";                       // any run of space, newlines included
  // A double quote, a single quote and a backtick, written by their numbers so that no layer
  // between this file and a reader has to agree about how to escape them.
  const quote = "[" + String.fromCharCode(34, 39, 96) + "]";
  const patterns = [
    new RegExp(`(?:execute|executeTool|call|run)${gap}\\(${gap}${quote}(?:${anyName})${quote}`, "g"),
    new RegExp(`name:${gap}${quote}(?:${anyName})${quote}`, "g"),
    new RegExp(`\\b(?:${receivers.map(escaped).join("|") || "(?!)"})\\.(?:${anyMethod})${gap}\\(`, "g"),
  ];
  const lines = source.split(/\r?\n/);
  const startOf = [];
  let at = 0;
  for (const line of lines) { startOf.push(at); at += line.length + 1; }
  const lineAt = (index) => {
    let low = 0, high = startOf.length - 1;
    while (low < high) { const mid = (low + high + 1) >> 1; if (startOf[mid] <= index) low = mid; else high = mid - 1; }
    return low;
  };
  // One entry per line, as before: two lines that read the same are still two, because an excuse is
  // about a line and a file may hold the same stand-in twice.
  const hit = new Set();
  for (const pattern of patterns)
    for (const found of source.matchAll(pattern)) hit.add(lineAt(found.index));
  return [...hit].sort((one, other) => one - other).map((index) => lines[index].trim());
}

/**
 * Lines that name a browser-backed tool and never start a browser. Each file costs a written sentence,
 * and each line is listed, so a new call cannot arrive quietly beside an old excuse.
 */
const EXCUSED = {
  "tests/approvals.test.mjs": {
    why: "it registers a stand-in tool of its own called browser.click, whose execute returns { clicked: true }; no browser is involved",
    callsites: [
      "name: \"browser.click\", permission: \"browser.interact\", description: \"click\",",
    ],
  },
  "tests/asks-verify.test.mjs": {
    why: "these computer tools are aimed at a window on this computer (at: \"window\"), which is the desktop path, not the page one",
    callsites: [
      "await assert.rejects(registry.execute(\"computer.look\", { at: \"window\", window: \"Notes\" }, context), /turn|switch|off/i,",
      "const looked = await registry.execute(\"computer.look\", { at: \"window\", window: \"Notes\" }, context);",
      "await registry.execute(\"computer.press\", { at: \"window\", window: \"Notes\", name: \"Save\" }, context);",
      "await registry.execute(\"computer.type\", { at: \"window\", window: \"Notes\", name: \"Body\", text: \"hello\" }, context);",
    ],
  },
  "tests/guardrails.test.mjs": {
    why: "the one navigate is inside assert.rejects: the address is on the blocked list and is refused before anything launches Closing a browser that never launched opens nothing.",
    callsites: [
      "await assert.rejects(browser.navigate(\"https://example.org/admin/panel\", { owner: \"local\", runId: \"r1\", signal: new AbortController().signal, permissions: new Set(), depth: 0, workspace: \"\", budget: {} }), /on the blocked list/);",
      "await browser.close();",
    ],
  },
  "tests/hardening.test.mjs": {
    why: "an outside MCP server advertises a tool it calls browser.click; these lines are that server's own messages, not Branch's browser",
    callsites: [
      "name: \"browser.click\", description: \"Click something on a web page\", permission: \"browser.interact\",",
      "params: { name: \"browser.click\", arguments: { selector: \"#go\" } } }, sessionId);",
      "name: \"browser.click\", description: \"Click something on a web page\", permission: \"browser.interact\",",
      "const ask = { name: \"browser.click\", arguments: { selector: \"#go\" } };",
      "params: { name: \"browser.click\", arguments: { selector: \"#somewhere-else\" } } }, sessionId);",
      "name: \"browser.click\", description: \"Click something on a web page\", permission: \"browser.interact\",",
      "method: \"tools/call\", params: { name: \"browser.click\", arguments: { selector: `#${at}` } } }, id));",
      "name: \"browser.click\", description: \"Click something on a web page\", permission: \"browser.interact\",",
      "params: { name: \"browser.click\", arguments: { selector: \"#first\" } } }, sessionId);",
      "params: { name: \"browser.click\", arguments: { selector: \"#second\" } } }, sessionId);",
    ],
  },
  "tests/lockdown-modes.test.mjs": {
    why: "Lockdown refuses the call before the browser is reached, and the test asserts nothing ran at all",
    callsites: [
      "await assert.rejects(branch.runtime.executeTool(\"browser.borrow\", {}, byHand), /Lockdown is on/);",
    ],
  },
  "tests/mcp-mode.test.mjs": {
    why: "the same outside MCP server's advertised browser.click; Branch's own browser is never asked for anything",
    callsites: [
      "name: \"browser.click\", description: \"Click something on a web page\", permission: \"browser.interact\",",
      "jsonrpc: \"2.0\", id: 4, method: \"tools/call\", params: { name: \"browser.click\", arguments: { selector: \"#go\" } },",
    ],
  },
  "tests/research-browser.test.mjs": {
    why: "stand-in browser tools are registered so research can be driven without one; their execute returns fixed text",
    callsites: [
      "app.registry.register({ name: \"browser.navigate\", permission: \"browser.read\", description: \"stand-in\",",
      "app.registry.register({ name: \"browser.snapshot\", permission: \"browser.read\", description: \"stand-in\",",
      "app.registry.register({ name: \"browser.navigate\", permission: \"browser.read\", description: \"stand-in\",",
      "app.registry.register({ name: \"browser.snapshot\", permission: \"browser.read\", description: \"stand-in\",",
    ],
  },
  "tests/sandbox-remote.test.mjs": {
    why: "every navigate here is inside assert.rejects(/not an allowed origin/), checking addresses rather than opening them",
    callsites: [
      "await assert.rejects(browser.navigate(\"https://elsewhere.test/\", context), /not an allowed origin/);",
      "await assert.rejects(browser.navigate(\"https://docs.rs/\", context), /not on the allowed list/);",
      "await assert.rejects(browser.navigate(\"https://user:pw@example.com/\", context), /not an allowed origin/);",
      "await assert.rejects(browser.navigate(nonsense, context), /not an allowed origin/, JSON.stringify(nonsense));",
    ],
  },
  "tests/tracing-policy.test.mjs": {
    why: "a scripted model calls a stand-in browser.click that the test itself registers, to watch the rules judge a website",
    callsites: [
      "const { app, api } = await served(t, [calls({ id: \"c1\", name: \"browser.click\", arguments: JSON.stringify({ name: \"Buy\" }) }), say(\"done\")]);",
      "name: \"browser.click\", permission: \"browser.interact\", description: \"click\",",
    ],
  },
  "tests/web-pages.test.mjs": {
    why: "stand-in browser tools, registered so the page reader can be driven without a browser Closing one opens nothing; the teardown runs whether or not anything launched.",
    callsites: [
      "app.registry.register({ name: \"browser.navigate\", permission: \"browser.read\", description: \"stand-in\",",
      "app.registry.register({ name: \"browser.snapshot\", permission: \"browser.read\", description: \"stand-in\",",
      "closers.push(() => browser.close());",
    ],
  },
};

async function testFiles() {
  const found = [];
  for (const folder of ["tests", join("packages", "sdk", "test")]) {
    const entries = await readdir(join(ROOT, folder), { withFileTypes: true }).catch(() => []);
    for (const entry of entries)
      if (entry.isFile() && entry.name.endsWith(".test.mjs")) found.push(`${folder.replaceAll("\\", "/")}/${entry.name}`);
  }
  return found.sort();
}
const slash = (file) => file.replaceAll("\\", "/");
/**
 * This file quotes callsites rather than making them: the excused lines below, and the little examples
 * the detector is measured against. It is named here rather than excused line by line, because keeping
 * a list of its own quotations in step with itself would be busywork that proves nothing.
 */
const SELF = "tests/browser-tests-declared.test.mjs";

/** How page notes are registered in the product, single quotes and all. */
const REGISTERED_NOTES = ["registry.register({ name: ", String.fromCharCode(39) + "browser.notes" + String.fromCharCode(39),
  ", permission: " + String.fromCharCode(39) + "browser.read" + String.fromCharCode(39) + ","].join("");
/** One dispatch, written the way a long one is written. */
const OVER_TWO_LINES = ["await registry.execute(", '  "browser.pdf",', "  {},", "  context);"]
  .join(String.fromCharCode(10));

/**
 * The judgement itself, over whatever files it is given. Separated from the walk over the repository
 * so it can be run against files written for the purpose: a gate nothing currently trips is a gate
 * nothing proves, and taking the refusal out of a walk over a clean repository changes no result at
 * all. Ask it about a file that hides its browser and the answer is what says the gate is wired in.
 */
export async function judgeFiles(files, read, names, methods, inBrowserGroup = new Set(), excuses = EXCUSED) {
  const offenders = [], unreadable = [];
  for (const file of files) {
    if (inBrowserGroup.has(file) || file === SELF) continue;
    const source = await read(file);
    // Fails closed. A file that makes a browser and keeps it somewhere this cannot read is refused
    // rather than passed in silence: the alternative is a longer list of shapes, and a list is a
    // promise that it is complete.
    if (unreadableConstructions(source)) unreadable.push(file);
    const sites = callsitesIn(source, names, methods);
    if (!sites.length) continue;
    const excused = [...(excuses[file]?.callsites ?? [])];
    for (const site of sites) {
      const at = excused.indexOf(site);
      if (at === -1) offenders.push(`${file}: ${site.slice(0, 100)}`);
      else excused.splice(at, 1);
    }
  }
  return { offenders, unreadable };
}

test("a file that makes a browser and hides the name it gives it is refused", async () => {
  const names = await browserBackedNames(), methods = await browserMethods();
  const NL = String.fromCharCode(10);
  const written = {
    "tests/hidden-later.test.mjs": ["let driver;", "driver = new BranchBrowser({});", "await driver.pdf(context);"],
    "tests/hidden-array.test.mjs": ["const [driver] = [new BranchBrowser({})];", "await driver.pdf(context);"],
    "tests/hidden-property.test.mjs": ["const kit = { b: new BranchBrowser({}) };", "await kit.b.navigate(url, context);"],
    "tests/plain.test.mjs": ["const browser = new BranchBrowser({});", "await browser.close();"],
    "tests/named.test.mjs": ["const driver = new BranchBrowser({});", "await driver.close();"],
    "tests/nothing.test.mjs": ["assert.equal(1, 1);"],
    /* Codex's exact-head review: one readable construction used to answer for the whole file, so a
       second hidden one rode in behind it with its calls unseen. Counting per file could not see this;
       counting per construction can. */
    "tests/mixed.test.mjs": ["const browser = new BranchBrowser({});", "await browser.close();",
      "let hidden;", "hidden = new BranchBrowser({});", "await hidden.pdf(context);"],
    /* And the shape that made counting per construction cost something: a declarator after a comma is
       an ordinary way to write real code, and tests/browser.test.mjs writes it five times. */
    "tests/comma.test.mjs": ["const probe = observeLaunch(), browser = new BranchBrowser({});",
      "await browser.close();"],
    /* A construction that is prose, and one that is a fixture. Neither is a construction. */
    "tests/prose.test.mjs": ["// const browser = new BranchBrowser({});", "assert.equal(1, 1);"],
    "tests/fixture.test.mjs": ['const written = ["const x = new BranchBrowser({});"];', "assert.ok(written);"],
  };
  const judged = await judgeFiles(Object.keys(written), async (file) => written[file].join(NL), names, methods);

  assert.deepEqual(judged.unreadable,
    ["tests/hidden-later.test.mjs", "tests/hidden-array.test.mjs", "tests/hidden-property.test.mjs",
      "tests/mixed.test.mjs"],
    "each of these makes a browser and keeps it where the name cannot be read");
  // The decision is per construction: one readable one does not answer for a hidden one beside it.
  assert.equal(unreadableConstructions(written["tests/mixed.test.mjs"].join(NL)), 1,
    "exactly the hidden one of the two is refused");
  assert.equal(judged.unreadable.includes("tests/comma.test.mjs"), false,
    "a declarator after a comma is ordinary code and must not be refused");
  assert.equal(judged.unreadable.includes("tests/prose.test.mjs"), false, "a comment is not a construction");
  assert.equal(judged.unreadable.includes("tests/fixture.test.mjs"), false, "and neither is a quoted fixture");
  assert.equal(judged.unreadable.includes("tests/plain.test.mjs"), false, "a plain const is readable");
  assert.equal(judged.unreadable.includes("tests/named.test.mjs"), false, "and so is a plain const under another name");
  assert.equal(judged.unreadable.includes("tests/nothing.test.mjs"), false, "and a file that makes none is not asked");
  // The readable ones are still judged on what they do with it, which here is only to close it -- and
  // the mixed file is an offender as well as unreadable, because the call it *can* read still counts.
  assert.deepEqual(judged.offenders.map((one) => one.split(":")[0]).sort(),
    ["tests/comma.test.mjs", "tests/mixed.test.mjs", "tests/named.test.mjs", "tests/plain.test.mjs"],
    "closing one is still a line somebody has to excuse");
});

test("a test that runs a browser-backed tool is in the browser group, or every such line is excused", async () => {
  const names = await browserBackedNames(), methods = await browserMethods();
  const inBrowserGroup = new Set(testGroups().browser.map(slash));
  const { offenders, unreadable } = await judgeFiles(await testFiles(),
    (file) => readFile(join(ROOT, file), "utf8"), names, methods, inBrowserGroup);
  assert.deepEqual(unreadable, [],
    "These make a browser and keep it under a name this cannot read — assigned on a later line, out of "
    + "an array, in an object property. Give it a plain `const name = new BranchBrowser(...)`, or put the "
    + "file in the browser group. It is refused rather than passed because what it does with that browser "
    + "cannot be seen from here.");
  assert.deepEqual(offenders, [],
    "These make a browser-backed tool run, and no browser is installed for the lane that runs them. Declare the "
    + "engine the way tests/comfort.test.mjs does, or add the exact line to EXCUSED with a reason it never launches.");
});

test("every excused line is still in its file, and every excuse still has a file", async () => {
  const names = await browserBackedNames(), methods = await browserMethods();
  const files = new Set(await testFiles());
  const stale = [];
  for (const [file, excuse] of Object.entries(EXCUSED)) {
    assert.ok(excuse.why.length > 40, `${file}: the reason has to be a sentence somebody can disagree with`);
    if (!files.has(file)) { stale.push(`${file} (gone)`); continue; }
    const sites = callsitesIn(await readFile(join(ROOT, file), "utf8"), names, methods);
    for (const line of excuse.callsites)
      if (!sites.includes(line)) stale.push(`${file}: excused a line that is no longer there — ${line.slice(0, 80)}`);
  }
  assert.deepEqual(stale, [], "These excuses are no longer about anything; take them out.");
});

test("the detector notices every way one of these tools can be made to run", async () => {
  const names = await browserBackedNames(), methods = await browserMethods();
  assert.ok(names.includes("browser.pdf") && names.includes("browser.act") && names.includes("computer.look"),
    `the names come from the product, so they include the ones nobody thought to list (${names.length} of them)`);
  const seen = (source) => callsitesIn(source, names, methods).length;

  assert.equal(seen('await registry.execute("browser.pdf", {}, context);'), 1, "through the registry");
  assert.equal(seen('await app.runtime.executeTool("browser.act", { what: "buy" }, context);'), 1, "through the runtime");
  assert.equal(seen('calls({ id: "c1", name: "browser.act", arguments: "{}" })'), 1, "as a tool call a model makes");
  assert.equal(seen('await registry.execute("computer.look", { at: "page" }, context);'), 1, "a page-targeted computer tool");
  assert.equal(seen("await browser.pdf(context);"), 1, "straight at a browser object");
  assert.equal(seen('const note = "the browser.pdf tool writes a file";'), 0, "but prose about a tool is not a call");

  // The four an independent re-review found it blind to. Each is a way a browser is really reached,
  // and each was invisible for its own reason: a tool registered in a file nobody listed, two methods
  // missing from a written-out list, and a call laid out over more than one line.
  assert.ok(names.includes("browser.notes"),
    "a tool registered outside the two files that used to be read: src/integrations/browser-notes-tool.ts");
  assert.equal(seen(REGISTERED_NOTES), 1, "so registering it is seen, in whichever quotes it is written");
  assert.equal(seen("await browser.annotate(mark, context);"), 1, "straight at a method nobody listed");
  assert.equal(seen("await browser.extractShaped(shape, context);"), 1, "including one with a capital in it");
  assert.equal(seen(OVER_TWO_LINES), 1,
    "and a dispatch laid out over more than one line, which reading a line at a time could not see");

  // A file is free to call its browser anything. Only knowing the usual name let every call on one
  // with another name walk straight past.
  const RENAMED_RECEIVER = ["const driver = new BranchBrowser({ allowedOrigins: [] });",
    "await driver.navigate(\"https://example.org/\", context);"].join(String.fromCharCode(10));
  assert.equal(seen(RENAMED_RECEIVER), 1, "a browser called something other than `browser`");
  assert.deepEqual(receiversIn(RENAMED_RECEIVER), ["browser", "driver"],
    "the names come from the file: the usual one, and the one it gave the browser it made");

  const HANDED_ON = ["const driver = new BranchBrowser({});", "const other = driver;",
    "await other.pdf(context);"].join(String.fromCharCode(10));
  assert.equal(seen(HANDED_ON), 1, "and one more name given to the same browser, which is how a helper hands one back");

  // Every way of holding on to a browser it made that this cannot read is **refused** rather than
  // enumerated: the file is an offender, named, with what to do about it. Enumerating is what went
  // wrong last time — a list of shapes promises the list is complete, and mine was not.
  const held = {
    "assigned on a line after it is declared": ["let driver;", "driver = new BranchBrowser({});", "await driver.pdf(context);"],
    "taken out of an array": ["const [driver] = [new BranchBrowser({})];", "await driver.pdf(context);"],
    "kept in an object property": ["const kit = { b: new BranchBrowser({}) };", "await kit.b.navigate(url, context);"],
    "a method taken off it on its own": ["const { navigate } = new BranchBrowser({});", "await navigate(url, context);"],
  };
  for (const [what, lines] of Object.entries(held)) {
    const source = lines.join(String.fromCharCode(10));
    assert.equal(seen(source), 0, `not seen as a call, which is the point: ${what}`);
    assert.ok(makesOne(source) && constructedIn(source).length === 0,
      `and refused instead of passed, because the name cannot be read: ${what}`);
  }

  // The two that are genuinely on trust, because nothing is constructed in the file to refuse. Named
  // rather than left to be found, and no test in the repository does either today.
  for (const [what, lines] of Object.entries({
    "a browser handed in and named by the parameter": ["async function drive(engine) { await engine.pdf(context); }"],
    "a browser made by a factory rather than by `new`": ["const made = buildBrowser();", "await made.snapshot(context);"],
  })) {
    const source = lines.join(String.fromCharCode(10));
    assert.equal(seen(source), 0, `still not seen, and known: ${what}`);
    assert.equal(makesOne(source), false, `and nothing is made here to refuse: ${what}`);
  }

  // What was claimed as one hop is more than one, and the note now says what it does.
  const chain = ["const driver = new BranchBrowser({});", "const a = driver;", "const b = a;", "await b.pdf(context);"];
  assert.equal(seen(chain.join(String.fromCharCode(10))), 1, "a chain of names, in the order they are written");
  const backwards = ["const later = driver;", "const driver = new BranchBrowser({});", "await later.pdf(context);"];
  assert.equal(seen(backwards.join(String.fromCharCode(10))), 1, "and a name written before the browser it points at");

  // The methods come from the class, so the next one added is covered the day it is written.
  assert.ok(methods.includes("annotate") && methods.includes("extractShaped") && methods.includes("navigate"),
    `the methods are read off BranchBrowser (${methods.length} of them)`);
  assert.equal(methods.includes("freeName"), false, "a private method is not something a test can call");
});

test("the files this was written for are in the group that gets a browser", async () => {
  const inBrowserGroup = new Set(testGroups().browser.map(slash));
  for (const file of ["tests/browser-more.test.mjs", "tests/comfort.test.mjs", "tests/comfort-review.test.mjs"])
    assert.ok(inBrowserGroup.has(file), `${file} runs browser-backed tools and must be in the group that gets one`);
});
