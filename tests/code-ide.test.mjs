import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createBranch, saveLanguageServerSettings, saveDebugSettings, NetworkPolicy, GitHubAccess, GitLabAccess, registerGitLab } from "../dist/index.js";
import { registerGitHubProject } from "../dist/integrations/git-tools.js";

const here = join(fileURLToPath(import.meta.url), "..");
const fakeLanguageServer = join(here, "fixtures", "fake-language-server.mjs");
const fakeDebugAdapter = join(here, "fixtures", "fake-debug-adapter.mjs");

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

// ---------------------------------------------------------------- language servers

/** An app whose only language server is the stand-in, already switched on. */
async function withLanguageServer(t) {
  const made = await fixture(t);
  await saveLanguageServerSettings(made.app.store, "local", {
    enabled: true,
    servers: { fake: { path: process.execPath, args: [fakeLanguageServer], languages: ["TypeScript"] } },
    timeoutMs: 10000,
  });
  t.after(() => made.app.languageServers.stopAll());
  return made;
}

test("language servers are off until the owner switches them on", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "src/a.ts", "export const total = 1;\n");
  await assert.rejects(
    app.runtime.executeTool("code.hover", { path: "src/a.ts", line: 1, character: 14 }),
    /switched off/,
  );
});

test("a language server reports mistakes, definitions, uses and hover text", async (t) => {
  const { app, workspace } = await withLanguageServer(t);
  await put(workspace, "src/sums.ts", "export const total = 1;\nconsole.log(total);\n");

  const problems = await app.runtime.executeTool("code.diagnostics", { path: "src/sums.ts", waitMs: 400 });
  assert.equal(problems.server, "fake");
  assert.equal(problems.diagnostics.length, 1);
  assert.deepEqual(
    { path: problems.diagnostics[0].path, line: problems.diagnostics[0].line, severity: problems.diagnostics[0].severity },
    { path: "src/sums.ts", line: 2, severity: "error" },
    "the server's 0-based line comes back counted from 1",
  );

  const definition = await app.runtime.executeTool("code.definition", { path: "src/sums.ts", line: 2, character: 13 });
  assert.deepEqual(definition.places, [{ path: "src/sums.ts", line: 1, character: 14, endLine: 1, endCharacter: 19 }]);

  const uses = await app.runtime.executeTool("code.references", { path: "src/sums.ts", line: 1, character: 14 });
  assert.equal(uses.places.length, 2);

  const hover = await app.runtime.executeTool("code.hover", { path: "src/sums.ts", line: 1, character: 14 });
  assert.match(hover.text, /const total: number/);
});

test("a rename lands as one change set across files, and can be shown without writing", async (t) => {
  const { app, workspace } = await withLanguageServer(t);
  await put(workspace, "src/sums.ts", "export const total = 1;\nconsole.log(total);\n");

  const shown = await app.runtime.executeTool("code.rename", { path: "src/sums.ts", line: 1, character: 14, newName: "grandTotal", dryRun: true });
  assert.equal(shown.applied, false);
  assert.equal(shown.dryRun, true);
  assert.equal(shown.reason, "rename to grandTotal");
  assert.equal(await readFile(join(workspace, "src/sums.ts"), "utf8"), "export const total = 1;\nconsole.log(total);\n", "nothing was written");

  const done = await app.runtime.executeTool("code.rename", { path: "src/sums.ts", line: 1, character: 14, newName: "grandTotal" });
  assert.equal(done.applied, true);
  assert.equal(await readFile(join(workspace, "src/sums.ts"), "utf8"), "export const grandTotal = 1;\nconsole.log(grandTotal);\n");

  const kept = await app.runtime.executeTool("files.history", { path: "src/sums.ts" });
  assert.ok(kept.length >= 1, "the previous bytes were kept, so the rename can be put back");
});

