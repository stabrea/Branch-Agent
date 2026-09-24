/**
 * Q12: a held command can write inside its folder, so it could plant `x/.git/config` naming a program
 * (core.fsmonitor, diff.external). Branch's own Git must never run that program outside the sandbox:
 *   1. Git tools refuse any folder in Branch's source that is not a worktree's root (real app);
 *   2. every Git Branch runs pins the settings that start programs, so even run there, nothing starts.
 * Only a local `git init` is run here; nothing reaches a network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBranch } from "../dist/index.js";
import { GitRunner, gitEnvironment, hardening } from "../dist/integrations/git-run.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { GitTools } from "../dist/integrations/git.js";
import { WorkspaceFiles } from "../dist/files.js";
import { discardTemp } from "./temp-dir.mjs";

const posixOnly = process.platform === "win32" && "shell scripts are for macOS and Linux";
const sha = "a".repeat(40);
const worktree = "branch-agent-source/.branch-worktrees/self-remove-button";

/** A nested repository at <worktree>/src/ui/x whose own config names a program that leaves a marker. */
async function plantedRepository(workspace, only) {
  const nested = join(workspace, worktree, "src", "ui", "x"), marker = join(workspace, "..", "PWNED");
  await mkdir(nested, { recursive: true });
  const script = join(workspace, "..", "evil.sh");
  await writeFile(script, `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`);
  await chmod(script, 0o755);
  const git = (...args) => execFileSync("git", args, { cwd: nested, stdio: "ignore" });
  git("init", "-q");
  await writeFile(join(nested, "a.txt"), "one\n");
  git("-c", "user.name=t", "-c", "user.email=t@t", "add", "a.txt");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
  await writeFile(join(nested, "a.txt"), "two\n");
  for (const key of only ? [only] : ["core.fsmonitor", "diff.external"]) git("config", key, script);
  return { nested, marker };
}

test("Git tools refuse a folder in Branch's source that is not a worktree's root", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-nested-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const { marker } = await plantedRepository(workspace);
  new ContractBook(app.store.sqlite).create(app.runtime.owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms: {
    allowedPaths: ["src/ui/**"], permissions: ["git.status", "git.diff", "git.log"], expectedTests: ["t"], definitionOfDone: "d", sideEffects: [], rollbackPlan: "r" } });
  const run = app.store.createRun(app.runtime.owner, "look");
  const context = app.runtime.context({ runId: run.id, source: "owner" });
  for (const name of ["git.status", "git.diff", "git.log"])
    await assert.rejects(app.registry.execute(name, { folder: `${worktree}/src/ui/x` }, context),
      /Git runs in Branch's own source only at a self-development worktree's root/, name);
  await assert.rejects(app.registry.execute("git.status", { folder: "branch-agent-source" }, context), /only at a self-development worktree's root/,
    "the protected checkout itself");
  assert.equal(existsSync(marker), false, "the planted program never ran");
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "self_development.contract" }).filter((entry) => entry.outcome === "refused").length, 4);
});

test("every Git Branch runs pins the settings that start programs, so a planted config runs nothing", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-pins-"));
  t.after(() => discardTemp(root));
  const { nested, marker } = await plantedRepository(join(root, "workspace"));
  const runner = new GitRunner();
  for (const args of [["status", "--porcelain"], ["diff", "--no-ext-diff", "--no-textconv"], ["log", "-p", "-1"]]) {
    const outcome = await runner.run({ cwd: nested, args }, AbortSignal.timeout(20_000));
    assert.equal(outcome.status, "completed", `${args.join(" ")}: ${outcome.stderr}`);
  }
  // A patch asked for without --no-ext-diff stops loudly on the pinned `false` instead of running the planted program.
  const plain = await runner.run({ cwd: nested, args: ["diff"] }, AbortSignal.timeout(20_000));
  assert.match(plain.stderr, /external diff died/);
  assert.equal(existsSync(marker), false, "neither core.fsmonitor nor diff.external ran");
});

