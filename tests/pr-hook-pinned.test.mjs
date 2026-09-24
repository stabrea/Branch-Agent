/**
 * A pull request from Branch's own source sends exactly the history its contract checked plus the one
 * new commit made on it, whatever else moves HEAD or the new branch meanwhile. Real Git in a real
 * self-development worktree; the push is a stand-in that reads what Git would send at that moment,
 * and GitHub is a stand-in too, so nothing leaves this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createBranch, NetworkPolicy } from "../dist/index.js";
import { GitRunner } from "../dist/integrations/git-run.js";
import { pullRequestFromChanges, savePullRequestHookSettings } from "../dist/pr-hook.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { discardTemp } from "./temp-dir.mjs";

const posixOnly = process.platform === "win32" && "real Git in a self-development worktree is exercised on macOS and Linux";
const folder = "branch-agent-source/.branch-worktrees/self-x";
const plain = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const scripted = () => ({ name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } });

/**
 * Branch's source with a self-development worktree whose contract allows `src/ui/**`: `walked` is the
 * worktree's commit, `other` is the tip of another branch two commits past it that adds a file the
 * contract does not allow, and the task's change is a new file under src/ui that is not committed yet.
 */
async function sourceWorktree(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-pr-pinned-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider: scripted() });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner, source = join(workspace, "branch-agent-source"), worktree = join(workspace, folder);
  await mkdir(source, { recursive: true });
  plain(source, "init", "-q", "-b", "main");
  plain(source, "config", "user.name", "t");
  plain(source, "config", "user.email", "t@t");
  plain(source, "config", "http.proxy", "http://127.0.0.1:9"); // nothing leaves this computer
  plain(source, "remote", "add", "origin", "git@github.com:acme/widgets.git");
  plain(source, "commit", "-q", "--allow-empty", "-m", "source");
  const base = plain(source, "rev-parse", "HEAD");
  plain(source, "worktree", "add", "-q", "-b", "self-x", worktree);
  await mkdir(join(worktree, "src", "ui"), { recursive: true });
  await writeFile(join(worktree, "src", "ui", "button.ts"), "export const button = 1;\n");
  plain(worktree, "add", "src");
  plain(worktree, "commit", "-q", "-m", "the work so far");
  const walked = plain(worktree, "rev-parse", "HEAD");
  plain(worktree, "switch", "-q", "-c", "owner-extra");
  await mkdir(join(worktree, ".github", "workflows"), { recursive: true });
  await writeFile(join(worktree, ".github", "workflows", "extra.yml"), "on: push\n");
  plain(worktree, "add", ".github");
  plain(worktree, "commit", "-q", "-m", "other work, part one");
  await writeFile(join(worktree, ".github", "workflows", "extra.yml"), "on: [push, pull_request]\n");
  plain(worktree, "commit", "-q", "-am", "other work, part two");
  const others = plain(worktree, "rev-list", `${walked}..HEAD`).split("\n");
  plain(worktree, "switch", "-q", "self-x");
  new ContractBook(app.store.sqlite).create(owner, { taskRunId: "run-1", sourceSha: base, worktreePath: folder, terms: {
    allowedPaths: ["src/ui/**"], permissions: ["github.pull_request_from_changes", "github.open_pull_request"],
    expectedTests: ["tests/ui.test.mjs"], definitionOfDone: "The new control is there", sideEffects: ["a draft pull request"],
    rollbackPlan: "Close the pull request" } });
  savePullRequestHookSettings(app.store, owner, { mode: "when-needed" });
  app.registry.register({ name: "github.open_pull_request", permission: "github.manage", description: "stand-in for GitHub",
    parameters: z.object({}).passthrough(), execute: async (args) => args });
  app.store.projects.save(owner, { id: "branch-agent-self-x", name: "Branch Agent: self-x", instructions: "", modelPreset: null,
    repository: "acme/widgets", folder, profile: null, knowledgeBases: [], branch: "" });
  app.store.projects.setActive(owner, { active: "branch-agent-self-x" });
  const change = () => writeFile(join(worktree, "src", "ui", "new.ts"), "export const control = true;\n");
  await change();
  return { app, owner, worktree, walked, others, other: others[0], change };
}

