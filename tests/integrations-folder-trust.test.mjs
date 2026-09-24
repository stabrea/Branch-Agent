import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, decideFolder, saveFolderTrustSettings, integrationsFileTrusted } from "../dist/index.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";

/**
 * The integrations file named by BRANCH_INTEGRATIONS, when it sits in a workspace folder the owner
 * has not trusted: nothing in it is used. Every section can change where Branch connects, what it
 * runs or what it allows, so none is read from such a folder, and the owner is told once, in one
 * line naming what was left out. Each case gets an app of its own, because the network rules a
 * load sets stay set for the rest of that app's life.
 */
async function fixture(t, mode = "on") {
  const root = await mkdtemp(join(tmpdir(), "branch-integrations-trust-"));
  const workspace = join(root, "workspace"), dataDir = join(root, "data");
  await mkdir(workspace, { recursive: true });
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace, dataDir, provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveFolderTrustSettings(app.store, app.runtime.owner, { mode });
  return { app, root, workspace, dataDir, owner: app.runtime.owner };
}

async function place(path, config) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config));
  return path;
}

/** Loads a file with an empty environment, keeping what Branch said about folder trust. */
async function load(t, app, path) {
  const warned = [], original = console.warn;
  console.warn = (...parts) => warned.push(parts.join(" "));
  try {
    const loaded = await loadIntegrations(app.registry, path, {}, app.secretsFor, app.channelHost);
    t.after(() => loaded.close());
    return { loaded, trustNotes: warned.filter((line) => /not trusted/.test(line)) };
  } finally { console.warn = original; }
}

const privateAddress = new URL("http://127.0.0.1:9/");
const reachesPrivate = { web: { allowPrivateAddresses: true } };
// A chat app whose token is read from an environment variable that is never set, so building it
// fails loudly and nothing is ever sent anywhere.
const chatApp = { channels: [{ type: "telegram", tokenEnv: "BRANCH_TEST_UNSET_TOKEN" }] };
const startsPrograms = (root) => ({
  mcp: [{ id: "stranger", transport: "stdio", command: join(root, "no-such-server"), tools: ["x"], expectedVersion: "1" }],
  hooks: [{ id: "on-finish", event: "run.finished", executable: "nothing" }],
});
const commanding = { shell: { executables: { node: { path: process.execPath } } } };
const browsing = { browser: { allowedOrigins: ["https://example.com"] } };
const pushing = { git: { remote: true } };
const commandTools = ["shell.execute", "shell.session.open", "shell.session.run"];
const browserTools = ["browser.navigate", "browser.click", "signin.fill"];
const added = (app, names) => names.filter((name) => app.registry.names().includes(name));

test("a file in a folder the owner has not trusted cannot open private addresses, and the owner is told once", async (t) => {
  const { app, root, workspace, owner } = await fixture(t);
  const file = await place(join(workspace, "cloned", "integrations.json"), { ...reachesPrivate, ...startsPrograms(root) });
  decideFolder(app.store, owner, workspace, { folder: "cloned", decision: "distrust" });
  const { loaded, trustNotes } = await load(t, app, file);
  assert.equal(loaded.count, 0);
  assert.equal(app.web.settings().allowPrivateAddresses, false, "the network rules keep their defaults");
  await assert.rejects(app.web.policy.assertAllowed(privateAddress), /private or local address/);
  assert.equal(trustNotes.length, 1, "one note covers everything that was left out");
  assert.match(trustNotes[0], /network settings/);
  assert.match(trustNotes[0], /AI tool servers/);
  assert.match(trustNotes[0], /hooks/);
  assert.ok(trustNotes[0].includes(file), "the note names the file");
});

test("chat apps in a file in a folder the owner has not decided about are not started", async (t) => {
  const { app, workspace } = await fixture(t);
  const file = await place(join(workspace, "cloned", "integrations.json"), chatApp);
  const { trustNotes } = await load(t, app, file);
  assert.deepEqual(app.channels.summary().channels, [], "no chat app was attached");
  assert.equal(trustNotes.length, 1);
  assert.match(trustNotes[0], /chat apps/);
});

test("the owner's own file in the data folder still sets the network rules and starts chat apps", async (t) => {
  const { app, dataDir } = await fixture(t);
  const { trustNotes } = await load(t, app, await place(join(dataDir, "integrations.json"), reachesPrivate));
  assert.equal(trustNotes.length, 0);
  await app.web.policy.assertAllowed(privateAddress);
  await assert.rejects(load(t, app, await place(join(dataDir, "chat.json"), chatApp)), /no bot token/,
    "the chat app is built as before");
});

test("a folder the owner trusts still sets the network rules and starts chat apps", async (t) => {
  const { app, workspace, owner } = await fixture(t);
  decideFolder(app.store, owner, workspace, { folder: "cloned", decision: "trust" });
  const { trustNotes } = await load(t, app, await place(join(workspace, "cloned", "integrations.json"), reachesPrivate));
  assert.equal(trustNotes.length, 0);
  await app.web.policy.assertAllowed(privateAddress);
  await assert.rejects(load(t, app, await place(join(workspace, "cloned", "chat.json"), chatApp)), /no bot token/);
});

test("with folder trust off, a file in the workspace works exactly as before", async (t) => {
  const { app, workspace } = await fixture(t, "off");
  await load(t, app, await place(join(workspace, "cloned", "integrations.json"), reachesPrivate));
  await app.web.policy.assertAllowed(privateAddress);
  await assert.rejects(load(t, app, await place(join(workspace, "cloned", "chat.json"), chatApp)), /no bot token/);
});

test("commands in a file in an untrusted folder are not added, nor their programs, limits or environment", async (t) => {
  const { app, workspace } = await fixture(t);
  const { loaded, trustNotes } = await load(t, app, await place(join(workspace, "cloned", "integrations.json"), commanding));
  assert.deepEqual(added(app, commandTools), [], "no command tool was added");
  assert.equal(loaded.hosted.commandsNetless, undefined, "the firewall card is not told about them");
  assert.equal(trustNotes.length, 1);
  assert.match(trustNotes[0], /command settings/);
});

test("the browser section of a file in an untrusted folder is not used: no browser, sites or sign-in filling", async (t) => {
  const { app, workspace } = await fixture(t);
  const { loaded, trustNotes } = await load(t, app, await place(join(workspace, "cloned", "integrations.json"), browsing));
  assert.deepEqual(added(app, browserTools), [], "no browser tool was added");
  assert.equal(loaded.hosted.browser, undefined);
  assert.equal(loaded.hosted.browserOrigins, undefined, "its sites are not the browser's sites");
  assert.equal(trustNotes.length, 1);
  assert.match(trustNotes[0], /browser settings/);
});

test("git settings in a file in an untrusted folder are not used", async (t) => {
  const { app, workspace } = await fixture(t);
  const { trustNotes } = await load(t, app, await place(join(workspace, "cloned", "integrations.json"), { ...pushing, issues: { github: true } }));
  assert.deepEqual(added(app, ["git.push", "git.pull", "github.issues", "issues.get"]), []);
  assert.equal(trustNotes.length, 1);
  assert.match(trustNotes[0], /git settings or issue trackers/);
});

