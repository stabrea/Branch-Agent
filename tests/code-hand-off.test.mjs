import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { HandOff, claudeAllowedCommands, programCall, readClaude, readCodex } from "../dist/coding/hand-off.js";

/**
 * Branch builds Branch: a coding job handed to the owner's own Claude Code or Codex, inside one folder. The program
 * is a stand-in here (it edits files the way the real one would, and prints what the real one prints), so what is
 * proved is Branch's side: which program is started and how it is held, what is read back, and that inside Branch's
 * own source nothing outside the contract survives the job.
 */

const owner = "local";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-hand-off-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Noted.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const git = async ({ cwd, args }) => {
    try { return { status: "completed", stdout: execFileSync("git", args, { cwd, encoding: "utf8" }), stderr: "" }; }
    catch (error) { return { status: "failed", stdout: "", stderr: String(error.stderr ?? error.message) }; }
  };
  const calls = [];
  const handOff = (run) => new HandOff({ store: app.store, owner, workspace: join(root, "workspace"), dataDir: join(root, "data"),
    book: new ContractBook(app.store.sqlite), git, run: async (call, prompt, env, signal, timeoutMs, onLine) => {
      calls.push({ call, prompt, env });
      return run(call, onLine);
    } });
  return { app, root, workspace: join(root, "workspace"), dataDir: join(root, "data"), handOff, calls };
}

async function repository(folder, files = { "README.md": "hello\n", "src/a.ts": "export const a = 1;\n" }) {
  await mkdir(join(folder, "src"), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(folder, name), text);
  const git = (...args) => execFileSync("git", args, { cwd: folder });
  git("init", "-q"); git("config", "core.autocrlf", "false"); git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "start");
}

const context = (app, extra = {}) => ({ owner, workspace: "", runId: app.store.createRun(owner, "a job for Claude Code").id,
  signal: new AbortController().signal, ...extra });
const claudeLines = (text) => [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }, { type: "text", text: "Editing." }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }),
];

test("Claude Code may edit in the folder and run only the checks and read-only Git; Codex writes only in its folder", () => {
  const claude = programCall("claude-code", "/work/repo");
  assert.equal(claude.cwd, "/work/repo");
  assert.deepEqual(claude.args.slice(claude.args.indexOf("--permission-mode"), claude.args.indexOf("--permission-mode") + 2), ["--permission-mode", "acceptEdits"]);
  assert.ok(!claude.args.includes("bypassPermissions") && !claude.args.some((arg) => /dangerously/.test(arg)));
  for (const allowed of claudeAllowedCommands) assert.doesNotMatch(allowed, /push|commit|curl|rm |npm install|gh /, `${allowed} does nothing that sends or removes`);
  const codex = programCall("codex", "/work/repo");
  assert.deepEqual(codex.args.slice(codex.args.indexOf("--sandbox"), codex.args.indexOf("--sandbox") + 2), ["--sandbox", "workspace-write"]);
  assert.deepEqual(codex.args.slice(codex.args.indexOf("--cd"), codex.args.indexOf("--cd") + 2), ["--cd", "/work/repo"]);
  assert.ok(!codex.args.some((arg) => /danger|bypass/.test(arg)));
});

test("what each program printed is read back: its last words, its steps, and a plan limit said as one", () => {
  const claude = readClaude(claudeLines("Fixed the typo; the tests pass."));
  assert.deepEqual([claude.summary, claude.steps, claude.failed, claude.limitReached], ["Fixed the typo; the tests pass.", ["Edit"], null, false]);
  const limited = readClaude([JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Claude usage limit reached" })]);
  assert.equal(limited.limitReached, true);
  const codex = readCodex([
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "node --test tests/a.test.mjs" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done." } }),
    "not json at all",
  ]);
  assert.deepEqual([codex.summary, codex.steps, codex.failed], ["Done.", ["node --test tests/a.test.mjs"], null]);
  assert.equal(readCodex([JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit" } })]).limitReached, true);
});

test("a job in a workspace repository is done by the program in that folder, and the answer names what changed", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  const job = context(f.app);
  const result = await f.handOff(async (call, onLine) => {
    await writeFile(join(call.cwd, "src", "a.ts"), "export const a = 2;\n");
    const lines = claudeLines("Changed a to 2.");
    lines.forEach(onLine);
    return { code: 0, lines, stderr: "", timedOut: false, missing: false };
  }).run({ program: "claude-code", folder: "site", task: "Set a to 2.", minutes: 5 }, job);
  assert.equal(result.status, "done");
  assert.equal(result.summary, "Changed a to 2.");
  assert.deepEqual(result.changed, ["src/a.ts"]);
  assert.equal(f.calls[0].call.cwd, join(f.workspace, "site"));
  assert.equal(f.calls[0].prompt, "Set a to 2.");
  const steps = f.app.store.events(job.runId).filter((event) => event.kind === "code.hand_off.step");
  assert.equal(steps.length, 2, "each line the program printed is shown on the task as it comes");
});

test("a folder outside the workspace, or one that is not a Git repository, is refused before anything starts", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, "plain"), { recursive: true });
  const never = f.handOff(async () => { throw new Error("the program was started"); });
  await assert.rejects(never.run({ program: "codex", folder: "../outside", task: "x", minutes: 1 }, context(f.app)), /inside the workspace/);
  await assert.rejects(never.run({ program: "codex", folder: "plain", task: "x", minutes: 1 }, context(f.app)), /not a Git repository/);
  assert.equal(f.calls.length, 0);
});

test("a chosen account's own sign-in folder is the one the program is given; an unknown account is refused", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  f.app.store.save("settings", owner, "accounts", { mode: "on", pools: [{ pool: "cli-claude-code", kind: "cli", accounts: [{ id: "a1b2c3d4", label: "Work", createdAt: new Date().toISOString() }] }] });
  const quiet = f.handOff(async () => ({ code: 0, lines: claudeLines("ok"), stderr: "", timedOut: false, missing: false }));
  await quiet.run({ program: "claude-code", folder: "site", task: "x", account: "a1b2c3d4", minutes: 1 }, context(f.app));
  assert.equal(f.calls[0].env.CLAUDE_CONFIG_DIR, join(f.dataDir, "accounts", "cli-claude-code", "a1b2c3d4"));
  assert.equal(f.calls[0].env.OPENAI_API_KEY, undefined, "nothing else of the owner's environment is passed on");
  await assert.rejects(quiet.run({ program: "claude-code", folder: "site", task: "x", account: "ffffffff", minutes: 1 }, context(f.app)), /no Claude Code account called "ffffffff"/);
});