/**
 * The hook's own dependencies with real Git. `before` runs just before each Git command (the push
 * included) and `after` right after one. The push itself is a stand-in: it reads the commit Git would
 * send at that moment and its history, then leaves what a real push leaves (the remote-tracking ref,
 * and the upstream when `--set-upstream` names a branch).
 */
function hookDeps(app, owner, hooks = {}) {
  const runner = new GitRunner();
  const calls = [], pushed = [], opened = [];
  const git = async (options, signal) => {
    const args = options.args;
    calls.push(args);
    await hooks.before?.(args);
    if (args[0] === "push") {
      const [from, to] = args.at(-1).split(":");
      const sent = plain(options.cwd, "rev-parse", "--verify", `${from}^{commit}`);
      pushed.push({ refspec: args.at(-1), sent, history: plain(options.cwd, "rev-list", sent).split("\n") });
      const name = to.replace(/^refs\/heads\//, "");
      plain(options.cwd, "update-ref", `refs/remotes/origin/${name}`, sent);
      if (args.includes("--set-upstream") && from.startsWith("refs/heads/")) {
        plain(options.cwd, "config", `branch.${from.slice("refs/heads/".length)}.remote`, args.at(-2));
        plain(options.cwd, "config", `branch.${from.slice("refs/heads/".length)}.merge`, to);
      }
      return { status: "completed", stdout: "", stderr: "", exitCode: 0, command: "git push" };
    }
    const outcome = await runner.run(options, signal);
    await hooks.after?.(args, options.cwd);
    return outcome;
  };
  return {
    calls, pushed, opened,
    value: { store: app.store, owner, files: app.files, git, registry: app.registry,
      policy: new NetworkPolicy({ allowPrivateAddresses: true }),
      runTool: async (name, args) => { opened.push({ name, args }); return { number: 7 }; } },
  };
}
const committed = (args) => args[0] === "--literal-pathspecs" && args[1] === "commit";
const ask = (name) => ({ name, title: "Add the new control", summary: "Why merge this: the new control is needed.",
  paths: ["src/ui/new.ts"], signal: AbortSignal.timeout(60_000) });

test("from Branch's own source, the pull request sends the checked commit plus one new commit, and the new branch tracks what was sent",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked, others } = await sourceWorktree(t);
    const d = hookDeps(app, owner);
    const opened = await pullRequestFromChanges(d.value, ask("pinned"));
    assert.equal(opened.branch, "branch/pinned");
    const made = plain(worktree, "rev-parse", "refs/heads/branch/pinned");
    assert.equal(plain(worktree, "rev-parse", `${made}^`), walked, "one new commit, right on the checked one");
    assert.deepEqual(plain(worktree, "diff-tree", "-r", "--no-commit-id", "--name-only", walked, made).split("\n"), ["src/ui/new.ts"]);
    assert.equal(d.pushed.length, 1);
    assert.equal(d.pushed[0].sent, made, "the new commit is what is sent");
    assert.equal(d.pushed[0].refspec.split(":")[1], "refs/heads/branch/pinned", "to a branch of the same name");
    assert.equal(others.some((commit) => d.pushed[0].history.includes(commit)), false);
    assert.deepEqual([plain(worktree, "config", "branch.branch/pinned.remote"), plain(worktree, "config", "branch.branch/pinned.merge")],
      ["origin", "refs/heads/branch/pinned"], "the new branch tracks the branch it was sent to, as before");
    assert.deepEqual(d.opened.map((each) => [each.name, each.args.head, each.args.base]), [["github.open_pull_request", "branch/pinned", "main"]]);
  });

test("from Branch's own source, the new branch starts at the commit the contract checked, wherever HEAD has been moved since",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked, other, others, change } = await sourceWorktree(t);
    const moves = {
      "another branch is switched to": () => plain(worktree, "switch", "-q", "owner-extra"),
      "the branch in use is reset to other work": () => plain(worktree, "reset", "-q", "--hard", other),
    };
    let count = 0;
    for (const [what, move] of Object.entries(moves)) {
      plain(worktree, "switch", "-q", "-f", "self-x");
      plain(worktree, "reset", "-q", "--hard", walked);
      await change();
      let moved = false;
      const d = hookDeps(app, owner, { before: (args) => {
        if (!moved && args[0] === "switch" && args[1] === "--create") { moved = true; move(); }
      } });
      const head = `branch/pinned-${++count}`;
      await pullRequestFromChanges(d.value, ask(`pinned-${count}`));
      assert.equal(moved, true, what);
      assert.equal(d.pushed.length, 1, what);
      const [{ sent, history }] = d.pushed;
      assert.equal(others.some((commit) => history.includes(commit)), false, `${what}: the other work never reaches the push`);
      assert.equal(plain(worktree, "rev-parse", `${sent}^`), walked, `${what}: one new commit, right on the checked one`);
      assert.equal(plain(worktree, "rev-parse", `refs/heads/${head}`), sent, `${what}: the new branch holds what was sent`);
      assert.equal(d.opened.length, 1, what);
    }
  });