test("code.rename asks before it writes, the way every multi-file change does", async (t) => {
  const { app } = await withLanguageServer(t);
  const rename = app.registry.inventory().find((tool) => tool.name === "code.rename");
  assert.equal(rename.permission, "files.write", "it counts as a change, so the ask-before-changes policy covers it");
  const target = app.registry.targetOf("code.rename", { path: "src/sums.ts", line: 1, character: 14, newName: "x", dryRun: false }, app.runtime.context({}));
  assert.match(target, /rename to x/, "the person is told what the change is before it happens");
});

// ---------------------------------------------------------------- debugging

async function withDebugAdapter(t) {
  const made = await fixture(t);
  await saveDebugSettings(made.app.store, "local", {
    enabled: true,
    adapters: { fake: { path: process.execPath, args: [fakeDebugAdapter], launch: {} } },
    timeoutMs: 10000,
  });
  t.after(() => made.app.debugAdapters.stopAll());
  return made;
}

test("debugging is off until the owner switches it on", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "run.js", "console.log(1);\n");
  await assert.rejects(
    app.runtime.executeTool("debug.start", { adapter: "fake", program: "run.js" }),
    /switched off/,
  );
});

test("a debugger launches with breakpoints, steps, shows the names in view and stops", async (t) => {
  const { app, workspace } = await withDebugAdapter(t);
  await put(workspace, "run.js", "const total = 42;\nconst name = 'ada';\nconsole.log(total, name);\n");

  const started = await app.runtime.executeTool("debug.start", {
    adapter: "fake", program: "run.js", breakpoints: [{ path: "run.js", lines: [3] }], waitMs: 3000,
  });
  assert.equal(started.running, true);
  assert.equal(started.stopped.reason, "breakpoint");
  assert.equal(started.stopped.line, 4);
  assert.match(started.output, /the program started/);

  const names = await app.runtime.executeTool("debug.variables", {});
  assert.equal(names.frame, "main");
  assert.deepEqual(names.variables.map((entry) => entry.name), ["total", "name"]);
  assert.equal(names.variables[0].value, "42");

  const stepped = await app.runtime.executeTool("debug.step", { kind: "over", waitMs: 3000 });
  assert.equal(stepped.stopped.line, 5, "the line moved on");

  const ended = await app.runtime.executeTool("debug.stop", {});
  assert.equal(ended.action, "stopped");
  await assert.rejects(app.runtime.executeTool("debug.variables", {}), /Nothing is being debugged/);
});

// ---------------------------------------------------------------- GitHub and GitLab reading