test("each setting a repository's own config could use to start a program runs nothing", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-pins-each-"));
  t.after(() => discardTemp(root));
  const runner = new GitRunner();
  const cases = [
    ["core.fsmonitor", ["status", "--porcelain"]],
    ["diff.external", ["diff"]],
    ["core.editor", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty"]],
    ["gpg.program", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgSign=true", "commit", "-q", "--allow-empty", "-m", "signed?"]],
    ["core.pager", ["-p", "log", "-1"]],
  ];
  for (const [key, args] of cases) {
    const repo = join(root, key.replace(".", "-"));
    const { marker } = await plantedRepository(repo, key);
    await runner.run({ cwd: join(repo, worktree, "src", "ui", "x"), args }, AbortSignal.timeout(20_000));
    assert.equal(existsSync(marker), false, `${key} started nothing`);
  }
  // A commit hook in the planted repository never runs either (core.hooksPath is pinned to an empty folder).
  const hooked = join(root, "hooks");
  const { nested, marker } = await plantedRepository(hooked, "core.fsmonitor");
  await writeFile(join(nested, ".git", "hooks", "pre-commit"), `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 });
  await runner.run({ cwd: nested, args: ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "hooked?"] }, AbortSignal.timeout(20_000));
  assert.equal(existsSync(marker), false, "the pre-commit hook started nothing");
  // The ones that only act over a network, or that change what the owner sees, are pinned only inside
  // Branch's source (checked in the arguments, not run here).
  const inSource = hardening("/w/branch-agent-source/.branch-worktrees/self-x").join(" "), elsewhere = hardening("/w/proj").join(" ");
  for (const key of ["core.gitProxy=", "protocol.ext.allow=never", "safe.bareRepository=explicit", "commit.gpgSign=false", "diff.ignoreSubmodules=all"])
    assert.ok(inSource.includes(`-c ${key}`), key);
  for (const key of ["commit.gpgSign=false", "diff.ignoreSubmodules=all", "safe.bareRepository=explicit"])
    assert.ok(!elsewhere.includes(`-c ${key}`), `${key} is not forced on the owner's own repositories`);
  assert.ok(elsewhere.includes("-c core.fsmonitor=false") && elsewhere.includes("-c diff.external=false"));
});

test("the owner's own Git sign-in is left alone: a credential helper they set is still the one Git uses", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-signin-"));
  t.after(() => discardTemp(root));
  const home = join(root, "home"), repo = join(root, "repo");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(join(home, ".gitconfig"), "[credential]\n\thelper = !echo keep-me\n");
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  const runner = new GitRunner({ env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") } });
  const helper = await runner.run({ cwd: repo, args: ["config", "--get", "credential.helper"] }, AbortSignal.timeout(20_000));
  assert.equal(helper.stdout.trim(), "!echo keep-me", "the helper is not cleared by Branch's settings");
  for (const key of ["credential.helper=", "core.askPass=", "core.sshCommand=ssh"]) assert.ok(!hardening(repo).join(" ").includes(`-c ${key}`), key);
  assert.equal(gitEnvironment(process.env).GIT_CONFIG_NOSYSTEM, undefined, "the computer-wide config (where macOS keeps its keychain helper) is read");
});

/**
 * Q12: a held command can turn an allowed folder (here `src/`) into a bare repository with no `.git`
 * name anywhere. Git then reads a remote name nobody configured, "src", as that folder, and the
 * planted repository's hooks run outside the wall. Each guard is tested on its own.
 */
async function plantedBare(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-self-bare-repo-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const folder = "branch-agent-source/.branch-worktrees/self-bare";
  const cwd = join(workspace, folder);
  await mkdir(cwd, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-q", "-b", "feature");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "initial");
  execFileSync("git", ["init", "--bare", "-q", join(cwd, "src")]);
  const marker = join(root, "hook-ran");
  const hook = join(cwd, "src", "hooks", "pre-receive");
  await writeFile(hook, `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`);
  await chmod(hook, 0o755);
  return { app, folder, cwd, marker };
}

test("Q12 control: without Branch's pins, a push to the unconfigured name \"src\" runs the planted hook", { skip: posixOnly }, async (t) => {
  const { cwd, marker } = await plantedBare(t);
  execFileSync("git", ["push", "-q", "src", "HEAD:refs/heads/x"], { cwd, stdio: "pipe" });
  assert.equal(existsSync(marker), true, "the setup is the real attack: plain Git runs the hook");
});

test("Q12: the source pins alone stop Git's local transport, so the planted hook never runs", { skip: posixOnly }, async (t) => {
  const { cwd, marker } = await plantedBare(t);
  assert.ok(hardening(cwd).includes("protocol.file.allow=never"));
  assert.throws(() => execFileSync("git", [...hardening(cwd), "push", "-q", "src", "HEAD:refs/heads/x"], { cwd, stdio: "pipe" }),
    (error) => /transport 'file' not allowed/.test(String(error.stderr)));
  assert.equal(existsSync(marker), false);
});

test("Q12: git.push and git.pull in source refuse a remote nobody configured, before Git runs", { skip: posixOnly }, async (t) => {
  const { app, folder, marker } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  await assert.rejects(app.git.push({ folder, remote: "src", branch: "feature" }, signal), /Remote "src" is not configured/);
  await assert.rejects(app.git.pull({ folder, remote: "src", branch: "feature" }, signal), /Remote "src" is not configured/);
  assert.equal(existsSync(marker), false);
});

test("Q12: git.push and git.pull in source refuse a configured remote that is a folder or a file:// address", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd, marker } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["remote", "add", "near", join(cwd, "src")], { cwd });
  execFileSync("git", ["remote", "add", "far", `file://${join(cwd, "src")}`], { cwd });
  for (const remote of ["near", "far"]) {
    await assert.rejects(app.git.push({ folder, remote, branch: "feature" }, signal), /Remote URL must use https/, remote);
    await assert.rejects(app.git.pull({ folder, remote, branch: "feature" }, signal), /Remote URL must use https/, remote);
  }
  assert.equal(existsSync(marker), false);
});

test("Q12: a link to Branch's source still gets the source pins", { skip: posixOnly }, async (t) => {
  const { cwd } = await plantedBare(t);
  const link = join(await mkdtemp(join(tmpdir(), "branch-self-link-")), "elsewhere");
  t.after(() => discardTemp(dirname(link)));
  await symlink(cwd, link);
  assert.ok(hardening(link).includes("protocol.file.allow=never"), "decided on the real path, not the link's name");
});

test("Q79: git.push and git.pull in source refuse LOCAL scoped credential.helper", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "credential.helper", "fake"], { cwd });
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /credential helper.*local scope/);
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /credential helper.*local scope/);
});

