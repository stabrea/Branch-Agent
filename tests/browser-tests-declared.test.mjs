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

/** Every browser-backed tool the product registers, read from the product itself. */
export async function browserBackedNames(read = (file) => readFile(join(ROOT, file), "utf8")) {
  const sources = await Promise.all(["src/integrations/browser.ts", "src/integrations/computer.ts"].map(read));
  const names = new Set();
  for (const source of sources)
    for (const found of source.matchAll(/name: ["']((?:browser|computer)\.[a-z_]+)["']/g)) names.add(found[1]);
  return [...names].sort();
}

/**
 * Every line of a test that makes one of those tools run. Deliberately generous about *how*: through the
 * registry, through the runtime's own dispatch, as a tool call a scripted model makes, or straight at a
 * browser object. What it does not do is guess which of those is "really" a launch — that judgement
 * belongs in EXCUSED, where somebody has to write it down.
 */
export function callsitesIn(source, names) {
  const escaped = (name) => name.replace(".", "\\.");
  const found = [];
  for (const line of source.split(/\r?\n/)) {
    const named = names.some((name) => line.includes(name)
      && (new RegExp(`(execute|executeTool|call|run)\\s*\\(\\s*["'\`]${escaped(name)}["'\`]`).test(line)
        || new RegExp(`name:\\s*["'\`]${escaped(name)}["'\`]`).test(line)));
    const direct = /\bbrowser\.(navigate|screenshot|snapshot|pdf|act|click|fill|upload|extract|wait|tab)\s*\(/.test(line);
    if (named || direct) found.push(line.trim());
  }
  return found;
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
    why: "the one navigate is inside assert.rejects: the address is on the blocked list and is refused before anything launches",
    callsites: [
      "await assert.rejects(browser.navigate(\"https://example.org/admin/panel\", { owner: \"local\", runId: \"r1\", signal: new AbortController().signal, permissions: new Set(), depth: 0, workspace: \"\", budget: {} }), /on the blocked list/);",
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
    why: "stand-in browser tools, registered so the page reader can be driven without a browser",
    callsites: [
      "app.registry.register({ name: \"browser.navigate\", permission: \"browser.read\", description: \"stand-in\",",
      "app.registry.register({ name: \"browser.snapshot\", permission: \"browser.read\", description: \"stand-in\",",
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

test("a test that runs a browser-backed tool is in the browser group, or every such line is excused", async () => {
  const names = await browserBackedNames();
  const inBrowserGroup = new Set(testGroups().browser.map(slash));
  const offenders = [];
  for (const file of await testFiles()) {
    if (inBrowserGroup.has(file) || file === SELF) continue;
    const sites = callsitesIn(await readFile(join(ROOT, file), "utf8"), names);
    if (!sites.length) continue;
    const excused = EXCUSED[file]?.callsites ?? [];
    for (const site of sites) {
      const at = excused.indexOf(site);
      if (at === -1) offenders.push(`${file}: ${site.slice(0, 100)}`);
      else excused.splice(at, 1);
    }
  }
  assert.deepEqual(offenders, [],
    "These make a browser-backed tool run, and no browser is installed for the lane that runs them. Declare the "
    + "engine the way tests/comfort.test.mjs does, or add the exact line to EXCUSED with a reason it never launches.");
});

test("every excused line is still in its file, and every excuse still has a file", async () => {
  const names = await browserBackedNames();
  const files = new Set(await testFiles());
  const stale = [];
  for (const [file, excuse] of Object.entries(EXCUSED)) {
    assert.ok(excuse.why.length > 40, `${file}: the reason has to be a sentence somebody can disagree with`);
    if (!files.has(file)) { stale.push(`${file} (gone)`); continue; }
    const sites = callsitesIn(await readFile(join(ROOT, file), "utf8"), names);
    for (const line of excuse.callsites)
      if (!sites.includes(line)) stale.push(`${file}: excused a line that is no longer there — ${line.slice(0, 80)}`);
  }
  assert.deepEqual(stale, [], "These excuses are no longer about anything; take them out.");
});

test("the detector notices every way one of these tools can be made to run", async () => {
  const names = await browserBackedNames();
  assert.ok(names.includes("browser.pdf") && names.includes("browser.act") && names.includes("computer.look"),
    `the names come from the product, so they include the ones nobody thought to list (${names.length} of them)`);
  const seen = (source) => callsitesIn(source, names).length;

  assert.equal(seen('await registry.execute("browser.pdf", {}, context);'), 1, "through the registry");
  assert.equal(seen('await app.runtime.executeTool("browser.act", { what: "buy" }, context);'), 1, "through the runtime");
  assert.equal(seen('calls({ id: "c1", name: "browser.act", arguments: "{}" })'), 1, "as a tool call a model makes");
  assert.equal(seen('await registry.execute("computer.look", { at: "page" }, context);'), 1, "a page-targeted computer tool");
  assert.equal(seen("await browser.pdf(context);"), 1, "straight at a browser object");
  assert.equal(seen('const note = "the browser.pdf tool writes a file";'), 0, "but prose about a tool is not a call");
});

test("the files this was written for are in the group that gets a browser", async () => {
  const inBrowserGroup = new Set(testGroups().browser.map(slash));
  for (const file of ["tests/browser-more.test.mjs", "tests/comfort.test.mjs", "tests/comfort-review.test.mjs"])
    assert.ok(inBrowserGroup.has(file), `${file} runs browser-backed tools and must be in the group that gets one`);
});