test("a file in an untrusted folder sets up nothing at all, and one note names every section and asks for a restart", async (t) => {
  const { app, root, workspace } = await fixture(t);
  const before = app.registry.names();
  const file = await place(join(workspace, "cloned", "integrations.json"), {
    ...reachesPrivate, ...chatApp, ...startsPrograms(root), ...browsing, ...commanding, ...pushing,
    issues: { github: true, linear: {}, gitlab: true, jira: { site: "tracker.example.org" } },
  });
  const { loaded, trustNotes } = await load(t, app, file);
  assert.deepEqual(app.registry.names(), before, "no tool of any kind was added");
  assert.equal(loaded.count, 0);
  assert.deepEqual(loaded.hosted, {}, "nothing is handed to the rest of the app");
  assert.deepEqual(app.launchFile.leftOut, ["web", "channels", "mcp", "hooks", "browser", "shell", "git", "issues"]);
  assert.equal(trustNotes.length, 1);
  assert.equal(trustNotes[0], `Branch did not use the web and network settings, chat apps, AI tool servers, hooks, browser settings, `
    + `command settings, git settings or issue trackers listed in ${file}: that folder is not trusted. `
    + "Trust it in Settings, Permissions, then restart Branch.");
});

test("a folder the owner trusts still adds the browser, commands, git and issue tools", async (t) => {
  const { app, workspace, owner } = await fixture(t);
  decideFolder(app.store, owner, workspace, { folder: "cloned", decision: "trust" });
  const { loaded, trustNotes } = await load(t, app, await place(join(workspace, "cloned", "integrations.json"),
    { ...browsing, ...commanding, ...pushing, issues: { github: true } }));
  assert.equal(trustNotes.length, 0);
  assert.deepEqual(added(app, [...commandTools, ...browserTools, "git.push", "issues.get"]), [...commandTools, ...browserTools, "git.push", "issues.get"]);
  assert.deepEqual(loaded.hosted.browserOrigins, ["https://example.com"]);
});

test("when needed: a file in a folder nobody decided about is left out, and one the owner trusts is used", async (t) => {
  const { app, workspace, owner } = await fixture(t, "when-needed");
  const file = await place(join(workspace, "cloned", "integrations.json"), pushing);
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, file), false, "the file is itself something to decide about");
  const { trustNotes } = await load(t, app, file);
  assert.deepEqual(added(app, ["git.push"]), []);
  assert.equal(trustNotes.length, 1);
  decideFolder(app.store, owner, workspace, { folder: "cloned", decision: "trust" });
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, file), true);
  await load(t, app, file);
  assert.deepEqual(added(app, ["git.push"]), ["git.push"]);
});

test("a workspace reached through a link: its untrusted folder's file is left out whichever way its path is written",
  { skip: process.platform === "win32" }, async (t) => {
    // Branch will not start on a workspace that is itself a link, so the link (the stand-in here for
    // a Windows junction) leads into the workspace from elsewhere, and the file's path goes through it.
    const { app, root, workspace, owner } = await fixture(t);
    const alias = join(root, "alias");
    await symlink(workspace, alias, "dir");
    decideFolder(app.store, owner, workspace, { folder: "cloned", decision: "distrust" });
    const real = await place(join(workspace, "cloned", "integrations.json"), pushing);
    const throughLink = join(alias, "cloned", "integrations.json");
    assert.equal(integrationsFileTrusted(app.store, owner, workspace, throughLink), false);
    assert.equal(integrationsFileTrusted(app.store, owner, alias, real), false, "the workspace written through the link");
    assert.equal(integrationsFileTrusted(app.store, owner, alias, throughLink), false);
    const { trustNotes } = await load(t, app, throughLink);
    assert.deepEqual(added(app, ["git.push"]), [], "written through the link");
    assert.equal(trustNotes.length, 1);
    await load(t, app, real);
    assert.deepEqual(added(app, ["git.push"]), [], "written as it really is");
  });

test("a file that is itself a link counts only when both where it is written and where it really is may be used",
  { skip: process.platform === "win32" }, async (t) => {
    const { app, workspace, dataDir, owner } = await fixture(t);
    decideFolder(app.store, owner, workspace, { folder: "cloned", decision: "distrust" });
    decideFolder(app.store, owner, workspace, { folder: "mine", decision: "trust" });
    const inside = await place(join(workspace, "cloned", "integrations.json"), pushing);
    const owners = await place(join(dataDir, "owner.json"), pushing);
    await mkdir(join(workspace, "mine"), { recursive: true });
    const linkOutToIn = join(dataDir, "integrations.json"), linkInToOut = join(workspace, "cloned", "owner.json");
    const trustedToUntrusted = join(workspace, "mine", "integrations.json"), outToOut = join(dataDir, "again.json");
    await symlink(inside, linkOutToIn); await symlink(owners, linkInToOut);
    await symlink(inside, trustedToUntrusted); await symlink(owners, outToOut);
    const trusted = (file) => integrationsFileTrusted(app.store, owner, workspace, file);
    assert.equal(trusted(linkOutToIn), false, "a link outside the workspace to a file in an untrusted folder");
    assert.equal(trusted(trustedToUntrusted), false, "a link in a trusted folder to a file in an untrusted one");
    assert.equal(trusted(linkInToOut), false, "a link in an untrusted folder, wherever it points");
    assert.equal(trusted(outToOut), true, "a link outside the workspace to a file outside it");
    const { trustNotes } = await load(t, app, linkOutToIn);
    assert.deepEqual(added(app, ["git.push"]), []);
    assert.equal(trustNotes.length, 1);
  });

test("on Windows, letter case does not matter when the file's folder is judged", async (t) => {
  const { app, owner } = await fixture(t);
  const folders = (path, decision) => app.store.save("settings", owner, "folder_trust",
    { folders: [{ path, decision, decidedAt: new Date().toISOString() }] });
  const trusted = (file) => integrationsFileTrusted(app.store, owner, "C:\\Users\\Owner\\Work", file, "win32");
  folders("C:\\Users\\Owner\\Work\\cloned", "distrust");
  assert.equal(trusted("c:\\users\\owner\\WORK\\Cloned\\integrations.json"), false);
  assert.equal(trusted("C:\\Users\\Owner\\Work\\cloned\\sub\\..\\integrations.json"), false);
  assert.equal(trusted("D:\\Owner\\integrations.json"), true, "a file outside the workspace is the owner's");
  assert.equal(trusted("C:\\Users\\Owner\\Work\\integrations.json"), false, "the workspace itself was never decided about");
  folders("C:\\USERS\\OWNER\\WORK\\CLONED", "trust");
  assert.equal(trusted("c:\\users\\owner\\work\\cloned\\integrations.json"), true);
});

