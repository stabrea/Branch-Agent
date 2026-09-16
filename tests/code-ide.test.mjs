import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";

/** A whole app on a throwaway workspace; everything it started is closed in t.after. */
export async function fixture(t, options = {}) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-code-ide-"));
  const workspace = join(root, "workspace"), dataDir = join(root, "private");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ workspace, dataDir, ...options });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, workspace, root };
}
export const put = async (workspace, path, content) => {
  await mkdir(join(workspace, path, ".."), { recursive: true });
  await writeFile(join(workspace, path), content);
};

test("code.map finds the names declared in four languages and the files they pull in", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "src/server.ts", "import { helper } from './helper.js';\nexport class HttpServer {}\nexport const port = 8080;\n");
  await put(workspace, "src/helper.ts", "export function helper() { return 1; }\n");
  await put(workspace, "svc/main.go", "package main\n\ntype Listener struct{}\n\nfunc Serve() {}\n");
  await put(workspace, "engine/lib.rs", "pub struct Engine;\n\npub fn drive() {}\n");
  await put(workspace, "app/Thing.java", "public class Thing {}\n");
  await put(workspace, "app/Other.cs", "public sealed class Other {}\n");
  await put(workspace, "tools/run.py", "from .shared import thing\n\nclass Runner:\n    def go(self):\n        pass\n");
  await put(workspace, "tools/shared.py", "thing = 1\n");
  await put(workspace, "README.md", "# Title\n## Second\n");

  const map = await app.runtime.executeTool("code.map", {});
  const byPath = new Map(map.files.map((file) => [file.path, file]));

  assert.deepEqual(byPath.get("src/server.ts").symbols.map((s) => s.name).sort(), ["HttpServer", "port"]);
  assert.equal(byPath.get("src/server.ts").language, "TypeScript");
  assert.deepEqual(byPath.get("svc/main.go").symbols.map((s) => s.name).sort(), ["Listener", "Serve"]);
  assert.deepEqual(byPath.get("engine/lib.rs").symbols.map((s) => s.name).sort(), ["Engine", "drive"]);
  assert.deepEqual(byPath.get("app/Thing.java").symbols.map((s) => s.name), ["Thing"]);
  assert.deepEqual(byPath.get("app/Other.cs").symbols.map((s) => s.name), ["Other"]);
  assert.deepEqual(byPath.get("tools/run.py").symbols.map((s) => s.name).sort(), ["Runner", "go"]);
  assert.deepEqual(byPath.get("README.md").symbols.map((s) => s.name), ["Title", "Second"]);

  assert.deepEqual(byPath.get("src/server.ts").imports, ["src/helper.ts"], "a ./x.js import resolves to the .ts file");
  assert.deepEqual(byPath.get("tools/run.py").imports, ["tools/shared.py"], "a relative python import resolves");
  assert.equal(byPath.get("engine/lib.rs").imports.length, 0, "only TypeScript, JavaScript and Python are followed");
});

test("code.map re-reads only the files that changed", async (t) => {
  const { app, workspace } = await fixture(t);
  for (let index = 0; index < 5; index++)
    await put(workspace, `src/file${index}.ts`, `export const value${index} = ${index};\n`);

  const first = await app.runtime.executeTool("code.map", {});
  assert.equal(first.scanned, 5);
  assert.equal(first.cached, 0);

  const second = await app.runtime.executeTool("code.map", {});
  assert.equal(second.scanned, 0, "nothing changed, so nothing was read again");
  assert.equal(second.cached, 5);

  await new Promise((resolve) => setTimeout(resolve, 15));
  await put(workspace, "src/file2.ts", "export const value2 = 2;\nexport class Added {}\n");
  const third = await app.runtime.executeTool("code.map", {});
  assert.equal(third.scanned, 1, "only the changed file was read again");
  assert.equal(third.cached, 4);
  const changed = third.files.find((file) => file.path === "src/file2.ts");
  assert.ok(changed.symbols.some((symbol) => symbol.name === "Added"), "the new name is in the map");

  await rm(join(workspace, "src/file0.ts"));
  const fourth = await app.runtime.executeTool("code.map", {});
  assert.equal(fourth.files.length, 4, "a deleted file leaves the map");
});

test("code.map with a request puts the connected files first", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "src/invoice-total.ts", "export function invoiceTotal() { return 0; }\n");
  await put(workspace, "src/checkout.ts", "import { invoiceTotal } from './invoice-total.js';\nexport const checkout = 1;\n");
  await put(workspace, "src/unrelated.ts", "export const weather = 2;\n");

  const ranked = await app.runtime.executeTool("code.map", { request: "where is the invoice total worked out" });
  const paths = ranked.files.map((file) => file.path);
  assert.equal(paths[0], "src/invoice-total.ts", "the file whose name matches comes first");
  assert.ok(paths.includes("src/checkout.ts"), "the file that pulls it in is lifted with it");
  assert.equal(paths.includes("src/unrelated.ts"), false, "a file matching nothing stays out");
  assert.match(ranked.files[1].why, /connected/);
});

test("code.map skips what .branchignore hides", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "src/kept.ts", "export const kept = 1;\n");
  await put(workspace, "secretplans/hidden.ts", "export const hidden = 2;\n");
  await put(workspace, ".branchignore", "secretplans/\n");

  const map = await app.runtime.executeTool("code.map", {});
  const paths = map.files.map((file) => file.path);
  assert.ok(paths.includes("src/kept.ts"));
  assert.equal(paths.includes("secretplans/hidden.ts"), false, "the ignore rule keeps it out of the map");
});