test("from Branch's own source, the push sends the new commit itself, wherever its branch points by the time Git sends",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, other, others } = await sourceWorktree(t);
    let made = "";
    const d = hookDeps(app, owner, {
      after: (args) => { if (committed(args)) made = plain(worktree, "rev-parse", "refs/heads/branch/pinned"); },
      before: (args) => { if (args[0] === "push") plain(worktree, "update-ref", "refs/heads/branch/pinned", other); },
    });
    await pullRequestFromChanges(d.value, ask("pinned"));
    assert.ok(made, "the commit was made");
    assert.equal(d.pushed.length, 1);
    assert.equal(d.pushed[0].sent, made, "the commit made is what is sent, not what the branch was moved to");
    assert.equal(d.pushed[0].refspec, `${made}:refs/heads/branch/pinned`);
    assert.equal(others.some((commit) => d.pushed[0].history.includes(commit)), false);
  });

test("from Branch's own source, a new branch that is not one new commit on the checked work is refused, and nothing is sent",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, other } = await sourceWorktree(t);
    const d = hookDeps(app, owner, {
      after: (args) => { if (committed(args)) plain(worktree, "update-ref", "refs/heads/branch/pinned", other); },
    });
    await assert.rejects(pullRequestFromChanges(d.value, ask("pinned")),
      /"branch\/pinned" is not just one new commit on the checked work .*so nothing was sent/);
    assert.deepEqual(d.pushed, [], "nothing was sent");
    assert.deepEqual(d.opened, [], "no pull request was opened");
  });

test("from Branch's own source, the new commit is read from its own branch, not from whatever HEAD points at by then",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked } = await sourceWorktree(t);
    // Other work that sits right on the checked commit too, made the way Branch's own Git tools can.
    plain(worktree, "switch", "-q", "-c", "side");
    await writeFile(join(worktree, "src", "ui", "side.ts"), "export const side = 1;\n");
    plain(worktree, "add", "src/ui/side.ts");
    plain(worktree, "commit", "-q", "-m", "side work");
    const side = plain(worktree, "rev-parse", "HEAD");
    plain(worktree, "switch", "-q", "self-x");
    let made = "";
    const d = hookDeps(app, owner, {
      after: (args) => {
        if (!committed(args)) return;
        made = plain(worktree, "rev-parse", "refs/heads/branch/pinned");
        plain(worktree, "switch", "-q", "side");
      },
    });
    await pullRequestFromChanges(d.value, ask("pinned"));
    assert.equal(plain(worktree, "rev-parse", `${side}^`), walked);
    assert.equal(d.pushed.length, 1);
    assert.equal(d.pushed[0].sent, made, "the commit made, not the other branch HEAD was switched to");
    assert.equal(d.pushed[0].history.includes(side), false);
  });

test("from Branch's own source, a change outside the contract is still refused before any branch is made or anything sent",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree } = await sourceWorktree(t);
    await writeFile(join(worktree, "stray.mjs"), "export {};\n");
    const d = hookDeps(app, owner);
    await assert.rejects(pullRequestFromChanges(d.value, ask("pinned")), /changed files are outside the contract's allowed paths: stray\.mjs/);
    assert.deepEqual(d.calls.filter((args) => ["switch", "push"].includes(args[0]) || committed(args)), []);
    assert.deepEqual(d.opened, []);
  });

