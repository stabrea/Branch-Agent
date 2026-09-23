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
import { ContractBook } from "../dist/self-development-contract.js";
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
  app.store.projects.save(owner, { id: project === "notes" ? "notes" : "branch-agent-remove-button", name: project, instructions: "",
    modelPreset: null, repository: "", folder: project === "notes" ? "notes" : worktree, profile: null, knowledgeBases: [], branch: "" });
  app.store.projects.setActive(owner, { active: project === "notes" ? "notes" : "branch-agent-remove-button" });
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