test("Q79: git.push and git.pull in source refuse LOCAL scoped core.askPass", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "core.askPass", "/bin/false"], { cwd });
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /password prompt.*local scope/);
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /password prompt.*local scope/);
});

test("Q79: git.push and git.pull in source refuse LOCAL scoped core.sshCommand", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "core.sshCommand", "/bin/false"], { cwd });
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /SSH command.*local scope/);
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /SSH command.*local scope/);
});

test("Q79: git.push and git.pull in source refuse WORKTREE scoped credential.helper", { skip: posixOnly }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-wtree-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const folder = "branch-agent-source/.branch-worktrees/self-worktree";
  const cwd = join(workspace, folder);
  await mkdir(cwd, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-q", "-b", "feature");
  git("config", "extensions.worktreeConfig", "true");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "initial");
  git("remote", "add", "origin", "https://example.com/repo.git");
  git("config", "--worktree", "credential.helper", "fake");
  const signal = AbortSignal.timeout(10_000);
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /credential helper.*worktree scope/);
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /credential helper.*worktree scope/);
});

test("Q79: git.push and git.pull in source leave the owner's own GLOBAL credential.helper alone", { skip: posixOnly }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-global-"));
  t.after(() => discardTemp(root));
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, ".gitconfig"), "[credential]\n\thelper = fake\n");
  // The Git these tools run must read the same home, or a global helper would never be seen at all.
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
  const tools = new GitTools(new WorkspaceFiles(workspace), new GitRunner({ env }));
  const folder = "branch-agent-source/.branch-worktrees/self-global";
  const cwd = join(workspace, folder);
  await mkdir(cwd, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd, env, stdio: "pipe" });
  git("init", "-q", "-b", "feature");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "initial");
  assert.match(git("config", "--show-scope", "--get-regexp", "^credential\\..*helper$").toString(), /^global\scredential\.helper fake$/m, "the helper is seen, at global scope");
  const signal = AbortSignal.timeout(10_000);
  // Past the sign-in check, the unconfigured remote is what refuses: the owner's helper was allowed.
  await assert.rejects(tools.push({ folder, remote: "origin", branch: "feature" }, signal), /Remote "origin" is not configured/);
  await assert.rejects(tools.pull({ folder, remote: "origin", branch: "feature" }, signal), /Remote "origin" is not configured/);
});

