import test from "node:test";
import assert from "node:assert/strict";
import { tagSource, blankNoise } from "../dist/code-tags.js";
import { pageRank, rankDeclarations, fitOutline, outlineTokens } from "../dist/code-rank.js";
import { typeScriptValidation, bracketProblems } from "../dist/code-syntax.js";
import { RepositoryContextProvider } from "../dist/context-providers.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";

/** A whole app on a throwaway workspace, closed before its folder is removed. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-repo-map-"));
  const workspace = join(root, "workspace"), dataDir = join(root, "private");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ workspace, dataDir });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, workspace };
}
const put = async (workspace, path, content) => {
  await mkdir(join(workspace, path, ".."), { recursive: true });
  await writeFile(join(workspace, path), content);
};

const names = (scan) => scan.defs.map((def) => def.name);
const tagged = (path, text) => ({ path, ...tagSource(path, text) });

test("A0537 the reader skips names inside comments and strings and knows what each declaration sits in", () => {
  const ts = [
    "// export class Fake {}",
    "export class Invoice {",
    "  private total = 0;",
    "  async addLine(amount: number): Promise<void> {",
    "    const note = \"function notReal() {}\";",
    "    if (amount > 0) { this.total += amount; }",
    "  }",
    "}",
    "/* export function hidden() {} */",
    "export function makeInvoice(",
    "  id: string,",
    "): Invoice { return new Invoice(); }",
  ].join("\n");
  const scan = tagSource("src/invoice.ts", ts);
  assert.deepEqual(names(scan), ["Invoice", "addLine", "makeInvoice"]);
  assert.equal(scan.defs[1].parent, 0, "the method sits inside the class");
  assert.equal(scan.defs[2].parent, -1, "the function after the class is at the top again");
  assert.equal(scan.defs[2].line, 10);
  assert.equal(scan.refs.has("notReal") || scan.refs.has("Fake") || scan.refs.has("hidden"), false);
  assert.equal(scan.refs.get("Invoice"), 3, "every use outside comments and strings is counted");

  const py = tagSource("tool.py", 'class Robot:\n    """def fake(): pass"""\n    def go(self):\n        # def nope(): pass\n        pass\ndef main():\n    pass\n');
  assert.deepEqual(names(py), ["Robot", "go", "main"]);
  assert.deepEqual(py.defs.map((def) => def.parent), [-1, 0, -1]);

  const rust = tagSource("lib.rs", "pub struct Engine<'a> { name: &'a str }\nimpl<'a> Engine<'a> {\n    pub fn drive(&self) -> char { 'x' }\n}\n");
  assert.deepEqual(names(rust), ["Engine", "Engine", "drive"], "a lifetime does not open a string");
  assert.equal(rust.defs[2].parent, 1, "a method belongs to its impl block");

  assert.deepEqual(names(tagSource("Thing.java", "public class Thing {\n  void run() { if (x) { go(); } }\n  public static int count(int a) {\n    return a;\n  }\n}\n")), ["Thing", "run", "count"]);
  assert.deepEqual(names(tagSource("add.c", "#define MAX 3\nstruct point { int x; };\nstatic int add(int a, int b) {\n  return a + b;\n}\n")), ["MAX", "point", "add"]);
  assert.deepEqual(names(tagSource("app.rb", "module Shop\n  class Cart\n    def total?\n    end\n  end\nend\n")), ["Shop", "Cart", "total?"]);
  assert.deepEqual(names(tagSource("Main.kt", "class Box {\n  fun open(): Int { return 1 }\n}\nfun main() {}\n")), ["Box", "open", "main"]);
  assert.deepEqual(names(tagSource("notes.md", "# Title\n```\n# not a heading\n```\n## Second\n")), ["Title", "Second"]);
});

test("A0537 blanking keeps every line where it was", () => {
  const text = "a = 1 # note\nb = '''x\ny'''\nc = 2\n";
  const clean = blankNoise(text, "hash");
  assert.equal(clean.length, text.length);
  assert.equal(clean.split("\n").length, text.split("\n").length);
  assert.match(clean.split("\n")[3], /^c = 2/);
});