test("Q89.1: an untrusted folder nested inside a trusted one does not inherit trust — specific decision wins",
  async (t) => {
    const { app, workspace, owner } = await fixture(t);
    // Setup: workspace root is trusted
    decideFolder(app.store, owner, workspace, { folder: "", decision: "trust" });
    // Setup: work/cloned-evil is explicitly untrusted
    decideFolder(app.store, owner, workspace, { folder: "work/cloned-evil", decision: "distrust" });

    const trustedFile = await place(join(workspace, "work", "integrations.json"), { git: { remote: true } });
    const untrustedFile = await place(join(workspace, "work", "cloned-evil", "integrations.json"), { git: { remote: true } });

    // A file in the trusted work folder should be trusted
    assert.equal(integrationsFileTrusted(app.store, owner, workspace, trustedFile), true,
      "file in trusted parent folder is trusted");

    // A file in the nested untrusted cloned-evil folder should NOT be trusted (specific wins)
    assert.equal(integrationsFileTrusted(app.store, owner, workspace, untrustedFile), false,
      "file in untrusted nested folder is NOT trusted even though parent is trusted");

    const beforeTools = app.registry.names();
    const { loaded: loadedTrusted, trustNotes: notesTrusted } = await load(t, app, trustedFile);
    const afterTrusted = app.registry.names();

    assert.equal(notesTrusted.length, 0, "trusted parent file is loaded without warnings");
    assert.deepEqual(added(app, ["git.push"]), ["git.push"], "git.push tool added from trusted file");

    const { loaded: loadedUntrusted, trustNotes: notesUntrusted } = await load(t, app, untrustedFile);

    assert.equal(notesUntrusted.length, 1, "untrusted nested file generates one warning");
    assert.match(notesUntrusted[0], /not trusted/);
  });

test("Q89.2: a trusted folder nested inside an untrusted workspace — specific decision wins",
  async (t) => {
    const { app, workspace, owner } = await fixture(t);
    // Setup: workspace root is untrusted
    decideFolder(app.store, owner, workspace, { folder: "", decision: "distrust" });
    // Setup: scratch/proj is explicitly trusted
    decideFolder(app.store, owner, workspace, { folder: "scratch/proj", decision: "trust" });

    const untrustedFile = await place(join(workspace, "scratch", "integrations.json"), { git: { remote: true } });
    const trustedFile = await place(join(workspace, "scratch", "proj", "integrations.json"), { git: { remote: true } });

    // A file in the untrusted workspace root should not be trusted
    assert.equal(integrationsFileTrusted(app.store, owner, workspace, untrustedFile), false,
      "file in untrusted parent workspace is not trusted");

    // A file in the nested trusted proj folder SHOULD be trusted (specific wins)
    assert.equal(integrationsFileTrusted(app.store, owner, workspace, trustedFile), true,
      "file in trusted nested folder IS trusted even though parent is untrusted");

    const { loaded: loadedUntrusted, trustNotes: notesUntrusted } = await load(t, app, untrustedFile);

    assert.equal(notesUntrusted.length, 1, "untrusted file generates warning");
    assert.deepEqual(added(app, ["git.push"]), [], "git.push not added from untrusted file");

    const { loaded: loadedTrusted, trustNotes: notesTrusted } = await load(t, app, trustedFile);

    assert.equal(notesTrusted.length, 0, "trusted nested file is loaded without warnings");
    assert.deepEqual(added(app, ["git.push"]), ["git.push"], "git.push added from trusted nested file");
  });

test("Q89.3: workspace root vs subfolder integrations files — both locations can be read if trusted",
  async (t) => {
    const { app, workspace, owner } = await fixture(t, "on");
    // No folders decided yet, so both are unknown
    const rootFile = join(workspace, "integrations.json");
    const subFile = join(workspace, "config", "integrations.json");

    assert.equal(integrationsFileTrusted(app.store, owner, workspace, rootFile), false,
      "workspace root file is unknown (not trusted) when folder trust is on");
    assert.equal(integrationsFileTrusted(app.store, owner, workspace, subFile), false,
      "subfolder file is unknown (not trusted) when folder trust is on");

    // Now trust the workspace root
    decideFolder(app.store, owner, workspace, { folder: "", decision: "trust" });

    assert.equal(integrationsFileTrusted(app.store, owner, workspace, rootFile), true,
      "workspace root file is now trusted");
    assert.equal(integrationsFileTrusted(app.store, owner, workspace, subFile), true,
      "subfolder file inherits trust from root");

    // Now distrust the config subfolder specifically
    decideFolder(app.store, owner, workspace, { folder: "config", decision: "distrust" });

    assert.equal(integrationsFileTrusted(app.store, owner, workspace, rootFile), true,
      "workspace root file still trusted");
    assert.equal(integrationsFileTrusted(app.store, owner, workspace, subFile), false,
      "subfolder file is NOT trusted (specific distrust wins)");
  });

test("Q89.4: a repository cloned into a trusted folder does NOT inherit trust — nested repos need their own decision", async (t) => {
  const { app, workspace, owner } = await fixture(t);
  decideFolder(app.store, owner, workspace, { folder: "work", decision: "trust" });
  // A repository cloned later into the trusted folder; nobody has decided anything about it.
  const cloned = await place(join(workspace, "work", "cloned-repo", ".git", "HEAD"), ""),
        file = join(workspace, "work", "cloned-repo", "integrations.json");
  await writeFile(file, JSON.stringify({ git: { remote: true } }));
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, file), false,
    "nested repo with .git directory does NOT inherit trust from parent");
});

test("Q89.5: trusting a nested repo explicitly works, overriding inheritance stop", async (t) => {
  const { app, workspace, owner } = await fixture(t);
  decideFolder(app.store, owner, workspace, { folder: "work", decision: "trust" });
  const cloned = await place(join(workspace, "work", "cloned-repo", ".git", "HEAD"), ""),
        file = join(workspace, "work", "cloned-repo", "integrations.json");
  await writeFile(file, JSON.stringify({ git: { remote: true } }));
  // Nested repo is not trusted by inheritance
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, file), false,
    "before decision");
  // Now trust it explicitly
  decideFolder(app.store, owner, workspace, { folder: "work/cloned-repo", decision: "trust" });
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, file), true,
    "explicit trust decision on nested repo works");
});

test("Q89.6: a plain subfolder (no .git) still inherits trust from parent", async (t) => {
  const { app, workspace, owner } = await fixture(t);
  decideFolder(app.store, owner, workspace, { folder: "work", decision: "trust" });
  const file = await place(join(workspace, "work", "subdir", "integrations.json"), { git: { remote: true } });
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, file), true,
    "plain subfolder without .git inherits trust from parent");
});

test("Q89.7: a .git file (worktree/submodule) also stops inheritance", async (t) => {
  const { app, workspace, owner } = await fixture(t);
  decideFolder(app.store, owner, workspace, { folder: "work", decision: "trust" });
  // .git as a file (worktree or submodule pointing to the real .git)
  await mkdir(dirname(join(workspace, "work", "cloned-repo", "integrations.json")), { recursive: true });
  await writeFile(join(workspace, "work", "cloned-repo", ".git"), "gitdir: /path/to/real/.git");
  const file = join(workspace, "work", "cloned-repo", "integrations.json");
  await writeFile(file, JSON.stringify({ git: { remote: true } }));
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, file), false,
    ".git file (worktree) also stops inheritance");
});

test("Q89.8: a symlink pointing to a repo inside the same trusted folder also stops inheritance",
  { skip: process.platform === "win32" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  decideFolder(app.store, owner, workspace, { folder: "work", decision: "trust" });
  // Create a real nested repo
  const realRepo = join(workspace, "work", "real-repo");
  await mkdir(join(realRepo, ".git"), { recursive: true });
  // Symlink to it from elsewhere in the same folder
  const linkPath = join(workspace, "work", "link-to-real");
  await symlink(realRepo, linkPath, "dir");
  const file = join(linkPath, "integrations.json");
  await writeFile(file, JSON.stringify({ git: { remote: true } }));
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, file), false,
    "symlink to repo inside folder: resolved .git stops inheritance");
});

