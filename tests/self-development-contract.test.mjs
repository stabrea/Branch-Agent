/**
 * Q12: Branch changing its own source is held to a contract written before the first change.
 *
 *   1. a write inside the contract's allowed paths goes ahead                       (real runtime)
 *   2. a write outside them is refused and written in the audit record              (real runtime)
 *   3. a remote Git step the contract does not list is refused and audited          (real runtime, git double)
 *   4. with no contract, every change in the worktree is refused                    (real runtime)
 *   5. a contract cannot be changed: no update call, the table refuses edits, and a
 *      row changed behind its back fails its hash check (and the guard refuses)
 *   6. widening without the owner's yes changes nothing; with it, a new revision is
 *      written, the old one stays readable, and the widening is audited            (real runtime)
 *   7. a remote step is checked against the source commit and every changed file    (guard with a git double)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch, savePolicy } from "../dist/index.js";
import { AuditLog } from "../dist/audit.js";
import { ToolRegistry } from "../dist/registry.js";
import { ContractBook, contractGuard, globFits } from "../dist/self-development-contract.js";
import { discardTemp } from "./temp-dir.mjs";

const worktree = "branch-agent-source/.branch-worktrees/self-remove-button";
const sha = "b".repeat(40);
const terms = {
  allowedPaths: ["src/ui/**"], permissions: ["files.write"], expectedTests: ["tests/ui.test.mjs"],
  definitionOfDone: "The button is gone and its test passes", sideEffects: ["none outside the worktree"],
  rollbackPlan: "Remove the worktree and its branch",
};

/** A real Branch whose model makes the given tool calls, one per round, then stops. */
async function realBranch(t, calls) {
  const root = await mkdtemp(join(tmpdir(), "branch-self-contract-"));
  let at = 0;
  const provider = {
    name: "scripted",
    async complete() {
      const call = calls[at++];
      return call ? { content: "", toolCalls: [{ id: `call-${at}`, name: call.name, arguments: JSON.stringify(call.args) }] }
        : { content: "Done.", toolCalls: [] };
    },
  };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  const pushed = [];
  // The test double for sending work to GitHub: it only notes that it was reached.
  app.registry.register({ name: "git.push", permission: "git.remote", description: "test double", parameters: z.object({}).passthrough(),
    execute: async (args) => { pushed.push(args); return { pushed: true }; } });
  const owner = app.runtime.owner;
  app.store.projects.save(owner, { id: "branch-agent-remove-button", name: "Branch Agent: remove-button", instructions: "",
    modelPreset: null, repository: "stabrea/Branch-Agent", folder: worktree, profile: null, knowledgeBases: [], branch: "" });
  app.store.projects.setActive(owner, { active: "branch-agent-remove-button" });
  const book = new ContractBook(app.store.sqlite);
  return {
    app, owner, book, pushed, workspace: join(root, "workspace"),
    ask: (sessionId) => { at = 0; return app.runtime.run({ prompt: "Remove the button", ...(sessionId ? { sessionId } : {}) }); },
    refusals: () => app.store.audit.list(owner, { action: "self_development.contract" }),
  };
}

const failures = (app, run) => app.store.events(run.id).filter((event) => event.kind === "tool.failed").map((event) => event.data.error);

