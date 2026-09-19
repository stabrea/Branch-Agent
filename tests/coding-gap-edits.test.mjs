import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { applyHunks, parsePatch } from "../dist/patch.js";
import { replaceText } from "../dist/text-replace.js";

/* mac7/coding-gap: the edit tools place a model's change where it belongs, not only where it said. */
const apply = (patch, before) => parsePatch(patch).map((file) => applyHunks(file, before))[0];
const source = "import x from 'y';\n\nfunction add(a, b) {\n  return a - b;\n}\n\nexport { add };\n";

test("a hunk whose line number is wrong is placed by its lines", () => {
  const patch = ["--- a/m.js", "+++ b/m.js", "@@ -40,3 +40,3 @@", " function add(a, b) {", "-  return a - b;", "+  return a + b;", " }", ""].join("\n");
  assert.equal(apply(patch, source), source.replace("a - b", "a + b"));
});

test("wrong declared counts and a header with no numbers still apply", () => {
  const wrongCounts = ["--- a/m.js", "+++ b/m.js", "@@ -3,9 +3,9 @@", "-  return a - b;", "+  return a + b;", ""].join("\n");
  assert.equal(apply(wrongCounts, source), source.replace("a - b", "a + b"));
  const bare = ["--- a/m.js", "+++ b/m.js", "@@", "-  return a - b;", "+  return a + b;"].join("\n");
  assert.equal(apply(bare, source), source.replace("a - b", "a + b"));
});

test("context that differs only in whitespace matches, and the file keeps its own context lines", () => {
  const tabbed = "if (x) {\n\treturn 1;\n}\n";
  const patch = ["--- a/t.js", "+++ b/t.js", "@@ -1,3 +1,3 @@", " if (x) {  ", "-    return 1;", "+\treturn 2;", " }", ""].join("\n");
  assert.equal(apply(patch, tabbed), "if (x) {\n\treturn 2;\n}\n");
});

test("the *** Begin Patch form updates and adds files", () => {
  const patch = [
    "*** Begin Patch", "*** Update File: m.js", "@@ function add(a, b) {", "-  return a - b;", "+  return a + b;",
    "*** Add File: new.js", "+export const one = 1;", "*** End Patch",
  ].join("\n");
  const files = parsePatch(patch);
  assert.deepEqual(files.map((file) => [file.path, file.created]), [["m.js", false], ["new.js", true]]);
  assert.equal(applyHunks(files[0], source), source.replace("a - b", "a + b"));
  assert.equal(applyHunks(files[1], null), "export const one = 1;\n");
});

test("lines that are nowhere in the file are still refused, and the refusal says what to do", () => {
  const patch = ["--- a/m.js", "+++ b/m.js", "@@ -1,1 +1,1 @@", "-this is not in the file", "+x", ""].join("\n");
  assert.throws(() => apply(patch, source), /does not match the file at line 1; nothing was changed\. .*Read the file again/);
});

test("replaceText: exact first, then trailing whitespace, then indentation (re-indented)", () => {
  assert.deepEqual(replaceText("a = 1\n", "a = 1", "a = 2", 1, "x"), { after: "a = 2\n", found: 1, tolerant: null });
  assert.equal(replaceText("a = 1   \nb\n", "a = 1\nb", "a = 2\nb", 1, "x").after, "a = 2\nb\n");
  const nested = "class A {\n    run() {\n        go();\n    }\n}\n";
  const result = replaceText(nested, "run() {\n    go();\n}", "run() {\n    stop();\n}", 1, "x");
  assert.equal(result.tolerant, "indentation");
  assert.equal(result.after, "class A {\n    run() {\n        stop();\n    }\n}\n");
});

test("replaceText refusals say how many there are, or show the closest line", () => {
  assert.throws(() => replaceText("v = 1\nv = 1\n", "v = 1", "v = 2", 1, "Edit refused: \"c\""),
    /contains that text 2 time\(s\), but 1 was expected\. Include more of the surrounding lines.*expectedOccurrences to 2/);
  assert.throws(() => replaceText("const total = items.length;\n", "const total = item.length;", "x", 1, "Edit refused: \"c\""),
    /0 time\(s\).*closest line is 1: "const total = items.length;"/);
  assert.equal(replaceText("v = 1\nv = 1\n", "v = 1", "v = 2", "all", "x").after, "v = 2\nv = 2\n");
});

test("files.edit takes other agents' argument names and replaceAll, through the real tool", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-coding-gap-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ dataDir: join(root, "data"), workspace });
  t.after(async () => { await app.close(); await discardTemp(root); });
  await writeFile(join(workspace, "c.txt"), "n = 1\nn = 1\n");
  await app.runtime.executeTool("files.edit", { file_path: "c.txt", old_string: "n = 1", new_string: "n = 2", replace_all: true });
  assert.equal(await readFile(join(workspace, "c.txt"), "utf8"), "n = 2\nn = 2\n");
  await writeFile(join(workspace, "d.js"), "function f() {\n\treturn 1;\n}\n");
  const change = await app.runtime.executeTool("files.edit", { path: "d.js", find: "function f() {\n    return 1;\n}", replace: "function f() {\n    return 2;\n}" });
  assert.equal(change.matched, "ignoring indentation");
  assert.equal(await readFile(join(workspace, "d.js"), "utf8"), "function f() {\n\treturn 2;\n}\n");
});

test("a task's deadline is the caller's when given, so a longer --timeout really is longer", async (t) => {
  const { runDeadline } = await import("../dist/runtime.js");
  assert.equal(runDeadline(undefined), 120000);
  assert.equal(runDeadline(600000), 600000, "ten minutes asked, ten minutes given — not capped at two");
  assert.equal(runDeadline(10 ** 12), 24 * 60 * 60 * 1000);
  const root = await mkdtemp(join(tmpdir(), "branch-coding-gap-"));
  const slow = { name: "scripted", async complete(request) {
    await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 300); request.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(request.signal.reason); }); });
    return { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider: slow });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const cut = await app.runtime.run({ prompt: "hi", timeoutMs: 50 });
  assert.equal(cut.status, "cancelled", "the run's own deadline comes from timeoutMs");
  const whole = await app.runtime.run({ prompt: "hi", timeoutMs: 5000 });
  assert.equal(whole.status, "completed");
});

test("a reply that is all thinking is nudged to act, twice at most, before the task counts as empty", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-coding-gap-"));
  let calls = 0;
  const seen = [];
  const thinker = (answerOn) => ({ name: "scripted", async complete(request) {
    calls++;
    seen.push(request.messages.at(-1)?.content ?? "");
    return { content: calls === answerOn ? "Done." : "", toolCalls: [] };
  } });
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider: thinker(2) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "fix it" });
  assert.equal(run.status, "completed");
  assert.equal(calls, 2);
  assert.match(seen[1], /thinking but no answer and no tool call/);
  assert.equal(app.runtime.store.events(run.id).filter((e) => e.kind === "model.empty_reply").length, 1);

  const root2 = await mkdtemp(join(tmpdir(), "branch-coding-gap-"));
  calls = 0;
  const never = await createBranch({ dataDir: join(root2, "data"), workspace: join(root2, "w"), provider: thinker(99) });
  t.after(async () => { await never.close(); await discardTemp(root2); });
  const empty = await never.runtime.run({ prompt: "fix it" });
  assert.equal(empty.status, "failed", "still judged to have produced nothing");
  assert.equal(calls, 3, "one reply and two nudges, no more");
});