test("Q79: outside Branch's source, a LOCAL scoped credential.helper is not refused", { skip: posixOnly }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-outside-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const folder = "normal-repo";
  const cwd = join(workspace, folder);
  await mkdir(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "custom"], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "initial"], { cwd });
  execFileSync("git", ["config", "--local", "credential.helper", "fake"], { cwd });
  execFileSync("git", ["remote", "add", "origin", "https://example.invalid/repo.git"], { cwd });
  const signal = AbortSignal.timeout(10_000);
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "custom" }, signal), /reach the server/, "rejected for the invalid host or network, not refused by Q79 scope check");
});

test("Q82: git.push and git.pull in source refuse an scp-like remote with host starting with dash", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["remote", "add", "attack", "git@-h:repo.git"], { cwd });
  await assert.rejects(app.git.push({ folder, remote: "attack", branch: "feature" }, signal), /user or host with "-"/);
  await assert.rejects(app.git.pull({ folder, remote: "attack", branch: "feature" }, signal), /user or host with "-"/);
});

test("Q82: git.push and git.pull in source refuse an ssh:// remote with host starting with dash", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["remote", "add", "attack", "ssh://-oProxyCommand=id@example.com/repo.git"], { cwd });
  await assert.rejects(app.git.push({ folder, remote: "attack", branch: "feature" }, signal), /user or host with "-"/);
  await assert.rejects(app.git.pull({ folder, remote: "attack", branch: "feature" }, signal), /user or host with "-"/);
});

test("Q82: a dash-led user or host is refused in every spelling of an ssh remote", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  for (const [name, url] of [["a", "ssh://git@-oProxyCommand=id/repo.git"], ["b", "ssh://git@-h:22/repo.git"], ["c", "-oProxyCommand=id@example.com:repo.git"]]) {
    execFileSync("git", ["config", `remote.${name}.url`, url], { cwd });
    await assert.rejects(app.git.push({ folder, remote: name, branch: "feature" }, signal), /user or host with "-"|must use https/, url);
  }
});

test("Q82: git.push and git.pull in source refuse a remote URL changed by url.<x>.insteadOf", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["remote", "add", "origin", "https://example.com/repo.git"], { cwd });
  execFileSync("git", ["config", "--local", "url.https://evil.com/.insteadOf", "https://example.com/"], { cwd });
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /insteadOf.*redirect/);
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /insteadOf.*redirect/);
});

test("Q82: outside Branch's source, an scp-like remote with dash host is not refused by Q82 check", { skip: posixOnly }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-outside-dash-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const folder = "normal-repo";
  const cwd = join(workspace, folder);
  await mkdir(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "custom"], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "initial"], { cwd });
  execFileSync("git", ["remote", "add", "attack", "git@-h:repo.git"], { cwd });
  const signal = AbortSignal.timeout(10_000);
  // Verify the rejection is not from the Q82 dash check (which should only run in Branch's source)
  await assert.rejects(app.git.push({ folder, remote: "attack", branch: "custom" }, signal), (e) => {
    assert.doesNotMatch(String(e), /user or host with "-"/, "Q82 dash check should not run outside Branch's source");
    return true;
  });
});

test("A1: git.push and git.pull in source refuse LOCAL scoped include.path", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "include.path", "/tmp/evil"], { cwd });
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /included config file.*local scope/);
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /included config file.*local scope/);
});

test("A1: git.push and git.pull in source refuse URL-scoped credential.helper (LOCAL scope)", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "credential.https://example.com.helper", "fake"], { cwd });
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /credential helper.*local scope/);
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /credential helper.*local scope/);
});