test("A0334 PageRank follows uses to declarations and starts from what the request is about", () => {
  const edges = [
    { from: "a", to: "b", weight: 1, name: "x" },
    { from: "b", to: "c", weight: 1, name: "y" },
    { from: "d", to: "d", weight: 0.1, name: "z" },
  ];
  const plain = pageRank(["a", "b", "c", "d"], edges);
  assert.ok(plain.get("c") > plain.get("b") && plain.get("b") > plain.get("a"), "rank collects downstream");
  const total = [...plain.values()].reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, "ranks add up to one");
  const personal = pageRank(["a", "b", "c", "d"], edges, new Map([["a", 1]]));
  assert.equal(personal.get("d"), 0, "a file nothing leads to stays at zero");
  assert.ok(personal.get("a") > 0);
});

test("A0334 declarations are ordered by who uses them, with Aider's weights", () => {
  const files = [
    tagged("src/billing.ts", "export function computeInvoiceTotal() { return 1; }\nexport function helper() { return 2; }\nexport function _private() {}\n"),
    tagged("src/checkout.ts", "import { computeInvoiceTotal } from './billing.js';\nexport function checkout() { return computeInvoiceTotal() + computeInvoiceTotal(); }\n"),
    tagged("src/report.ts", "import { helper } from './billing.js';\nexport function report() { return helper(); }\n"),
    tagged("src/weather.ts", "export const weather = 2;\n"),
  ];
  const ranking = rankDeclarations(files);
  const order = ranking.entries.filter((entry) => entry.def).map((entry) => entry.def.name);
  assert.equal(order[0], "computeInvoiceTotal", "a long, used, camel-case name outranks a short one");
  assert.ok(order.indexOf("helper") < order.indexOf("_private"), "an unused leading-underscore name comes late");

  const focused = rankDeclarations(files, { focus: new Set(["src/report.ts"]), mentioned: new Set(["helper"]) });
  const focusedOrder = focused.entries.filter((entry) => entry.def).map((entry) => entry.def.name);
  assert.equal(focusedOrder[0], "helper", "the file in hand and a named declaration steer the order");
  assert.equal(focused.entries.some((entry) => entry.path === "src/report.ts"), false, "the file in hand is not outlined");
});

test("A0334 the outline fits the token budget and shows what each declaration sits inside", () => {
  const files = [];
  for (let index = 0; index < 40; index++) {
    const body = `export class Service${index} {\n  handleRequest${index}() { return shared(); }\n}\n`;
    files.push(tagged(`src/service${index}.ts`, body));
  }
  files.push(tagged("src/shared.ts", "export function shared() { return 1; }\n"));
  const ranking = rankDeclarations(files);
  for (const budget of [120, 400, 1000]) {
    const fitted = fitOutline(ranking.entries, budget);
    assert.ok(fitted.tokens <= budget * 1.15, `outline of ${fitted.tokens} tokens fits ${budget}`);
    assert.ok(fitted.used > 0);
    assert.equal(outlineTokens(fitted.text), fitted.tokens);
  }
  const small = fitOutline(ranking.entries, 400).text;
  assert.match(small, /^src\/shared\.ts:\n(⋮\n)?│export function shared\(\)/m, "the most used declaration is shown");
  const big = fitOutline(ranking.entries, 1000).text;
  assert.match(big, /│export class Service\d+ \{\n│  handleRequest\d+\(\)/, "a method is shown under its class line");
  assert.ok(big.split("\n").every((line) => line.length <= 100));
});

test("A0334 code.map with a token budget gives the ranked outline of the workspace", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "README.md", "# Shop\n");
  await put(workspace, "src/cart.ts", "import { priceOf } from './prices.js';\nexport class ShoppingCart {\n  totalPrice() { return priceOf('a'); }\n}\n");
  await put(workspace, "src/prices.ts", "export function priceOf(item: string) { return 1; }\n");
  await put(workspace, "src/unused.ts", "export function lonelyThing() {}\n");

  const result = await app.runtime.executeTool("code.map", { tokens: 300, request: "how is the shopping cart price worked out" });
  assert.equal(typeof result.outline, "string");
  assert.ok(result.tokens <= 300 * 1.15);
  assert.ok(result.declarations >= 2);
  assert.match(result.outline, /^README\.md$/m, "the files that say what a project is come first");
  assert.match(result.outline, /src\/cart\.ts:\n(⋮\n)?│export class ShoppingCart \{\n│  totalPrice\(\)/);
  assert.match(result.outline, /src\/prices\.ts:\n(⋮\n)?│export function priceOf/);

  const focused = await app.runtime.executeTool("code.map", { tokens: 300, focus: ["src/cart.ts"] });
  assert.doesNotMatch(focused.outline, /ShoppingCart/, "a file already in hand is left out");
  assert.match(focused.outline, /priceOf/);
});

