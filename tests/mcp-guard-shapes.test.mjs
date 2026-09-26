/**
 * The second review of #332 found three launch shapes that still reached code in the workspace past the guard
 * (src/mcp-workspace-guard.ts): a file: URL, inline code that names a workspace path, and a package runner told to take
 * its package from a workspace folder. Each is refused when the server is added, when it is switched on, and (for the
 * shapes that run locally) as Branch starts it again; a workspace folder given as data stays allowed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { launchFingerprint } from "../dist/mcp-own-servers.js";
import { workspaceRefusal } from "../dist/mcp-workspace-guard.js";

const notesServer = resolve("dist/examples/mcp-notes-server.js");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-guardshapes-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), web: { allowPrivateAddresses: true } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  await mkdir(app.runtime.workspace, { recursive: true });
  return { app, root, workspace: app.runtime.workspace, ...server };
}
const api = (url, token, path, body) => fetch(`${url}${path}`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, origin: url, "content-type": "application/json" }, body: JSON.stringify(body),
}).then(async (response) => {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "request failed");
  return data;
});
const toolsOf = (app, id) => app.registry.names().filter((name) => name.startsWith(`mcp.${id}.`));
const stdio = (command, args, cwd) => ({ transport: "stdio", command, args, envKeys: [], ...(cwd ? { cwd } : {}) });

/** A workspace script that leaves a marker if it ever runs, then serves the notes tools so a start would succeed. */
async function plant(workspace, marker) {
  const script = join(workspace, "srv.mjs");
  await writeFile(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`);
  return script;
}

/**
 * Refused at add (nothing saved), and, saved before this check with the owner's yes to this exact launch: refused by the
 * switch (no question asked) and, when `asBranchStarts`, not started as Branch starts.
 */
async function refusedEverywhere({ app, url, token }, probe, said, asBranchStarts) {
  await assert.rejects(api(url, token, "/api/mcp/servers", { name: "Probe", server: probe }), said, "refused when added");
  assert.deepEqual(app.ownMcp.saved(), [], "nothing is saved");
  const entry = { id: "probe", name: "Probe", server: probe, on: asBranchStarts, approved: launchFingerprint(probe), tools: [], version: null, hidden: [], addedAt: new Date().toISOString() };
  app.store.save("settings", app.runtime.owner, "mcp-own-servers", { servers: [entry] });
  if (asBranchStarts) {
    await app.ownMcp.startSaved([]);
    assert.equal(toolsOf(app, "probe").length, 0, "not started as Branch starts");
    assert.equal(app.ownMcp.saved()[0].on, false);
    assert.match(app.ownMcp.list(true).servers[0].error, said);
  }
  await assert.rejects(api(url, token, "/api/mcp/servers/probe/start", {}), said, "refused by the switch");
  assert.equal(app.runtime.approvals.waiting().length, 0, "and no question was asked");
  app.store.save("settings", app.runtime.owner, "mcp-own-servers", { servers: [] });
}

/* Shape 1. Mutation: in asPath (src/mcp-workspace-guard.ts), drop the file: branch so every text is `resolve(cwd, text)`;
   the add is then accepted and, as Branch starts, the workspace script runs and writes the marker. */
test("a workspace file named by a file: URL is refused, as --import <url> and --import=<url>", async (t) => {
  const f = await fixture(t);
  const marker = join(f.root, "file-url-ran.txt"), url = pathToFileURL(await plant(f.workspace, marker)).href;
  await refusedEverywhere(f, stdio(process.execPath, ["--import", url, notesServer]), /srv\.mjs, a file inside the workspace/, true);
  await refusedEverywhere(f, stdio(process.execPath, [`--import=${url}`, notesServer]), /srv\.mjs, a file inside the workspace/, true);
  assert.equal(existsSync(marker), false, "the workspace script never ran");
});

/* Shape 2. Mutation: delete the `inlineCode(name, args).some(names)` line in argumentRefusal; node's -e then imports the
   workspace script as Branch starts (the marker is written) and the python launch is saved. */
test("inline code that names a workspace path is refused: node -e / --eval / -p, python -c", async (t) => {
  const f = await fixture(t);
  const marker = join(f.root, "inline-ran.txt"), script = await plant(f.workspace, marker);
  const load = `import(${JSON.stringify(pathToFileURL(script).href)}).then(() => import(${JSON.stringify(pathToFileURL(notesServer).href)}))`;
  const said = /code that names a place inside the workspace/;
  await refusedEverywhere(f, stdio(process.execPath, ["-e", load]), said, true);
  await refusedEverywhere(f, stdio(process.execPath, [`--eval=${load}`]), said, true);
  assert.equal(existsSync(marker), false, "the workspace script never ran");
  // Written with the other slash and case, and relative to the folder it starts in.
  const other = process.platform === "win32" ? script.replace(/\\/g, "/").toUpperCase() : script;
  await refusedEverywhere(f, stdio("node", ["-p", `require(${JSON.stringify(other)})`]), said, false);
  await refusedEverywhere(f, stdio("node", ["-e", "import('./workspace/srv.mjs')"], f.root), said, false);
  await refusedEverywhere(f, stdio("python", ["-c", `exec(open(${JSON.stringify(script)}).read())`]), said, false);
});

/* Shape 3. Mutation: delete the `packageSources(name, args).some(names)` line in argumentRefusal; every one of these is
   then saved. Checked by the refusal only: nothing here is started, so no package is fetched. */
test("a package runner told to take its package from a workspace folder is refused", async (t) => {
  const f = await fixture(t);
  const pkg = join(f.workspace, "pkg");
  await mkdir(pkg);
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "srv", bin: "index.js" }));
  const said = /take its package from inside the workspace/;
  for (const probe of [
    stdio("npx", [`--package=${pkg}`, "srv"]),
    stdio("npx", ["srv", "--prefix", pkg]),
    stdio("uvx", [`--from=${pkg}`, "srv"]),
    stdio("uv", ["run", "--with", pkg, "srv"]),
    stdio("pip", ["install", "-e", pkg]),
    stdio("pip", ["install", `--editable=${pkg}`]),
    stdio("cmd", ["/c", "npx", `--package=${pkg}`, "srv"]),
  ]) await refusedEverywhere(f, probe, said, false);
});

/* Data, not code. Mutation: make argumentRefusal run `names` over every argument (not only code and package sources)
   and this goes red. */
test("a workspace folder given as data is still allowed", async (t) => {
  const { app, url, token, workspace } = await fixture(t);
  const add = (server) => api(url, token, "/api/mcp/servers", { name: "Data", server });
  const saved = await add(stdio(process.execPath, [notesServer, workspace]));
  assert.equal(saved.server.on, false, "saved, off until the owner's yes");
  await add(stdio(process.execPath, [notesServer, `--root=${pathToFileURL(workspace).href}`]));
  for (const server of [
    stdio("npx", ["-y", "@modelcontextprotocol/server-filesystem", workspace]),
    stdio("cmd", ["/c", "npx", "-y", "@modelcontextprotocol/server-filesystem", workspace]),
    stdio("python", ["-c", "import sys; print(sys.argv)", workspace]),
    stdio("uvx", ["--from", "mcp-server-git==1.0", "mcp-server-git", "--repository", workspace]),
  ]) assert.equal(workspaceRefusal(server, workspace, process.env), null, `${server.command} ${server.args.join(" ")}`);
});
