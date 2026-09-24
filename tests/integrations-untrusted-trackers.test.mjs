import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";

/**
 * The code-hosting and issue connections (GitHub, a GitHub App, GitLab, Linear and Jira) named in
 * an integrations file that sits in a workspace folder the owner has not trusted. None of them is
 * set up, so neither a read-only tool call nor a pasted issue address contacts any server. Once the
 * owner trusts the folder, the same file is used as before, which shows each check can see a request.
 *
 * Every server here is a stand-in on this computer. Nothing leaves it: the fetch below forwards only
 * to the stand-in and refuses everything else, and the network rules never look a name up.
 */
const realFetch = globalThis.fetch;
/** Jira is always reached over https at a named site, so its site is mapped onto the stand-in. */
const namedSites = new Map();
const refused = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const mapped = namedSites.get(url.host);
  if (mapped) return realFetch(new URL(url.pathname + url.search, mapped), init);
  if (url.hostname === "127.0.0.1") return realFetch(url, init);
  refused.push(url.href);
  throw new Error("This test reaches nothing outside this computer");
};
// Imported after the fetch above is in place, so every connection is built with it.
const { createBranch, decideFolder, saveFolderTrustSettings, miscApi } = await import("../dist/index.js");
const { loadIntegrations } = await import("../dist/integrations/bootstrap.js");

/** A stand-in tracker on port 0 that counts every request it is sent. */
async function standIn(t) {
  const hits = [];
  const server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("/access_tokens"))
      return response.end(JSON.stringify({ token: "stand-in-installation", expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
    response.end("{}");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const host = `127.0.0.1:${server.address().port}`;
  return { hits, host, url: `http://${host}` };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-untrusted-trackers-"));
  const workspace = join(root, "workspace"), dataDir = join(root, "data");
  await mkdir(workspace, { recursive: true });
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace, dataDir, provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  saveFolderTrustSettings(app.store, owner, { mode: "on" });
  // The owner's own network rules reach this computer (a tracker of their own could live here), so
  // a request to the stand-in would get through: only the folder decides. Names are never looked up.
  app.web.configure({ allowPrivateAddresses: true });
  app.web.policy.resolve = async () => [];
  const project = app.store.projects.active(owner).id;
  for (const [name, value] of Object.entries({ SAVED_TOKEN: "saved-token-value", SAVED_EMAIL: "someone@example.org" }))
    await app.store.secrets.put(owner, project, name, value);
  const tracker = await standIn(t);
  const file = join(workspace, "cloned", "integrations.json");
  decideFolder(app.store, owner, workspace, { folder: "cloned", decision: "distrust" });
  return { app, owner, workspace, project, tracker, file };
}

async function place(path, config) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config));
  return path;
}

async function load(t, app, path) {
  const warned = [], original = console.warn;
  console.warn = (...parts) => warned.push(parts.join(" "));
  try {
    const loaded = await loadIntegrations(app.registry, path, {}, app.secretsFor, app.channelHost);
    t.after(() => loaded.close());
    return { loaded, notes: warned.filter((line) => /not trusted/.test(line)) };
  } finally { console.warn = original; }
}

/** A call that only reads, allowed the way a task's read would be. */
const readOnly = (app, name, args) => app.registry.execute(name, args,
  app.runtime.context({ runId: "untrusted-trackers", permissions: ["issues.read", "github.manage", "gitlab.read"] }))
  .catch((error) => error);

/**
 * The file is loaded from the untrusted folder: the tool is missing and the stand-in hears nothing.
 * Then the owner trusts the folder and the same file is loaded again: the tool is there and the
 * stand-in is reached, so the first half was not quiet by accident.
 */
async function untrustedThenTrusted(t, f, tool, args, section) {
  const { notes } = await load(t, f.app, f.file);
  await readOnly(f.app, tool, args);
  assert.equal(f.tracker.hits.length, 0, "the tracker named in the file was never contacted");
  assert.equal(f.app.registry.names().includes(tool), false, `${tool} was not added`);
  assert.equal(notes.length, 1);
  assert.match(notes[0], section);
  decideFolder(f.app.store, f.owner, f.workspace, { folder: "cloned", decision: "trust" });
  await load(t, f.app, f.file);
  await readOnly(f.app, tool, args);
  assert.ok(f.tracker.hits.length >= 1, "once trusted, the same file is used");
  assert.deepEqual(refused, [], "nothing tried to leave this computer");
}

