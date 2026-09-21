import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

/*
 * A test that starts the app without saying which port listens on the default one, 3210. That is the
 * port the owner's own Branch Agent holds on this computer, so such a test fails there with
 * EADDRINUSE (tests/memory-context.test.mjs did), and on any other machine it would collide with the
 * next test to do the same. `port: 0` asks the system for a free one.
 *
 * The calls are found by parsing, not by pattern: a callback inside the options (`quit: () => {
 * quits++; }`) holds semicolons, and a pattern that stopped at the first one lost the whole call.
 */
const dir = import.meta.dirname;

/** Line numbers of `startServer(...)` calls in `source` whose options do not visibly name a port. */
function portless(source, name = "test.mjs") {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  const names = (options) => options.properties.some((property) =>
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name.getText(file) === "port");
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "startServer") {
      const options = node.arguments[1];
      // Options built elsewhere cannot be read from here, so they count as not naming a port.
      if (!options || !ts.isObjectLiteralExpression(options) || !names(options))
        found.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

test("the guard finds a portless call whatever its options hold, and accepts one that names a port", () => {
  const caught = [
    "const s = await startServer(app);",
    "const s = await startServer(app, { dataDir });",
    "const s = await startServer(app, { dataDir, quit: () => { quits++; } });",
    "const s = await startServer(app, {\n  dataDir: join(root, 'data'),\n  onReady() { ready = true; },\n});",
    "const s = await startServer(app, options);",
    "const s = await startServer(app, { ...options });",
    "const s = await startServer(app, { dataDir, note: 'port: 0' });",
  ];
  for (const source of caught) assert.deepEqual(portless(source), [1], `missed: ${source}`);
  const allowed = [
    "const s = await startServer(app, { dataDir, port: 0 });",
    "const s = await startServer(app, { dataDir, quit: () => { quits++; }, port: 0 });",
    "const s = await startServer(app, {\n  dataDir: join(root, 'data'),\n  onReady() { ready = true; },\n  port: 0,\n});",
    "const port = 0; const s = await startServer(app, { dataDir, port });",
    "// startServer(app, { dataDir });\nconst text = 'startServer(app)';",
  ];
  for (const source of allowed) assert.deepEqual(portless(source), [], `wrongly caught: ${source}`);
});

test("every test that starts the app asks for a port of its own", async () => {
  const found = [];
  let calls = 0;
  for (const name of (await readdir(dir)).filter((file) => /\.m?js$/.test(file))) {
    const source = await readFile(join(dir, name), "utf8");
    calls += (source.match(/\bstartServer\(/g) ?? []).length;
    for (const line of portless(source, name)) found.push(`${name}:${line}`);
  }
  assert.ok(calls > 40, `only ${calls} calls were found; the tests moved`);
  assert.deepEqual(found, [], "pass { port: 0 } to startServer so the test never takes the default port");
});