test("from Branch's own source, the commit walked is the one HEAD was read as, even when HEAD moves to clean work before the walk",
  { skip: posixOnly }, async (t) => {
    // HEAD is read on work outside the contract, then moved to clean work before the walk. A walk that read
    // HEAD again would find nothing wrong and send the commit read first, with the other work under it.
    const { app, owner, worktree, walked, other, change } = await sourceWorktree(t);
    plain(worktree, "reset", "-q", "--hard", other);
    await change();
    let moved = false;
    const d = hookDeps(app, owner, { after: (args) => {
      if (!moved && args.join(" ") === "rev-parse --verify --quiet HEAD^{commit}") { moved = true; plain(worktree, "reset", "-q", "--hard", walked); }
    } });
    await assert.rejects(pullRequestFromChanges(d.value, ask("pinned")), /changed files are outside the contract's allowed paths: \.github\/workflows\/extra\.yml/);
    assert.equal(moved, true, "HEAD was moved between the read and the walk");
    assert.deepEqual(d.pushed, [], "nothing was sent");
    assert.deepEqual(d.opened, [], "no pull request was opened");
  });

/** The hook reading which commit the new branch holds, right before that commit is sent. */
const readsBranch = (args, head) => args[0] === "rev-parse" && args.at(-1) === `refs/heads/${head}^{commit}`;

test("from Branch's own source, a new branch holding a merge is refused, even one on the checked commit that changes only the named file, and nothing is sent",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked, other, others } = await sourceWorktree(t);
    let merge = "";
    const d = hookDeps(app, owner, { before: (args) => {
      if (merge || !readsBranch(args, "branch/pinned")) return;
      // The new commit's own tree, on the checked commit (first parent) and the other work (second parent).
      merge = plain(worktree, "commit-tree", "refs/heads/branch/pinned^{tree}", "-p", walked, "-p", other, "-m", "merge");
      plain(worktree, "update-ref", "refs/heads/branch/pinned", merge);
    } });
    await assert.rejects(pullRequestFromChanges(d.value, ask("pinned")),
      /"branch\/pinned" is not just one new commit on the checked work .*so nothing was sent/);
    assert.ok(merge, "the branch held the merge when it was read");
    assert.deepEqual(plain(worktree, "diff-tree", "-r", "--no-commit-id", "--name-only", walked, merge).split("\n"), ["src/ui/new.ts"],
      "against the checked commit, the merge changes only the named file");
    assert.equal(others.every((commit) => plain(worktree, "rev-list", merge).split("\n").includes(commit)), true, "its history holds the other work");
    assert.deepEqual(d.pushed, [], "nothing was sent");
    assert.deepEqual(d.opened, [], "no pull request was opened");
  });

test("from Branch's own source, a new commit that sits on other work is refused, even when against the checked commit it changes only the named file",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked, other, others } = await sourceWorktree(t);
    let moved = "";
    const d = hookDeps(app, owner, { before: (args) => {
      if (moved || !readsBranch(args, "branch/pinned")) return;
      // The other work, then the checked files again, then the new commit's own tree: one parent, but not the checked commit.
      const back = plain(worktree, "commit-tree", `${walked}^{tree}`, "-p", other, "-m", "the checked files again");
      moved = plain(worktree, "commit-tree", "refs/heads/branch/pinned^{tree}", "-p", back, "-m", "the new commit, on other work");
      plain(worktree, "update-ref", "refs/heads/branch/pinned", moved);
    } });
    await assert.rejects(pullRequestFromChanges(d.value, ask("pinned")),
      /"branch\/pinned" is not just one new commit on the checked work .*so nothing was sent/);
    assert.ok(moved, "the branch held the commit on other work when it was read");
    assert.equal(plain(worktree, "rev-list", "--parents", "--max-count=1", moved).split(" ").length, 2, "one parent");
    assert.deepEqual(plain(worktree, "diff-tree", "-r", "--no-commit-id", "--name-only", walked, moved).split("\n"), ["src/ui/new.ts"],
      "against the checked commit, it changes only the named file");
    assert.equal(others.every((commit) => plain(worktree, "rev-list", moved).split("\n").includes(commit)), true, "its history holds the other work");
    assert.deepEqual(d.pushed, [], "nothing was sent");
    assert.deepEqual(d.opened, [], "no pull request was opened");
  });