test("GitHub named in a file in an untrusted folder is not set up, so reading an issue contacts nothing", async (t) => {
  const f = await fixture(t);
  await place(f.file, { git: { github: { apiBase: `${f.tracker.url}/`, tokenSecret: "SAVED_TOKEN" } }, issues: { github: true } });
  await untrustedThenTrusted(t, f, "issues.get", { issue: "octo/repo#1" }, /issue trackers/);
});

test("GitLab named in a file in an untrusted folder is not set up, so reading an issue contacts nothing", async (t) => {
  const f = await fixture(t);
  await place(f.file, { git: { gitlab: { apiBase: `${f.tracker.url}/api/v4`, tokenSecret: "SAVED_TOKEN" } }, issues: { gitlab: true } });
  await untrustedThenTrusted(t, f, "issues.get", { issue: `https://${f.tracker.host}/group/app/-/issues/1` }, /git settings/);
});

test("a GitHub App named in a file in an untrusted folder is not set up, so listing issues contacts nothing", async (t) => {
  const f = await fixture(t);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  await f.app.store.secrets.put(f.owner, f.project, "SAVED_APP_KEY", privateKey);
  await place(f.file, { git: { github: { apiBase: `${f.tracker.url}/` },
    githubApp: { mode: "on", appId: "1", installationId: "2", privateKeySecret: "SAVED_APP_KEY" } } });
  await untrustedThenTrusted(t, f, "github.issues", { repo: "octo/repo" }, /git settings/);
});

test("Linear named in a file in an untrusted folder is not set up, so reading an issue contacts nothing", async (t) => {
  const f = await fixture(t);
  await place(f.file, { issues: { linear: { apiBase: `${f.tracker.url}/graphql`, tokenSecret: "SAVED_TOKEN" } } });
  await untrustedThenTrusted(t, f, "issues.get", { issue: "ENG-1" }, /issue trackers/);
});

test("Jira named in a file in an untrusted folder is not set up, so reading an issue contacts nothing", async (t) => {
  const f = await fixture(t);
  namedSites.set("tracker.untrusted.test", f.tracker.url);
  t.after(() => namedSites.delete("tracker.untrusted.test"));
  await place(f.file, { issues: { jira: { site: "tracker.untrusted.test", emailSecret: "SAVED_EMAIL", tokenSecret: "SAVED_TOKEN" } } });
  await untrustedThenTrusted(t, f, "issues.get", { issue: "https://tracker.untrusted.test/browse/ABC-1" }, /issue trackers/);
});

test("pasting an issue address contacts no tracker named in a file in an untrusted folder", async (t) => {
  const f = await fixture(t);
  await place(f.file, { git: { github: { apiBase: `${f.tracker.url}/`, tokenSecret: "SAVED_TOKEN" } }, issues: { github: true } });
  // What the launcher does with the loaded file (src/cli.ts, src/desktop/main.ts).
  const paste = async (loaded) => {
    f.app.issues = loaded.hosted.issues ?? null;
    return miscApi(f.app, { method: "POST" }, "/api/issues/context", async () => ({ url: "https://github.com/octo/repo/issues/1" }))
      .catch((error) => error);
  };
  const untrusted = await load(t, f.app, f.file);
  const answer = await paste(untrusted.loaded);
  assert.equal(f.tracker.hits.length, 0, "no tracker was contacted");
  assert.match(String(answer.message), /No issue tracker is switched on/);
  decideFolder(f.app.store, f.owner, f.workspace, { folder: "cloned", decision: "trust" });
  await paste((await load(t, f.app, f.file)).loaded);
  assert.ok(f.tracker.hits.length >= 1, "once trusted, a pasted address is read as before");
  assert.deepEqual(refused, []);
});