test("Q89.9: a trusted folder that itself contains .git still trusts its own files", async (t) => {
  const { app, workspace, owner } = await fixture(t);
  // The workspace root itself is a repo and is trusted
  await mkdir(join(workspace, ".git"), { recursive: true });
  decideFolder(app.store, owner, workspace, { folder: "", decision: "trust" });
  const file = await place(join(workspace, "integrations.json"), { git: { remote: true } });
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, file), true,
    "trusted folder with .git trusts its own files (check stops at folder level, not below)");
});

test("Q89.10: a link inside a trusted folder pointing at a clone outside the workspace is not trusted",
  { skip: process.platform === "win32" && "links need privileges on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  decideFolder(app.store, owner, workspace, { folder: "work", decision: "trust" });
  const elsewhere = await mkdtemp(join(tmpdir(), "branch-q89-clone-"));
  t.after(() => discardTemp(elsewhere));
  await mkdir(join(elsewhere, ".git"), { recursive: true });
  await writeFile(join(elsewhere, "integrations.json"), JSON.stringify({ git: { remote: true } }));
  await mkdir(join(workspace, "work"), { recursive: true });
  const link = join(workspace, "work", "linked-clone");
  await symlink(elsewhere, link, "dir");
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, join(link, "integrations.json")), false,
    "reached through a trusted folder, but the real place is a repository nobody trusted");
  decideFolder(app.store, owner, workspace, { folder: "cloned", decision: "distrust" });
  await mkdir(join(workspace, "cloned"), { recursive: true });
  const plain = await mkdtemp(join(tmpdir(), "branch-q89-plain-"));
  t.after(() => discardTemp(plain));
  await writeFile(join(plain, "integrations.json"), JSON.stringify({ git: { remote: true } }));
  await symlink(plain, join(workspace, "cloned", "out"), "dir");
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, join(workspace, "cloned", "out", "integrations.json")), false,
    "a folder link in an untrusted folder is still that folder's, wherever it points");
});

test("Q89.11: a repository inside a folder the owner distrusts stays distrusted, not merely undecided", async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust } = await import("../dist/folder-trust.js");
  decideFolder(app.store, owner, workspace, { folder: "work", decision: "distrust" });
  await mkdir(join(workspace, "work", "clone", ".git"), { recursive: true });
  assert.equal(folderTrust(app.store, owner, join(workspace, "work", "clone")), "untrusted");
});

test("Q89.12: a file link in a trusted folder to the owner's own file outside the workspace is not used",
  { skip: process.platform === "win32" && "links need privileges on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  decideFolder(app.store, owner, workspace, { folder: "mine", decision: "trust" });
  const elsewhere = await mkdtemp(join(tmpdir(), "branch-q89-owner-"));
  t.after(() => discardTemp(elsewhere));
  await writeFile(join(elsewhere, "integrations.json"), JSON.stringify({ git: { remote: true } }));
  await mkdir(join(workspace, "mine"), { recursive: true });
  const link = join(workspace, "mine", "integrations.json");
  await symlink(join(elsewhere, "integrations.json"), link);
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, join(elsewhere, "integrations.json")), true,
    "the owner's file named directly is the owner's");
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, link), false,
    "reached through the workspace, it has no decision where it leads");
});

// Q100 (Legion's ruling on NAS d065ffd): a parallel copy Branch made takes its source repository's
// decision; only Branch's own record of the copy counts, never the copy's own `.git` file.
const gitIn = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });
async function projectRepo(workspace) {
  const proj = join(workspace, "work", "proj");
  await mkdir(proj, { recursive: true });
  gitIn(proj, "init", "-q", "-b", "main");
  gitIn(proj, "commit", "-q", "--allow-empty", "-m", "first");
  return proj;
}
const signal = () => AbortSignal.timeout(20_000);

test("Q100: a copy Branch makes of a trusted repository is trusted, and one it removes is forgotten",
  { skip: process.platform === "win32" && "git worktree paths differ on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust } = await import("../dist/folder-trust.js");
  const proj = await projectRepo(workspace);
  decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "trust" });
  await app.git.worktree({ folder: "work/proj", action: "add", name: "exp" }, signal());
  await app.git.planStart({ folder: "work/proj", name: "idea" }, signal());
  const copy = join(proj, ".branch-worktrees", "exp");
  assert.equal(folderTrust(app.store, owner, copy), "trusted", "a copy made with git.worktree_add");
  assert.equal(folderTrust(app.store, owner, join(proj, ".branch-worktrees", "idea")), "trusted", "a copy made with plans.try");
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, join(copy, "integrations.json")), true);
  // Removed with the tool, then something else put at the same path with a `.git` file: the record is gone.
  await app.git.worktree({ folder: "work/proj", action: "remove", name: "exp" }, signal());
  await mkdir(copy, { recursive: true });
  await writeFile(join(copy, ".git"), `gitdir: ${join(proj, ".git", "worktrees", "exp")}\n`);
  assert.equal(folderTrust(app.store, owner, copy), "unknown", "a removed copy's place is not a copy any more");
});

test("Q100: a clone or a forged worktree in .branch-worktrees is not a copy Branch made",
  { skip: process.platform === "win32" && "git worktree paths differ on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust } = await import("../dist/folder-trust.js");
  const proj = await projectRepo(workspace);
  decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "trust" });
  const clone = join(proj, ".branch-worktrees", "fake");
  await mkdir(clone, { recursive: true });
  gitIn(clone, "init", "-q");
  assert.equal(folderTrust(app.store, owner, clone), "unknown", "a repository cloned there");
  // A real worktree made by hand (the source's own admin entry exists), but not by Branch: not on record.
  gitIn(proj, "worktree", "add", "-q", "--detach", join(proj, ".branch-worktrees", "forged"));
  assert.equal(folderTrust(app.store, owner, join(proj, ".branch-worktrees", "forged")), "unknown", "the .git file and git's own entry grant nothing");
});

test("Q100: a copy takes its source's decision, whatever it is",
  { skip: process.platform === "win32" && "git worktree paths differ on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust } = await import("../dist/folder-trust.js");
  const proj = await projectRepo(workspace);
  // The source is a repository inside a trusted folder, with no decision of its own: undecided, and so is its copy.
  decideFolder(app.store, owner, workspace, { folder: "work", decision: "trust" });
  await app.git.worktree({ folder: "work/proj", action: "add", name: "exp" }, signal());
  const copy = join(proj, ".branch-worktrees", "exp");
  assert.equal(folderTrust(app.store, owner, proj), "unknown");
  assert.equal(folderTrust(app.store, owner, copy), "unknown", "undecided, like its source");
  decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "distrust" });
  assert.equal(folderTrust(app.store, owner, copy), "untrusted", "distrusted, like its source");
});

