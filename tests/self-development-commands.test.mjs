/**
 * Q12: commands and Branch's own source. A command's text cannot be read reliably (globs, variables),
 * so it is never parsed. The folder it runs in is judged exactly where the shell tool runs it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, savePolicy } from "../dist/index.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";
import { ContractBook, contractGuard } from "../dist/self-development-contract.js";
import { wallReport } from "../dist/sandbox-backends.js";
import { AuditLog } from "../dist/audit.js";
import { ToolRegistry } from "../dist/registry.js";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";

const sha = "e".repeat(40);
const worktree = "branch-agent-source/.branch-worktrees/self-remove-button";
const original = "export const main = 1;\n";

/** A real Branch with a shell (`sh`), Branch's source checked out, a worktree, and a model that runs the given commands. */
export async function withSource(t, options = {}) {
  let commands = [];
  const root = await mkdtemp(join(tmpdir(), "branch-self-commands-"));
  let at = 0;
  const provider = { name: "scripted", async complete() {
    const call = commands[at++];
    return call ? { content: "", toolCalls: [{ id: `c${at}`, name: "shell.execute", arguments: JSON.stringify(call) }] } : { content: "Done.", toolCalls: [] };
  } };
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  const config = join(root, "integrations.json");
  await writeFile(config, JSON.stringify({ shell: { executables: { sh: { path: "/bin/sh", args: [] } }, timeoutMs: 10000 } }));
  const integrations = await loadIntegrations(app.registry, config, process.env, app.secretsFor, app.channelHost);
  t.after(async () => { await integrations.close(); await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  savePolicy(app.store, owner, { preset: "off", unmatchedCommands: "allow" });
  await mkdir(join(workspace, "branch-agent-source", "src"), { recursive: true });
  await writeFile(join(workspace, "branch-agent-source", "src", "main.ts"), original);
  await mkdir(join(workspace, worktree, "src", "ui"), { recursive: true });
  await mkdir(join(workspace, "notes"), { recursive: true });
  const project = options.project ?? "notes";
  if (project !== "none") app.store.projects.save(owner, { id: project === "notes" ? "notes" : "branch-agent-remove-button", name: project, instructions: "",
    modelPreset: null, repository: "", folder: project === "notes" ? "notes" : worktree, profile: null, knowledgeBases: [], branch: "" });
  if (project !== "none") app.store.projects.setActive(owner, { active: project === "notes" ? "notes" : "branch-agent-remove-button" });
  if (options.permissions) new ContractBook(app.store.sqlite).create(owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms: {
    allowedPaths: ["src/ui/**", "notes.txt"], permissions: options.permissions, expectedTests: ["tests/ui.test.mjs"], definitionOfDone: "done",
    sideEffects: [], rollbackPlan: "Remove the worktree" } });
  /** One fresh conversation whose model runs this one command. */
  const command = async (call) => {
    commands = [call]; at = 0;
    const run = await app.runtime.run({ prompt: "Run it" });
    const events = app.store.events(run.id);
    return { run, failed: events.filter((event) => event.kind === "tool.failed").map((event) => event.data.error)[0] ?? null,
      result: events.find((event) => event.kind === "tool.completed")?.data.result ?? null };
  };
  return {
    app, workspace, command,
    protectedFile: () => readFile(join(workspace, "branch-agent-source", "src", "main.ts"), "utf8"),
    refusals: () => app.store.audit.list(owner, { action: "self_development.contract" }).filter((entry) => entry.outcome === "refused"),
  };
}

test("a command's folder is judged where the shell runs it, not inside the active project", { skip: process.platform === "win32" }, async (t) => {
  const branch = await withSource(t, { permissions: ["files.write"] });
  for (const cwd of [worktree, "branch-agent-source"]) {
    const { failed } = await branch.command({ executable: "sh", args: ["-c", "echo PWNED > marker.txt"], cwd });
    assert.match(failed ?? "", /self-development contract/, cwd);
  }
  assert.equal(existsSync(join(branch.workspace, worktree, "marker.txt")), false, "nothing written in the worktree");
  assert.equal(existsSync(join(branch.workspace, "branch-agent-source", "marker.txt")), false, "nothing written in the checkout");
  assert.equal(branch.refusals().length, 2);
});

/** NAS's repro: a glob names the protected checkout, so no reading of the command's text could catch it. */
export const globRepro = { executable: "sh", args: ["-c", "for f in branch?agent-source/src/main.ts; do echo PWNED >> $f; done"] };

test("while Branch's source is checked out, a command outside a worktree is refused and audited, whatever its text", { skip: process.platform === "win32" }, async (t) => {
  const branch = await withSource(t, { project: "none" });
  const { failed, result } = await branch.command(globRepro);
  assert.equal(result, null, "the command never ran");
  assert.match(failed ?? "", /While Branch's own source is checked out in this workspace, a command runs only inside the active self-development worktree/);
  assert.equal(await branch.protectedFile(), original, "the protected file is unchanged");
  const [entry] = branch.refusals();
  assert.match(entry?.subject ?? "", /^shell\.execute in /);
  assert.equal(entry.source, "system");
});

test("a command in the worktree, listed in its contract, runs behind the real OS sandbox with writes held to the worktree",
  { skip: process.platform === "win32" || !(await wallReport()).available }, async (t) => {
  const branch = await withSource(t, { project: "worktree", permissions: ["shell.execute"] });
  const { failed, result } = await branch.command({ executable: "sh", cwd: worktree,
    args: ["-c", "echo ok > src/ui/inside.txt; echo PWNED >> ../../src/main.ts; for f in ../../src/main.ts; do echo PWNED >> $f; done"] });
  assert.equal(failed, null, failed);
  assert.equal(await readFile(join(branch.workspace, worktree, "src", "ui", "inside.txt"), "utf8"), "ok\n", "a write in the worktree works");
  assert.equal(await branch.protectedFile(), original, "the sandbox blocked the write to the protected checkout");
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.target.cwd.endsWith("self-remove-button"), true);
});

/** The guard alone with a stand-in sandbox check: `confinement` is a test double for "this computer can hold writes to one folder". */
function guardWith(t, confinement) {
  return (async () => {
    const root = await mkdtemp(join(tmpdir(), "branch-self-confine-"));
    t.after(() => discardTemp(root));
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, worktree), { recursive: true });
    const db = new DatabaseSync(":memory:");
    const book = new ContractBook(db), log = new AuditLog(db), registry = new ToolRegistry();
    registry.pathScope = () => worktree;
    for (const [name, permission] of [["shell.execute", "shell.execute"], ["code.run", "code.execute"], ["process.start", "process.manage"]])
      registry.register({ name, permission, description: "double", parameters: z.object({ cwd: z.string().optional() }).passthrough(), execute: async () => ({}) });
    book.create("local", { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms: { allowedPaths: ["src/**"],
      permissions: ["shell.execute", "code.run", "process.start"], expectedTests: ["t"], definitionOfDone: "d", sideEffects: [], rollbackPlan: "r" } });
    const guard = contractGuard({ store: { audit: log }, owner: "local", workspace, registry, book, git: async () => { throw new Error("no git"); }, confinement });
    return { guard, log, workspace };
  })();
}

test("the stand-in sandbox: available holds the command to the worktree, missing refuses every command plainly", async (t) => {
  const yes = await guardWith(t, async () => true);
  const held = await yes.guard("shell.execute", { cwd: worktree }, { runId: "r" });
  assert.equal(held.writesConfinedTo, join(yes.workspace, worktree));
  for (const name of ["code.run", "process.start"])
    await assert.rejects(yes.guard(name, { cwd: worktree }, { runId: "r" }), /cannot hold the program it starts to one folder/, name);
  const no = await guardWith(t, async () => false);
  await assert.rejects(no.guard("shell.execute", { cwd: worktree }, { runId: "r" }),
    /commands are refused on this computer: it has no sandbox that can hold a command's writes to one folder/);
  assert.equal(no.log.list("local", { action: "self_development.contract" }).length, 1);
});