test("from Branch's own source, a new commit that also changes a file the pull request does not name is refused, and nothing is sent",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked, change } = await sourceWorktree(t);
    const extras = {
      "a file the contract does not allow": ".github/workflows/extra.yml",
      "a file the contract allows but the pull request does not name": "src/ui/stray.ts",
    };
    let count = 0;
    for (const [what, extra] of Object.entries(extras)) {
      plain(worktree, "switch", "-q", "-f", "self-x");
      plain(worktree, "reset", "-q", "--hard", walked);
      await change();
      const head = `branch/pinned-${++count}`;
      let amended = "";
      const d = hookDeps(app, owner, { before: async (args) => {
        if (amended || !readsBranch(args, head)) return;
        // The new commit, amended to hold one more file: still one commit, right on the checked one.
        await mkdir(dirname(join(worktree, extra)), { recursive: true });
        await writeFile(join(worktree, extra), "more\n");
        plain(worktree, "add", "--", extra);
        plain(worktree, "commit", "-q", "--amend", "--no-edit");
        amended = plain(worktree, "rev-parse", `refs/heads/${head}`);
      } });
      await assert.rejects(pullRequestFromChanges(d.value, ask(`pinned-${count}`)),
        /is not just one new commit on the checked work .*so nothing was sent/, what);
      assert.ok(amended, `${what}: the branch held the amended commit when it was read`);
      assert.equal(plain(worktree, "rev-parse", `${amended}^`), walked, `${what}: one commit, right on the checked one`);
      assert.deepEqual(plain(worktree, "diff-tree", "-r", "--no-commit-id", "--name-only", walked, amended).split("\n").sort(),
        [extra, "src/ui/new.ts"].sort(), `${what}: the named file and the other one`);
      assert.deepEqual(d.pushed, [], `${what}: nothing was sent`);
      assert.deepEqual(d.opened, [], `${what}: no pull request was opened`);
    }
  });

test("from Branch's own source, a new commit that also changes a submodule pointer the pull request does not name is refused, whatever the submodule settings say",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked } = await sourceWorktree(t);
    let amended = "";
    const d = hookDeps(app, owner, { before: async (args) => {
      if (amended || !readsBranch(args, "branch/pinned")) return;
      // The new commit, amended to point a submodule at vendor/lib as well, with settings that say to
      // ignore that submodule: still one commit, right on the checked one.
      await writeFile(join(worktree, ".gitmodules"), "[submodule \"lib\"]\n\tpath = vendor/lib\n\turl = ./lib\n\tignore = all\n");
      plain(worktree, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/lib`);
      plain(worktree, "commit", "-q", "--amend", "--no-edit");
      amended = plain(worktree, "rev-parse", "refs/heads/branch/pinned");
    } });
    await assert.rejects(pullRequestFromChanges(d.value, ask("pinned")),
      /"branch\/pinned" is not just one new commit on the checked work .*so nothing was sent/);
    assert.ok(amended, "the branch held the amended commit when it was read");
    assert.equal(plain(worktree, "rev-parse", `${amended}^`), walked, "one commit, right on the checked one");
    assert.deepEqual(plain(worktree, "diff-tree", "-r", "--no-commit-id", "--name-only", "--ignore-submodules=none", walked, amended).split("\n"),
      ["src/ui/new.ts", "vendor/lib"], "the named file and the submodule pointer");
    assert.deepEqual(d.pushed, [], "nothing was sent");
    assert.deepEqual(d.opened, [], "no pull request was opened");
  });

test("from Branch's own source, a new commit holding only the named files is sent, with a file removed as well as one added and names written with ./",
  { skip: posixOnly }, async (t) => {
    const { app, owner, worktree, walked } = await sourceWorktree(t);
    await rm(join(worktree, "src", "ui", "button.ts"));
    const d = hookDeps(app, owner);
    const opened = await pullRequestFromChanges(d.value, { ...ask("pinned"), paths: ["./src/ui/new.ts", "src/./ui/button.ts"] });
    assert.deepEqual(opened.files, ["./src/ui/new.ts", "src/./ui/button.ts"]);
    const made = plain(worktree, "rev-parse", "refs/heads/branch/pinned");
    assert.equal(plain(worktree, "rev-parse", `${made}^`), walked, "one new commit, right on the checked one");
    assert.deepEqual(plain(worktree, "diff-tree", "-r", "--no-commit-id", "--name-status", walked, made).split("\n"),
      ["D\tsrc/ui/button.ts", "A\tsrc/ui/new.ts"]);
    assert.equal(d.pushed.length, 1);
    assert.equal(d.pushed[0].sent, made, "exactly the new commit is sent");
    assert.deepEqual(d.opened.map((each) => each.args.head), ["branch/pinned"]);
  });