test("Q100: a copy made from a folder inside a repository is not trusted by that folder's decision",
  { skip: process.platform === "win32" && "git worktree paths differ on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust } = await import("../dist/folder-trust.js");
  const mono = join(workspace, "work", "mono");
  await mkdir(join(mono, "pkg"), { recursive: true });
  await writeFile(join(mono, "integrations.json"), JSON.stringify({ git: { remote: true } }));
  await writeFile(join(mono, "pkg", "readme.md"), "pkg");
  gitIn(mono, "init", "-q", "-b", "main");
  gitIn(mono, "add", ".");
  gitIn(mono, "commit", "-q", "-m", "first");
  decideFolder(app.store, owner, workspace, { folder: "work/mono/pkg", decision: "trust" });
  await app.git.worktree({ folder: "work/mono/pkg", action: "add", name: "x" }, signal());
  const copy = join(mono, "pkg", ".branch-worktrees", "x");
  assert.ok(existsSync(join(copy, "integrations.json")), "the copy is a full checkout, root file included");
  assert.equal(folderTrust(app.store, owner, copy), "unknown", "a package's decision does not cover a copy of the whole repository");
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, join(copy, "integrations.json")), false);
});

test("Q100: a record the copy outlived grants nothing to what is put at its place later",
  { skip: process.platform === "win32" && "git worktree paths differ on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust } = await import("../dist/folder-trust.js");
  const proj = await projectRepo(workspace);
  const other = join(workspace, "work", "other");
  await mkdir(other, { recursive: true });
  gitIn(other, "init", "-q", "-b", "main");
  gitIn(other, "commit", "-q", "--allow-empty", "-m", "first");
  decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "trust" });
  await app.git.worktree({ folder: "work/proj", action: "add", name: "exp" }, signal());
  const copy = join(proj, ".branch-worktrees", "exp");
  gitIn(proj, "worktree", "remove", "--force", copy); // by hand, not through the tool: the record stays
  gitIn(other, "worktree", "add", "-q", "--detach", copy);
  assert.equal(folderTrust(app.store, owner, copy), "unknown", "another repository's worktree at the recorded place");
});

test("Q100: a copy of a copy, both made by the tool, takes the first repository's decision",
  { skip: process.platform === "win32" && "git worktree paths differ on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust } = await import("../dist/folder-trust.js");
  const proj = await projectRepo(workspace);
  decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "trust" });
  await app.git.worktree({ folder: "work/proj", action: "add", name: "exp" }, signal());
  await app.git.worktree({ folder: "work/proj/.branch-worktrees/exp", action: "add", name: "deeper" }, signal());
  assert.equal(folderTrust(app.store, owner, join(proj, ".branch-worktrees", "exp", ".branch-worktrees", "deeper")), "trusted");
});

test("Q100: a decision on a folder inside the source holds in the copy, and a decision in the copy itself wins",
  { skip: process.platform === "win32" && "git worktree paths differ on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust } = await import("../dist/folder-trust.js");
  const proj = join(workspace, "work", "proj");
  await mkdir(join(proj, "sub"), { recursive: true });
  await writeFile(join(proj, "sub", "integrations.json"), JSON.stringify({ git: { remote: true } }));
  await writeFile(join(proj, "sub", "AGENTS.md"), "planted");
  gitIn(proj, "init", "-q", "-b", "main");
  gitIn(proj, "add", ".");
  gitIn(proj, "commit", "-q", "-m", "first");
  decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "trust" });
  decideFolder(app.store, owner, workspace, { folder: "work/proj/sub", decision: "distrust" });
  await app.git.planStart({ folder: "work/proj", name: "idea" }, signal());
  const copy = join(proj, ".branch-worktrees", "idea");
  assert.equal(folderTrust(app.store, owner, join(copy, "sub")), "untrusted", "the source's don't-trust on sub holds in the copy");
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, join(copy, "sub", "integrations.json")), false);
  assert.equal(folderTrust(app.store, owner, copy), "trusted", "the rest of the copy is the source's trusted root");
  decideFolder(app.store, owner, workspace, { folder: "work/proj/.branch-worktrees/idea/sub", decision: "trust" });
  assert.equal(folderTrust(app.store, owner, join(copy, "sub")), "trusted", "a decision made in the copy wins");
});

test("Q100: a copies folder that is a link into another repository's copies is not the source's",
  { skip: process.platform === "win32" && "links need privileges on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust } = await import("../dist/folder-trust.js");
  const proj = await projectRepo(workspace);
  const other = join(workspace, "work", "other");
  await mkdir(join(other, ".branch-worktrees"), { recursive: true });
  gitIn(other, "init", "-q", "-b", "main");
  gitIn(other, "commit", "-q", "--allow-empty", "-m", "first");
  await symlink(join(other, ".branch-worktrees"), join(proj, ".branch-worktrees"), "dir");
  decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "trust" });
  await assert.rejects(app.git.worktree({ folder: "work/proj", action: "add", name: "exp" }, signal()), /is a link/);
  assert.equal(existsSync(join(other, ".branch-worktrees", "exp")), false, "no copy is made in another repository's copies");
  assert.equal(folderTrust(app.store, owner, join(proj, ".branch-worktrees", "exp")), "unknown");
});

test("Q100: the source's list must name this copy, not just any copy",
  { skip: process.platform === "win32" && "git worktree paths differ on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust } = await import("../dist/folder-trust.js");
  const proj = await projectRepo(workspace);
  const other = join(workspace, "work", "other");
  await mkdir(other, { recursive: true });
  gitIn(other, "init", "-q", "-b", "main");
  gitIn(other, "commit", "-q", "--allow-empty", "-m", "first");
  decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "trust" });
  await app.git.worktree({ folder: "work/proj", action: "add", name: "exp" }, signal());
  await app.git.worktree({ folder: "work/proj", action: "add", name: "keep" }, signal());
  const exp = join(proj, ".branch-worktrees", "exp");
  gitIn(proj, "worktree", "remove", "--force", exp); // by hand: exp's record stays, and the list still names keep
  gitIn(other, "worktree", "add", "-q", "--detach", exp);
  assert.equal(folderTrust(app.store, owner, exp), "unknown", "the list names keep, not what is at exp now");
  assert.equal(folderTrust(app.store, owner, join(proj, ".branch-worktrees", "keep")), "trusted", "the copy still listed keeps its trust");
});

test("Q100: a repository inside a copy is not covered by the source's trust, as it would not be in the source",
  { skip: process.platform === "win32" && "git worktree paths differ on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust } = await import("../dist/folder-trust.js");
  const proj = await projectRepo(workspace);
  decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "trust" });
  await app.git.worktree({ folder: "work/proj", action: "add", name: "exp" }, signal());
  const evil = join(proj, ".branch-worktrees", "exp", "vendor", "evil");
  await mkdir(evil, { recursive: true });
  gitIn(evil, "init", "-q");
  await writeFile(join(evil, "integrations.json"), JSON.stringify({ git: { remote: true } }));
  assert.equal(folderTrust(app.store, owner, evil), "unknown");
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, join(evil, "integrations.json")), false);
});

test("Q100: a decision between the source and its copy is closer, so it wins",
  { skip: process.platform === "win32" && "git worktree paths differ on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust } = await import("../dist/folder-trust.js");
  const proj = await projectRepo(workspace);
  decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "trust" });
  await app.git.worktree({ folder: "work/proj", action: "add", name: "exp" }, signal());
  decideFolder(app.store, owner, workspace, { folder: "work/proj/.branch-worktrees", decision: "distrust" });
  const exp = join(proj, ".branch-worktrees", "exp");
  await mkdir(join(exp, "sub"), { recursive: true });
  await writeFile(join(exp, "sub", "integrations.json"), JSON.stringify({ git: { remote: true } }));
  assert.equal(folderTrust(app.store, owner, exp), "untrusted");
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, join(exp, "sub", "integrations.json")), false);
});