test("A1: git.push and git.pull in source allow credential.username (not matched by helper pattern)", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "credential.username", "fake"], { cwd });
  // Should not refuse for credential.username; will fail for unconfigured remote or network reasons
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /not configured/, "credential.username does not trigger the helper refusal");
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /not configured/, "credential.username does not trigger the helper refusal");
});

test("B: git.push in source refuses when push URLs count differs from configured URL count", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["remote", "add", "origin", "https://example.com/repo.git"], { cwd });
  execFileSync("git", ["remote", "set-url", "--add", "--push", "origin", "https://example.com/repo.git"], { cwd });
  execFileSync("git", ["remote", "set-url", "--add", "--push", "origin", "https://evil.com/repo.git"], { cwd });
  // Now there are 2 push URLs but only 1 base URL; this should be refused
  await assert.rejects(app.git.push({ folder, remote: "origin", branch: "feature" }, signal), /insteadOf.*redirect/);
});

test("C: git.pull in source judges the fetch URL, not the push URL, when only fetching is rewritten", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["remote", "add", "origin", "https://example.com/repo.git"], { cwd });
  // pushInsteadOf maps the URL to itself, so pushing still goes to example.com; fetching goes to evil.com.
  execFileSync("git", ["config", "--local", "url.https://example.com/.pushInsteadOf", "https://example.com/"], { cwd });
  execFileSync("git", ["config", "--local", "url.https://evil.com/.insteadOf", "https://example.com/"], { cwd });
  assert.equal(execFileSync("git", ["remote", "get-url", "--push", "origin"], { cwd, encoding: "utf8" }).trim(), "https://example.com/repo.git");
  assert.equal(execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" }).trim(), "https://evil.com/repo.git");
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /insteadOf.*redirect/);
});

test("C: git.pull in source refuses when fetch URL rewritten to dash-leading host", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["remote", "add", "origin", "https://example.com/repo.git"], { cwd });
  execFileSync("git", ["config", "--local", "url.git@-h:.insteadOf", "https://example.com/"], { cwd });
  // Pull should refuse because fetch URL is rewritten to git@-h:, which has a dash-leading host
  await assert.rejects(app.git.pull({ folder, remote: "origin", branch: "feature" }, signal), /user or host with "-"/);
});

test("Q96: a remote Git reads from an old .git/remotes or .git/branches file is refused in source, even rewritten", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd, encoding: "utf8" }).trim();
  await mkdir(join(gitDir, "remotes"), { recursive: true });
  await mkdir(join(gitDir, "branches"), { recursive: true });
  await writeFile(join(gitDir, "remotes", "legacy"), "URL: https://example.com/repo.git\n");
  await writeFile(join(gitDir, "branches", "older"), "https://example.com/other.git\n");
  execFileSync("git", ["config", "--local", "url.https://evil.com/.insteadOf", "https://example.com/"], { cwd });
  assert.equal(execFileSync("git", ["remote", "get-url", "legacy"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
    "https://evil.com/repo.git", "Git itself sends to the rewritten address");
  for (const remote of ["legacy", "older"]) {
    await assert.rejects(app.git.push({ folder, remote, branch: "feature" }, signal), /not set in Git's settings/, remote);
    await assert.rejects(app.git.pull({ folder, remote, branch: "feature" }, signal), /not set in Git's settings/, remote);
  }
});

test("Q98: publishing from Branch's source gets the push checks: a rewritten address or a local helper is refused, and no remote is left", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "url.https://evil.com/.insteadOf", "https://github.com/"], { cwd });
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/r.git", remote: "origin" }, signal), /insteadOf.*redirect/);
  assert.equal(execFileSync("git", ["remote"], { cwd, encoding: "utf8" }).trim(), "", "the refused address is not left behind");
  execFileSync("git", ["config", "--local", "--unset", "url.https://evil.com/.insteadOf"], { cwd });
  execFileSync("git", ["config", "--local", "credential.https://github.com.helper", "!echo planted"], { cwd });
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/r.git", remote: "origin" }, signal), /credential helper/);
  assert.equal(execFileSync("git", ["remote"], { cwd, encoding: "utf8" }).trim(), "");
});

