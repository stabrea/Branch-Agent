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
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { GitRunner, gitEnvironment, hardening } from "../dist/integrations/git-run.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { discardTemp } from "./temp-dir.mjs";

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