test("Q100: links between a copy and its source cannot send the check round for ever",
  { skip: process.platform === "win32" && "links need privileges on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust } = await import("../dist/folder-trust.js");
  const proj = await projectRepo(workspace);
  decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "trust" });
  await app.git.worktree({ folder: "work/proj", action: "add", name: "exp" }, signal());
  const inCopy = join(proj, ".branch-worktrees", "exp", "Y");
  await mkdir(inCopy, { recursive: true });
  await symlink(inCopy, join(proj, "Y"), "dir");
  assert.equal(folderTrust(app.store, owner, inCopy), "unknown", "an answer, not a stack overflow");
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, join(inCopy, "integrations.json")), false);
});

test("Q100: a copy made through another checkout of the same repository is not judged as that checkout's copy",
  { skip: process.platform === "win32" && "links need privileges on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust } = await import("../dist/folder-trust.js");
  const main = join(workspace, "work", "main"), pr = join(workspace, "work", "pr");
  await mkdir(main, { recursive: true });
  gitIn(main, "init", "-q", "-b", "main");
  gitIn(main, "commit", "-q", "--allow-empty", "-m", "first");
  gitIn(main, "worktree", "add", "-q", "-b", "prb", pr);
  decideFolder(app.store, owner, workspace, { folder: "work/main", decision: "trust" });
  decideFolder(app.store, owner, workspace, { folder: "work/pr", decision: "distrust" });
  // Branch no longer makes a copy through a linked copies folder; a record from before that still names pr.
  const exp = join(main, ".branch-worktrees", "exp");
  gitIn(pr, "worktree", "add", "-q", "--detach", exp);
  const { recordWorktreeCopy } = await import("../dist/folder-trust.js");
  recordWorktreeCopy(app.store, owner, pr, exp, true);
  await mkdir(join(exp, "sub"), { recursive: true });
  await writeFile(join(exp, "sub", "integrations.json"), JSON.stringify({ git: { remote: true } }));
  assert.notEqual(folderTrust(app.store, owner, exp), "trusted", "made from the distrusted pr, not from main");
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, join(exp, "sub", "integrations.json")), false);
});

test("Q100: a loop between a copy and its source under a don't-trust stays untrusted",
  { skip: process.platform === "win32" && "links need privileges on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust } = await import("../dist/folder-trust.js");
  const proj = await projectRepo(workspace);
  decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "distrust" });
  await app.git.worktree({ folder: "work/proj", action: "add", name: "exp" }, signal());
  const inCopy = join(proj, ".branch-worktrees", "exp", "Y");
  await mkdir(inCopy, { recursive: true });
  await symlink(inCopy, join(proj, "Y"), "dir");
  assert.equal(folderTrust(app.store, owner, inCopy), "untrusted");
});

test("Q100: a real folder in a copy is not judged through a link its source has now",
  { skip: process.platform === "win32" && "links need privileges on Windows" }, async (t) => {
  const { folderTrust } = await import("../dist/folder-trust.js");
  const outside = await mkdtemp(join(tmpdir(), "branch-q100-outside-"));
  t.after(() => discardTemp(outside));
  // Where the source's `sub` points once it has moved on, and the decision that would otherwise reach the copy.
  const setups = {
    "a link up to the trusted workspace": { link: "..", decide: null },
    "a link to a trusted sibling": { link: "../lib", decide: "work/lib" },
    "a link to a trusted folder inside the source": { link: "docs", decide: "work/proj/docs" },
    "a link out of every decision": { link: outside, decide: null },
  };
  for (const [name, { link, decide }] of Object.entries(setups)) {
    const { app, workspace, owner } = await fixture(t);
    const proj = join(workspace, "work", "proj");
    await mkdir(join(proj, "sub"), { recursive: true });
    await mkdir(join(proj, "docs"), { recursive: true });
    await mkdir(join(workspace, "work", "lib"), { recursive: true });
    await writeFile(join(proj, "sub", "AGENTS.md"), "planted");
    await writeFile(join(proj, "sub", "integrations.json"), JSON.stringify({ git: { remote: true } }));
    await writeFile(join(proj, "docs", "readme.md"), "docs");
    gitIn(proj, "init", "-q", "-b", "main");
    gitIn(proj, "add", ".");
    gitIn(proj, "commit", "-q", "-m", "first");
    decideFolder(app.store, owner, workspace, { folder: "", decision: "trust" });
    decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "distrust" });
    if (decide) decideFolder(app.store, owner, workspace, { folder: decide, decision: "trust" });
    await app.git.worktree({ folder: "work/proj", action: "add", name: "exp" }, signal());
    const sub = join(proj, ".branch-worktrees", "exp", "sub");
    assert.equal(folderTrust(app.store, owner, sub), "untrusted", `${name}: before the source moves on`);
    // The source moves on (a pull, a checkout) to where `sub` is a link; the copy keeps its real folder.
    await rm(join(proj, "sub"), { recursive: true });
    await symlink(link, join(proj, "sub"), "dir");
    assert.equal(folderTrust(app.store, owner, sub), "untrusted", `${name}: the copy's own place decides`);
    assert.equal(integrationsFileTrusted(app.store, owner, workspace, join(sub, "integrations.json")), false, name);
  }
});

test("Q100: a link at any level of the source's path is not followed, even for a copy made from an older branch",
  { skip: process.platform === "win32" && "links need privileges on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust } = await import("../dist/folder-trust.js");
  const proj = join(workspace, "work", "proj");
  await mkdir(join(proj, "a", "b"), { recursive: true });
  await mkdir(join(workspace, "work", "lib", "b"), { recursive: true });
  await writeFile(join(proj, "a", "b", "AGENTS.md"), "planted");
  await writeFile(join(proj, "a", "b", "integrations.json"), JSON.stringify({ git: { remote: true } }));
  gitIn(proj, "init", "-q", "-b", "main");
  gitIn(proj, "add", ".");
  gitIn(proj, "commit", "-q", "-m", "old");
  gitIn(proj, "branch", "old");
  gitIn(proj, "rm", "-q", "-r", "a");
  await symlink("../lib", join(proj, "a"), "dir");
  gitIn(proj, "add", "a");
  gitIn(proj, "commit", "-q", "-m", "a is a link now");
  decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "distrust" });
  decideFolder(app.store, owner, workspace, { folder: "work/lib", decision: "trust" });
  await app.git.planStart({ folder: "work/proj", name: "t", from: "old" }, signal());
  const copy = join(proj, ".branch-worktrees", "t");
  for (const inside of [join(copy, "a"), join(copy, "a", "b")])
    assert.equal(folderTrust(app.store, owner, inside), "untrusted", inside);
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, join(copy, "a", "b", "integrations.json")), false);
});