test("a write inside the contract's allowed paths goes ahead", async (t) => {
  const branch = await realBranch(t, [{ name: "files.write", args: { path: "src/ui/button.ts", content: "export {};\n" } }]);
  branch.book.create(branch.owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  const run = await branch.ask();
  assert.equal(run.status, "completed", run.output);
  assert.deepEqual(failures(branch.app, run), []);
  assert.ok(existsSync(join(branch.workspace, worktree, "src/ui/button.ts")), "the file was written in the worktree");
  assert.deepEqual(branch.refusals(), []);
});

test("a write outside the allowed paths is refused and audited", async (t) => {
  const branch = await realBranch(t, [{ name: "files.write", args: { path: "package.json", content: "{}" } }]);
  branch.book.create(branch.owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  const run = await branch.ask();
  assert.match(failures(branch.app, run).join("\n"), /self-development contract: package\.json is outside the contract's allowed paths/);
  assert.equal(existsSync(join(branch.workspace, worktree, "package.json")), false, "nothing was written");
  const [entry] = branch.refusals();
  assert.equal(entry?.outcome, "refused");
  assert.match(entry.subject, /files\.write in branch-agent-source\/\.branch-worktrees\/self-remove-button/);
  assert.equal(entry.runId, run.id);
});

test("a remote Git step the contract does not list is refused and audited before Git is reached", async (t) => {
  const branch = await realBranch(t, [{ name: "git.push", args: { remote: "origin" } }]);
  branch.book.create(branch.owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  const run = await branch.ask();
  assert.match(failures(branch.app, run).join("\n"), /git\.push is not one of the tools this contract allows/);
  assert.deepEqual(branch.pushed, [], "the Git double was never reached");
  assert.match(branch.refusals()[0]?.subject ?? "", /^git\.push in /);
});

test("with no contract, every change in the worktree and the protected checkout is refused", async (t) => {
  const branch = await realBranch(t, [
    { name: "files.write", args: { path: "src/ui/button.ts", content: "x" } },
    { name: "git.push", args: { remote: "origin" } },
  ]);
  const run = await branch.ask();
  const errors = failures(branch.app, run);
  assert.equal(errors.length, 2, errors.join("\n"));
  assert.ok(errors.every((error) => /no contract/.test(error)), errors.join("\n"));
  assert.deepEqual(branch.pushed, []);
  assert.equal(existsSync(join(branch.workspace, worktree, "src/ui/button.ts")), false);
  assert.equal(branch.refusals().length, 2);
  // From the workspace itself, the protected checkout is never written, contract or not.
  const direct = contractGuard({ store: branch.app.store, owner: branch.owner, workspace: branch.workspace,
    registry: branch.app.registry, book: branch.book, git: async () => { throw new Error("not reached"); } });
  branch.app.registry.pathScope = () => "";
  await assert.rejects(direct("files.write", { path: "branch-agent-source/src/main.ts", content: "x" }, { runId: "r" }),
    /protected Branch Agent source checkout is never changed directly/);
});

test("a contract cannot be changed, and a row changed behind its back fails its hash check", async (t) => {
  const branch = await realBranch(t, [{ name: "files.write", args: { path: "src/ui/button.ts", content: "x" } }]);
  const first = branch.book.create(branch.owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  assert.equal(typeof branch.book.update, "undefined", "there is no update call");
  assert.throws(() => branch.book.create(branch.owner, { taskRunId: "run-2", sourceSha: sha, worktreePath: worktree,
    terms: { ...terms, allowedPaths: ["**"] } }), /already has a contract/);
  const db = branch.app.store.sqlite;
  assert.throws(() => db.prepare("UPDATE self_development_contracts SET body=?").run("{}"), /cannot be changed/);
  assert.throws(() => db.prepare("DELETE FROM self_development_contracts").run(), /cannot be removed/);
  assert.deepEqual(branch.book.current(branch.owner, worktree), first);
  // Someone with the database file in hand drops the rule and widens the paths by editing the row.
  db.exec("DROP TRIGGER self_development_contracts_no_update");
  const forged = JSON.stringify({ ...first, allowedPaths: ["**"] });
  db.prepare("UPDATE self_development_contracts SET body=? WHERE worktree=?").run(forged, worktree);
  assert.throws(() => branch.book.current(branch.owner, worktree), /does not match its hash/);
  const run = await branch.ask();
  assert.match(failures(branch.app, run).join("\n"), /does not match its hash/);
  assert.equal(branch.refusals()[0]?.outcome, "refused");
});

test("a forged extra revision with a wrong hash is caught", () => {
  const db = new DatabaseSync(":memory:");
  const book = new ContractBook(db);
  const first = book.create("local", { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  db.prepare("INSERT INTO self_development_contracts(owner, worktree, revision, body, hash, created_at) VALUES(?,?,?,?,?,?)")
    .run("local", worktree, 2, JSON.stringify({ ...first, revision: 2, allowedPaths: ["**"] }), "0".repeat(64), first.createdAt);
  assert.throws(() => book.history("local", worktree), /revision 2\) does not match its hash/);
});

test("widening needs the owner's yes every time, and then writes a new revision and audits it", async (t) => {
  const branch = await realBranch(t, [{ name: "branch.widen_source_contract",
    args: { name: "remove-button", reason: "The button's test lives under tests/", changes: { allowedPaths: ["src/ui/**", "tests/ui.test.mjs"] } } }]);
  branch.book.create(branch.owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms });
  const paused = await branch.ask();
  assert.equal(paused.status, "needs_input", paused.output);
  assert.equal(branch.book.history(branch.owner, worktree).length, 1, "nothing is widened before the owner answers");
  const waiting = branch.app.runtime.approvals.questionFor(paused.sessionId);
  assert.equal(waiting.tool, "branch.widen_source_contract");
  assert.equal(waiting.remember, "never", "a yes to widening is never kept");
  assert.throws(() => branch.app.runtime.approve(paused.sessionId, "allow", "session"), /once|kept|remember|time/i);
  branch.app.runtime.approve(paused.sessionId, "allow", "never");
  const done = await branch.ask(paused.sessionId);
  assert.equal(done.status, "completed", done.output);
  const history = branch.book.history(branch.owner, worktree);
  assert.equal(history.length, 2);
  assert.deepEqual(history[0].allowedPaths, ["src/ui/**"], "the old revision stays readable, unchanged");
  assert.deepEqual(history[1].allowedPaths, ["src/ui/**", "tests/ui.test.mjs"]);
  assert.equal(history[1].sourceSha, sha, "widening never moves the source commit");
  assert.equal(history[1].approvedBy, branch.owner);
  const widened = branch.refusals().find((entry) => entry.outcome === "widened");
  assert.match(widened?.subject ?? "", /self-remove-button revision 2/);
  // Asking again is a new question: the yes was used up.
  const again = await branch.ask(paused.sessionId);
  assert.equal(again.status, "needs_input", again.output);
  assert.equal(branch.book.history(branch.owner, worktree).length, 2);
});

/** The guard alone, with a registry of test tools and a Git double that answers as told. */
function guardWith(git) {
  const db = new DatabaseSync(":memory:");
  const book = new ContractBook(db);
  const log = new AuditLog(db);
  const registry = new ToolRegistry();
  registry.pathScope = () => worktree;
  registry.register({ name: "github.pull_request_from_changes", permission: "github.manage", description: "double",
    parameters: z.object({ name: z.string() }), execute: async () => ({}) });
  book.create("local", { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree,
    terms: { ...terms, permissions: ["files.write", "github.pull_request_from_changes"] } });
  const calls = [];
  const guard = contractGuard({ store: { audit: log }, owner: "local", workspace: "/w", registry, book,
    git: async (options) => { calls.push(options.args.join(" ")); return git(options.args); } });
  return { guard, calls, log };
}
const answer = (stdout = "", status = "completed") => ({ status, stdout, stderr: "", exitCode: status === "completed" ? 0 : 1, command: "git" });
const pr = { name: "remove-button" };

test("a remote step is checked against the source commit and every changed file", async () => {
  const clean = guardWith((args) => args[0] === "diff" ? answer("src/ui/button.ts\0") : answer(""));
  await clean.guard("github.pull_request_from_changes", pr, { runId: "r", signal: AbortSignal.timeout(1000) });
  assert.ok(clean.calls.includes(`merge-base --is-ancestor ${sha} HEAD`), clean.calls.join("\n"));

  const moved = guardWith((args) => args[0] === "merge-base" ? answer("", "failed") : answer(""));
  await assert.rejects(moved.guard("github.pull_request_from_changes", pr, { runId: "r", signal: AbortSignal.timeout(1000) }),
    /no longer starts from the contract's source commit/);

  const stray = guardWith((args) => args[0] === "ls-files" ? answer("src/ui/ok.ts\0scripts/postinstall.mjs\0") : answer(""));
  await assert.rejects(stray.guard("github.pull_request_from_changes", pr, { runId: "r", signal: AbortSignal.timeout(1000) }),
    /changed files are outside the contract's allowed paths: scripts\/postinstall\.mjs/);
  assert.equal(stray.log.list("local", { action: "self_development.contract" })[0]?.outcome, "refused");
});

test("allowed paths are globs inside the worktree", () => {
  assert.equal(globFits("src/ui/**", "src/ui/a/b.ts"), true);
  assert.equal(globFits("src/ui/*.ts", "src/ui/a/b.ts"), false);
  assert.equal(globFits("src/**/button.ts", "src/button.ts"), true);
  assert.equal(globFits("tests/", "tests/x.test.mjs"), true);
  assert.equal(globFits("src/ui/**", "src/uix/a.ts"), false);
  assert.equal(globFits("src/ui.ts", "src/uiXts"), false);
});