/** A stand-in for the two APIs, so no real token or network is involved. */
async function fakeApi(t, routes) {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ path: request.url, auth: request.headers.authorization ?? "", token: request.headers["private-token"] ?? "" });
    const body = routes[request.url.split("?")[0]];
    response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(body ?? { message: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

test("GitHub checks and releases come back in plain words, with the token only in the header", async (t) => {
  const { app } = await fixture(t);
  const api = await fakeApi(t, {
    "/repos/me/thing/commits/main/check-runs": {
      check_runs: [
        { name: "tests", status: "completed", conclusion: "success", details_url: "https://example.invalid/1" },
        { name: "lint", status: "completed", conclusion: "failure", details_url: "https://example.invalid/2" },
      ],
    },
    "/repos/me/thing/releases": [{ tag_name: "v1.2.0", name: "Winter", published_at: "2026-01-02T00:00:00Z", body: "notes", html_url: "https://example.invalid/r" }],
  });
  const policy = new NetworkPolicy({ allowPrivateAddresses: true });
  const github = new GitHubAccess({ apiBase: api.base }, policy, async () => "ghp_fake_token_aaa");
  registerGitHubProject(app.registry, github);

  const checks = await app.runtime.executeTool("github.checks", { repo: "me/thing", ref: "main" });
  assert.equal(checks.allPassed, false);
  assert.match(checks.summary, /1 of 2 checks did not pass: lint/);

  const releases = await app.runtime.executeTool("github.release", { repo: "me/thing" });
  assert.equal(releases.releases[0].tag, "v1.2.0");

  assert.ok(api.seen.every((call) => call.auth === "Bearer ghp_fake_token_aaa"), "the token travelled in the header");
  assert.ok(api.seen.every((call) => !call.path.includes("ghp_")), "and never in the address");
});

test("GitLab issues, releases and pipelines read through the same network rules", async (t) => {
  const { app } = await fixture(t);
  const api = await fakeApi(t, {
    "/projects/group%2Fthing/issues": [{ iid: 4, title: "a bug", state: "opened", web_url: "https://example.invalid/i", created_at: "2026-02-01T00:00:00Z" }],
    "/projects/group%2Fthing/releases": [{ tag_name: "v0.3", name: "Spring", released_at: "2026-02-02T00:00:00Z", description: "notes" }],
    "/projects/group%2Fthing/pipelines": [{ id: 9, ref: "main", status: "success", web_url: "https://example.invalid/p", updated_at: "2026-02-03T00:00:00Z" }],
  });
  const policy = new NetworkPolicy({ allowPrivateAddresses: true });
  registerGitLab(app.registry, new GitLabAccess({ apiBase: api.base }, policy, async () => "glpat_fake_bbb"));

  const issues = await app.runtime.executeTool("gitlab.issues", { project: "group/thing" });
  assert.deepEqual(issues.issues.map((issue) => issue.number), [4]);
  const releases = await app.runtime.executeTool("gitlab.releases", { project: "group/thing" });
  assert.equal(releases.releases[0].tag, "v0.3");
  const pipelines = await app.runtime.executeTool("gitlab.pipelines", { project: "group/thing" });
  assert.match(pipelines.summary, /passed/);
  assert.ok(api.seen.every((call) => call.token === "glpat_fake_bbb"));
  assert.equal(app.registry.groupOf("gitlab.issues"), "git", "it files under version control, not the unrecognised box");
});

test("a GitLab address outside the allowed list is refused before anything is sent", async (t) => {
  const { app } = await fixture(t);
  const policy = new NetworkPolicy({ allowedHosts: ["gitlab.com"] });
  registerGitLab(app.registry, new GitLabAccess({ apiBase: "https://elsewhere.invalid/api/v4" }, policy, async () => "glpat_fake_bbb"));
  await assert.rejects(app.runtime.executeTool("gitlab.issues", { project: "group/thing" }), /not on the allowed list/);
});

// ---------------------------------------------------------------- checkpoints, undo, redo

/** A run inside a real conversation, so undo and redo have a conversation to work on. */
function conversation(app, prompt = "changing files") {
  const run = app.store.createRun("local", prompt);
  return { runId: run.id, sessionId: run.sessionId, context: app.runtime.context({ runId: run.id }) };
}

test("a checkpoint keeps the exact bytes of what changed, and puts them all back", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "notes.txt", "first\n");
  const { runId, context } = conversation(app);

  await app.registry.execute("files.write", { path: "notes.txt", content: "second\n" }, context);
  const point = await app.registry.execute("workspace.checkpoint", { label: "after the second draft" }, context);
  assert.equal(point.label, "after the second draft");
  assert.equal(point.files, 1, "only the file that changed is in the point");

  await app.registry.execute("files.write", { path: "notes.txt", content: "third\n" }, context);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "third\n");

  const points = await app.registry.execute("workspace.points", {}, context);
  assert.ok(points.points.some((entry) => entry.id === point.id));

  const back = await app.registry.execute("workspace.restore_point", { id: point.id }, context);
  assert.equal(back.restored, 1);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "second\n", "the exact bytes came back");
  assert.ok(runId);
});

test("a checkpoint refuses when nothing has been changed yet", async (t) => {
  const { app } = await fixture(t);
  const { context } = conversation(app);
  await assert.rejects(app.registry.execute("workspace.checkpoint", { label: "empty" }, context), /Nothing has been changed/);
});