test("Q100: a repository that carries its copies folder as a link gets no copy, so none lands outside it",
  { skip: process.platform === "win32" && "links need privileges on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const proj = join(workspace, "work", "proj");
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, "AGENTS.md"), "planted");
  await writeFile(join(proj, "integrations.json"), JSON.stringify({ git: { remote: true } }));
  gitIn(proj, "init", "-q", "-b", "main");
  for (const [name, link] of [["up", ".."], ["out", "../../.."]]) {
    await rm(join(proj, ".branch-worktrees"), { force: true });
    await symlink(link, join(proj, ".branch-worktrees"), "dir");
    gitIn(proj, "add", ".");
    gitIn(proj, "commit", "-q", "-m", `copies folder -> ${link}`);
    decideFolder(app.store, owner, workspace, { folder: "", decision: "trust" });
    decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "distrust" });
    await assert.rejects(app.git.worktree({ folder: "work/proj", action: "add", name }, signal()), /is a link/, `git.worktree_add through ${link}`);
    await assert.rejects(app.git.planStart({ folder: "work/proj", name: `${name}-plan` }, signal()), /is a link/, `plans.try through ${link}`);
    for (const made of [name, `${name}-plan`])
      assert.equal(existsSync(join(proj, link, made)), false, `nothing written at ${link}/${made}`);
  }
});

test("Q100: a copy's own place that the repository already fills (a link out, or a folder) gets no copy",
  { skip: process.platform === "win32" && "links need privileges on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "branch-q100-outside-empty-"));
  t.after(() => discardTemp(outside));
  const proj = join(workspace, "work", "proj");
  await mkdir(join(proj, ".branch-worktrees", "held"), { recursive: true });
  await writeFile(join(proj, ".branch-worktrees", "held", "keep"), "");
  await writeFile(join(proj, "AGENTS.md"), "planted");
  await symlink(outside, join(proj, ".branch-worktrees", "exp"), "dir");
  gitIn(proj, "init", "-q", "-b", "main");
  gitIn(proj, "add", ".");
  gitIn(proj, "commit", "-q", "-m", "a copy's place planted");
  decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "distrust" });
  for (const name of ["exp", "held"]) {
    await assert.rejects(app.git.worktree({ folder: "work/proj", action: "add", name }, signal()), /already at/, `git.worktree_add ${name}`);
    await assert.rejects(app.git.planStart({ folder: "work/proj", name }, signal()), /already at/, `plans.try ${name}`);
  }
  assert.equal(existsSync(join(outside, "AGENTS.md")), false, "nothing was written through the link");
});

test("Q100: a recorded copy of a folder the owner does not trust is not trusted wherever it lies, unless decided inside it",
  { skip: process.platform === "win32" && "git worktree paths differ on Windows" }, async (t) => {
  const { app, workspace, owner } = await fixture(t);
  const { folderTrust, recordWorktreeCopy } = await import("../dist/folder-trust.js");
  const outside = await mkdtemp(join(tmpdir(), "branch-q100-copy-out-"));
  t.after(() => discardTemp(outside));
  const proj = await projectRepo(workspace);
  const stray = join(workspace, "work", "exp");
  await mkdir(join(stray, "sub"), { recursive: true });
  await writeFile(join(stray, "sub", "integrations.json"), JSON.stringify({ git: { remote: true } }));
  decideFolder(app.store, owner, workspace, { folder: "", decision: "trust" });
  decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "distrust" });
  // Records a copy made before its place was checked for links could have left: beside the source, or outside the workspace.
  recordWorktreeCopy(app.store, owner, proj, stray, true);
  recordWorktreeCopy(app.store, owner, proj, outside, true);
  assert.equal(folderTrust(app.store, owner, stray), "untrusted", "not the workspace's trust");
  assert.equal(folderTrust(app.store, owner, join(stray, "sub")), "untrusted");
  assert.equal(integrationsFileTrusted(app.store, owner, workspace, join(stray, "sub", "integrations.json")), false);
  assert.equal(folderTrust(app.store, owner, outside), "untrusted", "not unknown, outside every decision");
  decideFolder(app.store, owner, workspace, { folder: "work/exp/sub", decision: "trust" });
  assert.equal(folderTrust(app.store, owner, join(stray, "sub")), "trusted", "a decision made inside the copy comes first");
  decideFolder(app.store, owner, workspace, { folder: "work/proj", decision: "trust" });
  assert.equal(folderTrust(app.store, owner, stray), "trusted", "a trusted source adds nothing: the workspace decides");
});

test("Q107: removing a copy never follows a link the repository carries to another worktree",
  { skip: process.platform === "win32" && "links need privileges on Windows" }, async (t) => {
  const { app, workspace } = await fixture(t);
  const proj = join(workspace, "work", "proj"), side = join(workspace, "work", "side");
  await mkdir(join(proj, ".branch-worktrees"), { recursive: true });
  await symlink("../../side", join(proj, ".branch-worktrees", "x"), "dir");
  gitIn(proj, "init", "-q", "-b", "main");
  gitIn(proj, "add", ".");
  gitIn(proj, "commit", "-q", "-m", "a copy's place planted as a link");
  gitIn(proj, "worktree", "add", "-q", "--detach", side); // the owner's own worktree, made by hand
  for (const name of ["x", "side"]) gitIn(proj, "branch", `plan/${name}`); // so a merge would go through
  await writeFile(join(side, "unsaved.txt"), "the owner's unsaved work");
  const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: proj, encoding: "utf8" }).trim();
  const before = head();
  await assert.rejects(app.git.worktree({ folder: "work/proj", action: "remove", name: "x" }, signal()), /nothing is removed/);
  await assert.rejects(app.git.planMerge({ folder: "work/proj", name: "x", remove: true }, signal()), /nothing is removed/);
  // The copies folder itself as a link: the copy's place leads to the same worktree.
  await rm(join(proj, ".branch-worktrees"), { recursive: true });
  await symlink("..", join(proj, ".branch-worktrees"), "dir");
  await assert.rejects(app.git.worktree({ folder: "work/proj", action: "remove", name: "side" }, signal()), /nothing is removed/);
  await assert.rejects(app.git.planMerge({ folder: "work/proj", name: "side", remove: true }, signal()), /nothing is removed/);
  assert.equal(readFileSync(join(side, "unsaved.txt"), "utf8"), "the owner's unsaved work", "the owner's worktree is untouched");
  assert.equal(head(), before, "nothing was merged either");
});

test("Q107: a plan's merge that brings a link to the copy's place never gets the owner's worktree removed",
  { skip: process.platform === "win32" && "links need privileges on Windows" }, async (t) => {
  const { app, workspace } = await fixture(t);
  const external = await mkdtemp(join(tmpdir(), "branch-q107-owner-worktree-"));
  t.after(() => discardTemp(external));
  const proj = join(workspace, "work", "proj");
  await mkdir(proj, { recursive: true });
  gitIn(proj, "init", "-q", "-b", "main");
  gitIn(proj, "config", "user.name", "t"); // a real identity, so the merge really goes through
  gitIn(proj, "config", "user.email", "t@t");
  gitIn(proj, "commit", "-q", "--allow-empty", "-m", "first");
  await rm(external, { recursive: true });
  gitIn(proj, "worktree", "add", "-q", "--detach", external); // the owner's own worktree, outside the workspace
  await writeFile(join(external, "unsaved.txt"), "the owner's unsaved work");
  // The plan's branch carries the copy's place as a link to it; main does not, so the first check passes.
  gitIn(proj, "switch", "-q", "-c", "plan/x");
  await mkdir(join(proj, ".branch-worktrees"), { recursive: true });
  await symlink(external, join(proj, ".branch-worktrees", "x"), "dir");
  gitIn(proj, "add", ".branch-worktrees/x");
  gitIn(proj, "commit", "-q", "-m", "the copy's place, as a link");
  gitIn(proj, "switch", "-q", "main");
  assert.equal(existsSync(join(proj, ".branch-worktrees", "x")), false);
  const result = await app.git.planMerge({ folder: "work/proj", name: "x", remove: true }, signal());
  assert.ok(existsSync(join(external, "unsaved.txt")), "the owner's worktree is untouched");
  assert.equal(result.merged, true);
  assert.equal(result.copyRemoved, false, "nothing was removed, and it says so");
});