test("inside Branch's own source, whatever the job changed outside the contract is put back and named", async (t) => {
  const f = await fixture(t);
  const worktree = "branch-agent-source/.branch-worktrees/self-typo";
  await repository(join(f.workspace, worktree));
  new ContractBook(f.app.store.sqlite).create(owner, { taskRunId: "0".repeat(8), sourceSha: "0".repeat(40), worktreePath: worktree,
    terms: { allowedPaths: ["src/**"], permissions: ["code.hand_off"], expectedTests: ["tests/a.test.mjs"],
      definitionOfDone: "a is 2", sideEffects: [], rollbackPlan: "revert the commit" } });
  const result = await f.handOff(async (call) => {
    await writeFile(join(call.cwd, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(call.cwd, "README.md"), "changed\n");
    await writeFile(join(call.cwd, "planted.txt"), "new\n");
    return { code: 0, lines: claudeLines("ok"), stderr: "", timedOut: false, missing: false };
  }).run({ program: "claude-code", folder: worktree, task: "Set a to 2.", minutes: 1 }, context(f.app));
  assert.deepEqual(result.changed, ["src/a.ts"]);
  assert.deepEqual(result.undone.sort(), ["README.md", "planted.txt"]);
  assert.equal(await readFile(join(f.workspace, worktree, "README.md"), "utf8"), "hello\n");
  assert.equal(existsSync(join(f.workspace, worktree, "planted.txt")), false);
  assert.equal(await readFile(join(f.workspace, worktree, "src", "a.ts"), "utf8"), "export const a = 2;\n");
});

test("a plan limit, a failure and a stop are each said as what they are", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  const limited = await f.handOff(async () => ({ code: 1, stderr: "", timedOut: false, missing: false,
    lines: [JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit." } })] }))
    .run({ program: "codex", folder: "site", task: "x", minutes: 1 }, context(f.app));
  assert.equal(limited.status, "limit reached");
  const failed = await f.handOff(async () => ({ code: 2, lines: [], stderr: "boom", timedOut: false, missing: false }))
    .run({ program: "codex", folder: "site", task: "x", minutes: 1 }, context(f.app));
  assert.equal(failed.status, "failed");
  assert.equal(failed.summary, "boom");
  const stopping = new AbortController();
  stopping.abort();
  const stopped = await f.handOff(async () => ({ code: null, lines: [], stderr: "", timedOut: false, missing: false }))
    .run({ program: "codex", folder: "site", task: "x", minutes: 1 }, context(f.app, { signal: stopping.signal }));
  assert.equal(stopped.status, "stopped");
});

test("a specialist or a Trunk never reaches the owner's Claude Code or Codex", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  const never = f.handOff(async () => { throw new Error("the program was started"); });
  await assert.rejects(never.run({ program: "claude-code", folder: "site", task: "x", minutes: 1 }, context(f.app, { agent: "trunk:ada" })), /owner's own/);
  assert.equal(f.calls.length, 0);
});

test("somebody else in the household never reaches the owner's Claude Code or Codex either", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  const person = f.app.store.profiles.create({ name: "Sam", pin: "1234" });
  f.app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const never = f.handOff(async () => { throw new Error("the program was started"); });
  await assert.rejects(never.run({ program: "codex", folder: "site", task: "x", minutes: 1 }, context(f.app)), /Claude Code or Codex/);
  assert.equal(f.calls.length, 0);
});

test("the hand-off is a tool in the code toolbox that reaches outside this computer and names its folder whole", async (t) => {
  const f = await fixture(t);
  assert.equal(f.app.registry.permissionOf("code.hand_off"), "code.handoff");
  assert.equal(f.app.registry.reachOf("code.hand_off"), "outbound");
  assert.equal(f.app.registry.groupOf("code.hand_off"), "code");
  assert.deepEqual(f.app.registry.targetsOf("code.hand_off", { program: "codex", folder: "site", task: "x" }, context(f.app)),
    [{ kind: "write", path: "site", folder: true }]);
});