test("undo and redo walk back and forward through this conversation's changes", async (t) => {
  const { app, workspace } = await fixture(t);
  await put(workspace, "song.txt", "one\n");
  const { context } = conversation(app);
  const read = () => readFile(join(workspace, "song.txt"), "utf8");

  await app.registry.execute("files.write", { path: "song.txt", content: "two\n" }, context);
  await app.registry.execute("files.write", { path: "song.txt", content: "three\n" }, context);
  assert.equal(await read(), "three\n");

  const preview = await app.registry.execute("workspace.undo", { preview: true }, context);
  assert.equal(preview.change.path, "song.txt");
  assert.match(preview.change.diff, /-three/);
  assert.equal(await read(), "three\n", "a preview changes nothing");

  await app.registry.execute("workspace.undo", {}, context);
  assert.equal(await read(), "two\n");
  await app.registry.execute("workspace.undo", {}, context);
  assert.equal(await read(), "one\n", "the second undo goes back another step");

  await app.registry.execute("workspace.redo", {}, context);
  assert.equal(await read(), "two\n", "redo puts the undone change forward again");
  await app.registry.execute("workspace.redo", {}, context);
  assert.equal(await read(), "three\n");

  await assert.rejects(app.registry.execute("workspace.redo", {}, context), /nothing to put back/);
});

test("undo leaves another conversation's changes alone", async (t) => {
  const { app, workspace } = await fixture(t);
  const mine = conversation(app, "mine"), theirs = conversation(app, "theirs");
  await app.registry.execute("files.write", { path: "mine.txt", content: "a\n" }, mine.context);
  await app.registry.execute("files.write", { path: "theirs.txt", content: "b\n" }, theirs.context);

  const plan = await app.registry.execute("workspace.undo", { preview: true }, mine.context);
  assert.equal(plan.change.path, "mine.txt");
  await app.registry.execute("workspace.undo", {}, mine.context);
  assert.equal(await readFile(join(workspace, "theirs.txt"), "utf8"), "b\n", "the other conversation is untouched");
  await assert.rejects(app.registry.execute("workspace.undo", {}, mine.context), /nothing to undo/);
});

test("a build output is kept version by version with its checksum", async (t) => {
  const { app, workspace } = await fixture(t);
  await writeFile(join(workspace, "app.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));
  const { context } = conversation(app);

  const first = await app.registry.execute("artifacts.keep", { path: "app.zip", name: "nightly", note: "first build" }, context);
  assert.equal(first.version, 1);
  assert.equal(first.bytes, 6);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);

  await writeFile(join(workspace, "app.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x02, 0x03]));
  const second = await app.registry.execute("artifacts.keep", { path: "app.zip", name: "nightly", note: "second build" }, context);
  assert.equal(second.version, 2);
  assert.notEqual(second.sha256, first.sha256, "a different build has a different checksum");

  const all = await app.registry.execute("artifacts.list", { name: "nightly" }, context);
  assert.deepEqual(all.versions.map((entry) => entry.version), [2, 1], "newest first");
  assert.equal(all.versions[0].note, "second build");

  const newest = await app.registry.execute("artifacts.list", {}, context);
  assert.deepEqual(newest.versions.map((entry) => `${entry.name}@${entry.version}`), ["nightly@2"]);

  const bytes = await app.keptArtifacts.read("nightly", 1);
  assert.equal(bytes.length, 6, "the first version is still there, byte for byte");
});

test("keeping a file that is not in the workspace is refused", async (t) => {
  const { app } = await fixture(t);
  const { context } = conversation(app);
  await assert.rejects(app.registry.execute("artifacts.keep", { path: "nowhere.zip", name: "x" }, context), /no file at that path/);
});

test("only one debugging session runs at a time", async (t) => {
  const { app, workspace } = await withDebugAdapter(t);
  await put(workspace, "run.js", "console.log(1);\n");
  await app.runtime.executeTool("debug.start", { adapter: "fake", program: "run.js", waitMs: 1000 });
  await assert.rejects(
    app.runtime.executeTool("debug.start", { adapter: "fake", program: "run.js", waitMs: 100 }),
    /already going/,
  );
});