test("Q98: publishing is held to the worktree-root rule like the Git tools", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-publish-root-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const { marker } = await plantedRepository(workspace);
  new ContractBook(app.store.sqlite).create(app.runtime.owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms: {
    allowedPaths: ["src/ui/**"], permissions: ["github.publish_repo"], expectedTests: ["t"], definitionOfDone: "d", sideEffects: [], rollbackPlan: "r" } });
  // Publishing is registered only once GitHub access is set up; the refusal comes before GitHub is ever asked.
  const { GitHubAccess } = await import("../dist/integrations/github.js");
  const { registerGitHubProject } = await import("../dist/integrations/git-tools.js");
  const { NetworkPolicy } = await import("../dist/network-policy.js");
  registerGitHubProject(app.registry, new GitHubAccess({ apiBase: "http://127.0.0.1:9" }, new NetworkPolicy({ allowPrivateAddresses: true }), async () => "ghp_fake"), app.git);
  const run = app.store.createRun(app.runtime.owner, "publish");
  const context = app.runtime.context({ runId: run.id, source: "owner" });
  await assert.rejects(app.registry.execute("github.publish_repo", { folder: `${worktree}/src/ui/x`, name: "demo" }, context),
    /Git runs in Branch's own source only at a self-development worktree's root/);
  assert.equal(existsSync(marker), false, "the planted program never ran");
});

test("Q98: publishing checks the address Git will push to, so a push-only rewrite is refused too", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["config", "--local", "url.https://evil.com/.pushInsteadOf", "https://github.com/"], { cwd });
  execFileSync("git", ["config", "--local", "http.proxy", "http://127.0.0.1:9"], { cwd }); // should the check ever miss, nothing leaves this computer
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/r.git", remote: "origin" }, signal), /insteadOf.*redirect/);
  assert.equal(execFileSync("git", ["remote"], { cwd, encoding: "utf8" }).trim(), "", "no remote is left");
});

test("Q101: a refused publish leaves the folder's own remote as it was", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  execFileSync("git", ["remote", "add", "origin", "https://example.com/mine.git"], { cwd });
  execFileSync("git", ["config", "--local", "url.https://evil.com/.insteadOf", "https://github.com/"], { cwd });
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/r.git", remote: "origin" }, signal), /insteadOf.*redirect/);
  assert.equal(execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd, encoding: "utf8" }).trim(), "https://example.com/mine.git",
    "the folder's own origin is untouched");
  assert.equal(execFileSync("git", ["remote"], { cwd, encoding: "utf8" }).trim(), "origin", "the check's own remote is gone");
});

test("Q101: settings for the pushed name kept in the computer's own Git settings are checked too", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  const signal = AbortSignal.timeout(10_000);
  const home = await mkdtemp(join(tmpdir(), "branch-q101-home-"));
  await writeFile(join(home, ".gitconfig"), "[remote \"origin\"]\n\tpushurl = https://evil.example/global.git\n");
  const before = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home; process.env.XDG_CONFIG_HOME = join(home, ".config");
  t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  await assert.rejects(app.git.publish({ folder, url: "https://github.com/o/r.git", remote: "origin" }, signal), /insteadOf.*redirect/);
});


test("Q98: git.push and publishing send the branch as refs/heads/<name>, the ref the contract walks", { skip: posixOnly }, async (t) => {
  const { app, folder, cwd } = await plantedBare(t);
  execFileSync("git", ["config", "--local", "http.proxy", "http://127.0.0.1:9"], { cwd });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], { cwd });
  const runner = app.git.runner, real = runner.run.bind(runner);
  const pushed = [];
  runner.run = async (options, signal) => { if (options.args[0] === "push") pushed.push(options.args.at(-1)); return real(options, signal); };
  t.after(() => { runner.run = real; });
  for (const branch of ["worktrees/self-x/HEAD", "ORIG_HEAD", "side"])
    await app.git.push({ folder, remote: "origin", branch }, AbortSignal.timeout(10_000)).catch(() => undefined);
  await app.git.publish({ folder, url: "https://github.com/o/p.git", remote: "upstream", branch: "main-worktree/HEAD" }, AbortSignal.timeout(10_000)).catch(() => undefined);
  assert.deepEqual(pushed, ["refs/heads/worktrees/self-x/HEAD", "refs/heads/ORIG_HEAD", "refs/heads/side", "refs/heads/main-worktree/HEAD"]);
});
