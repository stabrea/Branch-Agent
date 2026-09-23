import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, gitPatchKind } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { GitRunner, locateGit } from "../dist/integrations/git-run.js";
import { readGitStatus, readGitDiff } from "../dist/collab-git-status.js";

const installed = await locateGit();
const needsGit = { skip: installed ? false : "Git is not installed on this computer" };

/**
 * A repository (a Branch project) whose folder is a real, on-disk Git repository, so the reader
 * this test proves is exercised against Git itself, not a stand-in. Owner-facing: what the window
 * calls is GET /api/collab/git-status?repository=… followed by POST /api/collab/git-patches — the
 * same two calls the new "Git activity" panel makes (public/collab-git.js).
 */
async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-collab-git-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "private") });
  t.after(async () => { await app.close().catch(() => undefined); await discardTemp(root).catch(() => undefined); });
  const owner = app.runtime.owner;
  const folder = join(app.runtime.workspace, "garden-app");
  await mkdir(folder, { recursive: true });
  const runner = new GitRunner();
  const run = async (args) => {
    const out = await runner.run({ cwd: folder, args }, AbortSignal.timeout(30000));
    assert.equal(out.status, "completed", `${args.join(" ")}: ${out.stderr}`);
    return out.stdout;
  };
  app.store.projects.save(owner, { id: "garden-app", name: "Garden app", folder: "garden-app" });
  app.store.projects.save(owner, { id: "no-repo-here", name: "Not a repository yet" });
  const server = await startServer(app, { dataDir: app.store.folder, port: 0 });
  t.after(() => server.close().catch(() => undefined));
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url };
  const get = (path) => fetch(`${server.url}${path}`, { headers }).then((r) => r.json());
  const post = (path, body) => fetch(`${server.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  return { app, owner, folder, run, runner, get, post };
}

test("a repository with no commits yet reports it has no status to publish", needsGit, async (t) => {
  const { folder, get } = await fixture(t);
  assert.equal(await readGitStatus(new GitRunner(), folder, AbortSignal.timeout(5000)), null);
  const status = await get("/api/collab/git-status?repository=garden-app");
  assert.equal(status.repository, "garden-app");
  assert.match(status.error, /no commits/);
});

test("an unknown repository is refused by name, without touching Git", async (t) => {
  const { get } = await fixture(t);
  const status = await get("/api/collab/git-status?repository=not-a-real-project");
  assert.deepEqual(status, { repository: "not-a-real-project", error: "Repository not found" });
});

test("the window reads a repository's live status, then publishes it as a signed, searchable event", needsGit, async (t) => {
  const { folder, run, get, post } = await fixture(t);
  await writeFile(join(folder, "tomatoes.txt"), "water daily\n");
  await run(["init", "--initial-branch=main"]);
  await run(["config", "user.name", "Test Owner"]);
  await run(["config", "user.email", "owner@example.invalid"]);
  await run(["add", "tomatoes.txt"]);
  await run(["commit", "-m", "Start the garden log"]);
  const clean = await get("/api/collab/git-status?repository=garden-app");
  assert.equal(clean.repository, "garden-app");
  assert.equal(clean.status.branch, "main");
  assert.match(clean.status.head, /^[0-9a-f]{40}$/);
  assert.equal(clean.status.clean, true);
  assert.equal(clean.patch, "");

  await writeFile(join(folder, "tomatoes.txt"), "water daily\nfeed weekly\n");
  const dirty = await get("/api/collab/git-status?repository=garden-app");
  assert.equal(dirty.status.clean, false);
  assert.deepEqual(dirty.status.changed, ["tomatoes.txt"]);
  assert.match(dirty.patch, /feed weekly/);
  assert.equal(dirty.status.head, clean.status.head); // the diff is against HEAD, so the head itself has not moved

  const published = await post("/api/collab/git-patches",
    { repository: "garden-app", title: "Feed the tomatoes weekly", patch: dirty.patch, status: dirty.status });
  assert.equal(published.status, 200);
  assert.equal(published.body.kind, gitPatchKind);
  assert.equal(published.body.payload.repository, "garden-app");
  assert.deepEqual(published.body.payload.status, dirty.status);

  const found = await get("/api/collab/events?kind=git.patch&repository=garden-app&q=weekly");
  assert.deepEqual(found.events.map((e) => e.id), [published.body.id]);
  const elsewhere = await get("/api/collab/events?kind=git.patch&repository=no-repo-here");
  assert.deepEqual(elsewhere.events, []);
});

test("readGitDiff never runs against a folder Git rejects", needsGit, async (t) => {
  const { folder, runner } = await fixture(t);
  const diff = await readGitDiff(runner, join(folder, "does-not-exist"), AbortSignal.timeout(5000));
  assert.equal(diff, "");
});