test("Q107: a copy already gone is never handed to Git to remove, so a link that appears there meanwhile is never followed",
  { skip: process.platform === "win32" && "git worktree paths differ on Windows" }, async (t) => {
  const { app, workspace } = await fixture(t);
  const proj = join(workspace, "work", "proj");
  await mkdir(proj, { recursive: true });
  gitIn(proj, "init", "-q", "-b", "main");
  gitIn(proj, "config", "user.name", "t");
  gitIn(proj, "config", "user.email", "t@t");
  gitIn(proj, "commit", "-q", "--allow-empty", "-m", "first");
  const runner = app.git.runner, real = runner.run.bind(runner), removes = [];
  runner.run = async (options, signal) => { if (options.args[0] === "worktree" && options.args[1] === "remove") removes.push(options.args.at(-1)); return real(options, signal); };
  t.after(() => { runner.run = real; });
  for (const name of ["gone", "merged"]) {
    await app.git.planStart({ folder: "work/proj", name }, signal());
    await rm(join(proj, ".branch-worktrees", name), { recursive: true, force: true }); // put away by hand
  }
  await assert.rejects(app.git.worktree({ folder: "work/proj", action: "remove", name: "gone" }, signal()), /nothing was removed/);
  const result = await app.git.planMerge({ folder: "work/proj", name: "merged", remove: true }, signal());
  assert.equal(result.copyRemoved, false, "nothing was removed, and it says so");
  assert.deepEqual(removes, [], "Git was never asked to remove a place that is not there");
});

test("Q107: a folder the repository carries at a copy's place, swapped for a link as Git is called, never gets another worktree removed",
  { skip: process.platform === "win32" && "links need privileges on Windows" }, async (t) => {
  // NAS 28ba0db: a real folder passed the check, then a branch switch (Branch's own git.branch, in another run)
  // put a link there before Git looked, and Git followed it to the owner's worktree. Here the switch is made at
  // the moment Git is asked to remove, which is the widest that window can be.
  const { app, workspace } = await fixture(t);
  const proj = join(workspace, "work", "proj"), side = join(workspace, "work", "side");
  await mkdir(join(proj, ".branch-worktrees", "x"), { recursive: true });
  await writeFile(join(proj, ".branch-worktrees", "x", "keep.txt"), "a folder the repository carries");
  gitIn(proj, "init", "-q", "-b", "with-dir");
  gitIn(proj, "config", "user.name", "t");
  gitIn(proj, "config", "user.email", "t@t");
  gitIn(proj, "add", ".");
  gitIn(proj, "commit", "-q", "-m", "a real folder at the copy's place");
  gitIn(proj, "switch", "-q", "-c", "with-link");
  await rm(join(proj, ".branch-worktrees", "x"), { recursive: true });
  await symlink("../../side", join(proj, ".branch-worktrees", "x"), "dir");
  gitIn(proj, "add", "-A");
  gitIn(proj, "commit", "-q", "-m", "a link at the copy's place");
  gitIn(proj, "switch", "-q", "with-dir");
  gitIn(proj, "branch", "plan/x"); // so a merge would go through
  gitIn(proj, "worktree", "add", "-q", "--detach", side); // the owner's own worktree, made by hand
  await writeFile(join(side, "unsaved.txt"), "the owner's unsaved work");
  const runner = app.git.runner, real = runner.run.bind(runner), removes = [];
  runner.run = async (options, signal) => {
    if (options.args[0] === "worktree" && options.args[1] === "remove") {
      removes.push(options.args.at(-1));
      gitIn(proj, "switch", "-q", "with-link"); // the other run's switch lands now
    }
    return real(options, signal);
  };
  t.after(() => { runner.run = real; });
  const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: proj, encoding: "utf8" }).trim();
  const before = head();
  await assert.rejects(app.git.worktree({ folder: "work/proj", action: "remove", name: "x" }, signal()), /not a parallel copy Git knows of/);
  await assert.rejects(app.git.planMerge({ folder: "work/proj", name: "x", remove: true }, signal()), /not a parallel copy Git knows of/);
  assert.deepEqual(removes, [], "Git was never asked to remove a folder it has no copy at");
  assert.equal(readFileSync(join(side, "unsaved.txt"), "utf8"), "the owner's unsaved work", "the owner's worktree is untouched");
  assert.match(execFileSync("git", ["worktree", "list"], { cwd: proj, encoding: "utf8" }), /side/, "and still registered");
  assert.equal(head(), before, "nothing was merged either");
});

test("Q107: a copy Branch made is still removed, by the path Git registered for it", async (t) => {
  const { app, workspace } = await fixture(t);
  const proj = join(workspace, "work", "proj");
  await mkdir(proj, { recursive: true });
  gitIn(proj, "init", "-q", "-b", "main");
  gitIn(proj, "config", "user.name", "t");
  gitIn(proj, "config", "user.email", "t@t");
  gitIn(proj, "commit", "-q", "--allow-empty", "-m", "first");
  await app.git.worktree({ folder: "work/proj", action: "add", name: "mine" }, signal());
  await app.git.planStart({ folder: "work/proj", name: "plan" }, signal());
  assert.deepEqual(await app.git.worktree({ folder: "work/proj", action: "remove", name: "mine" }, signal()),
    { folder: "work/proj", name: "mine", removed: true });
  const merged = await app.git.planMerge({ folder: "work/proj", name: "plan", remove: true }, signal());
  assert.equal(merged.copyRemoved, true);
  assert.deepEqual((await app.git.worktree({ folder: "work/proj", action: "list" }, signal())).copies, []);
});

test("Q107: two removes of one copy at once go one at a time, so Git is asked once and the other says it is gone", async (t) => {
  const { app, workspace } = await fixture(t);
  const proj = join(workspace, "work", "proj");
  await mkdir(proj, { recursive: true });
  gitIn(proj, "init", "-q", "-b", "main");
  gitIn(proj, "commit", "-q", "--allow-empty", "-m", "first");
  await app.git.worktree({ folder: "work/proj", action: "add", name: "twice" }, signal());
  const runner = app.git.runner, real = runner.run.bind(runner), removes = [];
  runner.run = async (options, signal) => {
    if (options.args[0] === "worktree" && options.args[1] === "remove") {
      removes.push(options.args.at(-1));
      await new Promise((resolve) => setTimeout(resolve, 200)); // Git is slow; the other remove is checking meanwhile
    }
    return real(options, signal);
  };
  t.after(() => { runner.run = real; });
  const both = await Promise.allSettled([1, 2].map(() => app.git.worktree({ folder: "work/proj", action: "remove", name: "twice" }, signal())));
  assert.equal(removes.length, 1, "Git was asked once");
  assert.equal(both.filter((one) => one.status === "fulfilled").length, 1);
  assert.match(String(both.find((one) => one.status === "rejected")?.reason?.message), /nothing was removed/);
});