test("A0334 code.map ranking reaches files joined by use, not only by import", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "svc/ledger.go", "package svc\n\nfunc PostLedgerEntry() {}\n");
  await put(workspace, "svc/handler.go", "package svc\n\nfunc Handle() { PostLedgerEntry() }\n");
  await put(workspace, "svc/other.go", "package svc\n\nfunc Other() {}\n");
  const ranked = await app.runtime.executeTool("code.map", { request: "post ledger entry" });
  const paths = ranked.files.map((file) => file.path);
  assert.equal(paths[0], "svc/ledger.go");
  assert.ok(paths.includes("svc/handler.go"), "Go has no import lines to follow, but the use links them");
  assert.equal(paths.includes("svc/other.go"), false);
  assert.equal(ranked.files[0].symbols[0], "PostLedgerEntry");
});

test("A0334 the repository context can put the outline in front of a task", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "src/prices.ts", "export function priceOf(item: string) { return 1; }\n");
  await put(workspace, "src/cart.ts", "import { priceOf } from './prices.js';\nexport const total = priceOf('a');\n");
  const settings = { repositoryContext: true, repositoryContextFiles: 5, repositoryOutlineTokens: 0 };
  const provider = new RepositoryContextProvider(app.projectMap, () => settings);
  const list = await provider.provide("local", "where is priceOf");
  assert.match(list.text, /\[1\] src\/prices\.ts/);
  settings.repositoryOutlineTokens = 500;
  const outline = await provider.provide("local", "where is priceOf");
  assert.match(outline.text, /ranked by who uses whose names/);
  assert.match(outline.text, /│export function priceOf/);
  assert.ok(outline.sources.includes("src/prices.ts"));
  settings.repositoryContext = false;
  assert.equal(await provider.provide("local", "where is priceOf"), null, "off stays off");
});

test("A0537 TypeScript and other languages are checked without the compiler", async (t) => {
  const good = await typeScriptValidation("a.ts", "export function f<T>(x: T): T { return x; }\n");
  assert.deepEqual(good, { path: "a.ts", language: "TypeScript", checked: true, ok: true, problems: [] });
  const bad = await typeScriptValidation("b.ts", "const a: number = 1;\nfunction f(x: string): void {\n");
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0].message, /SyntaxError/);
  assert.equal(bad.problems[0].line, 2, "the unclosed brace names its line");
  const enumFile = await typeScriptValidation("c.ts", "enum Colour { Red }\n");
  assert.equal(enumFile.ok, true);
  assert.match(enumFile.note, /only brackets were checked/);
  const noNode = await typeScriptValidation("d.ts", "const x = 1;\n", async () => "");
  assert.match(noNode.note, /not available/);

  assert.deepEqual(bracketProblems("x.py", "def f(:\n    return ')'\n").map((p) => p.line), [1]);
  assert.deepEqual(bracketProblems("x.go", "func main() {\n  s := \"}\"\n}\n"), [], "a brace inside a string is not counted");
  assert.match(bracketProblems("x.rs", "fn f() { let v = vec![1, 2); }\n")[0].message, /does not close/);

  const { app, workspace } = await fixture(t);
  await put(workspace, "ok.py", "def f(a):\n    return [a]\n");
  await put(workspace, "broken.java", "class A {\n  void f() {\n}\n");
  await put(workspace, "typed.ts", "export const a: number = 1;\n");
  await put(workspace, "broken.ts", "export const a = {;\n");
  assert.equal((await app.runtime.executeTool("files.validate", { path: "ok.py" })).ok, true);
  const java = await app.runtime.executeTool("files.validate", { path: "broken.java" });
  assert.equal(java.ok, false);
  assert.equal(java.problems[0].line, 1);
  assert.equal((await app.runtime.executeTool("files.validate", { path: "typed.ts" })).ok, true);
  assert.equal((await app.runtime.executeTool("files.validate", { path: "broken.ts" })).ok, false);
});
