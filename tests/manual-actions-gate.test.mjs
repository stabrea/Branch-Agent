/**
 * mac5/manual-actions: a tool run outside a conversation — pressed by hand in the app window, a
 * saved workflow's step, "Try a tool" — goes through the same guards a task's call does: Branch's
 * own files, Lockdown, folder trust, the rules and the OS sandbox wall. Temporary folders only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import {
  ApprovalRequiredError, PolicyRefusedError, createBranch, decideFolder, saveFolderTrustSettings,
  savePolicy, saveWallSettings, setLockdown,
} from "../dist/index.js";
import { tryTool } from "../dist/playground.js";
import { manualVerdict } from "../dist/tool-gate.js";
import { argumentFingerprint } from "../dist/runtime.js";

async function app(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-manual-gate-"));
  const provider = { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const branch = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await branch.close(); await discardTemp(root); });
  // A stand-in for the command tool, so nothing real is ever started; it notes what it was handed.
  const ran = [];
  branch.registry.unregister("shell.execute");
  branch.registry.register({
    name: "shell.execute", permission: "shell.execute", description: "stand-in",
    parameters: z.object({ executable: z.string(), args: z.array(z.string()).default([]) }),
    execute: async (args, context) => { ran.push({ args, context }); return { exitCode: 0 }; },
  });
  return { branch, root, ran };
}
const denials = (branch) => branch.store.runs("local")
  .flatMap((run) => branch.store.events(run.id)).filter((event) => event.kind === "policy.denied");

test("a manual action may not write Branch's data folder, whatever the rules say", async (t) => {
  const { branch, root } = await app(t);
  savePolicy(branch.store, "local", { preset: "custom", rules: [{ tool: "*", decision: "allow", remember: "always" }] });
  await assert.rejects(branch.runtime.executeTool("files.write", { path: "../data/gateway.json", content: "{}" }),
    (error) => error instanceof PolicyRefusedError && /never lets a task/.test(error.message));
  await assert.rejects(access(join(root, "data", "gateway.json")), "nothing was written");
  assert.ok(denials(branch).length >= 1, "the refusal is on the record");
});

test("a manual action may not rm -rf Branch's data folder", async (t) => {
  const { branch, root, ran } = await app(t);
  await assert.rejects(branch.runtime.executeTool("shell.execute", { executable: "rm", args: ["-rf", join(root, "data")] }),
    /never lets a task/);
  assert.equal(ran.length, 0, "the command never started");
});

test("under Lockdown a changing manual action is refused, and looking still works", async (t) => {
  const { branch, root } = await app(t);
  setLockdown(branch.store, "local", { on: true });
  await assert.rejects(branch.runtime.executeTool("files.write", { path: "note.txt", content: "x" }), /Lockdown is on/);
  await assert.rejects(access(join(root, "workspace", "note.txt")));
  setLockdown(branch.store, "local", { on: false });
  await branch.runtime.executeTool("files.write", { path: "note.txt", content: "x" });
  setLockdown(branch.store, "local", { on: true });
  const read = await branch.runtime.executeTool("files.read", { path: "note.txt" });
  assert.match(JSON.stringify(read), /x/, "a look is not a change");
});

test("a deny rule refuses a manual action", async (t) => {
  const { branch, root } = await app(t);
  savePolicy(branch.store, "local", { preset: "custom", rules: [{ tool: "files.write", decision: "deny" }] });
  await assert.rejects(branch.runtime.executeTool("files.write", { path: "note.txt", content: "x" }),
    (error) => error instanceof PolicyRefusedError);
  await assert.rejects(access(join(root, "workspace", "note.txt")));
});

test("an untrusted folder refuses a changing manual action", async (t) => {
  const { branch, root } = await app(t);
  saveFolderTrustSettings(branch.store, "local", { mode: "on" });
  decideFolder(branch.store, "local", join(root, "workspace"), { folder: "", decision: "distrust" });
  await assert.rejects(branch.runtime.executeTool("files.write", { path: "note.txt", content: "x" }), /not trusted/);
});

test("the owner's own 'ask first' rule does not stop what the owner pressed", async (t) => {
  const { branch, root } = await app(t);
  savePolicy(branch.store, "local", { preset: "ask-before-changes" });
  await branch.runtime.executeTool("files.write", { path: "note.txt", content: "mine" });
  assert.equal(await readFile(join(root, "workspace", "note.txt"), "utf8"), "mine");
});

test("an ordinary allowed manual action still works", async (t) => {
  const { branch, root } = await app(t);
  await branch.runtime.executeTool("files.write", { path: "ok.txt", content: "fine" });
  assert.equal(await readFile(join(root, "workspace", "ok.txt"), "utf8"), "fine");
  assert.equal(denials(branch).length, 0);
});

test("a manual command runs behind the owner's wall, and a rule only tightens it", { skip: process.platform === "win32" }, async (t) => {
  const { branch, ran } = await app(t);
  saveWallSettings(branch.store, "local", { mode: "on", network: "open" });
  savePolicy(branch.store, "local", { preset: "custom", rules: [{ tool: "shell.execute", decision: "allow", sandbox: "no-internet" }] });
  await branch.runtime.executeTool("shell.execute", { executable: "echo", args: ["hi"] });
  const wall = ran[0].context.osSandbox;
  assert.ok(wall, "the wall came with the call");
  assert.equal(wall.network, "none", "the rule's 'no internet' tightened the owner's open network");
  assert.equal(ran[0].context.sandbox, "no-internet");
});

test("run by itself, a tool step is held to the full rules and the workflow's own yes", async (t) => {
  const { branch, root } = await app(t);
  savePolicy(branch.store, "local", { preset: "ask-before-changes" });
  await assert.rejects(branch.runtime.executeTool("files.write", { path: "w.txt", content: "a" }, { mode: "policy", approvalKey: "workflow:x" }),
    (error) => error instanceof ApprovalRequiredError);
  await assert.rejects(access(join(root, "workspace", "w.txt")));
  const args = { path: "w.txt", content: "a" };
  const { target, label } = branch.runtime.checkPolicy("files.write", args, branch.runtime.context({ approvalKey: "workflow:x" }));
  branch.runtime.grantApproval("workflow:x", { tool: "files.write", target, label, source: "owner",
    fingerprint: argumentFingerprint(JSON.stringify(args)) });
  await branch.runtime.executeTool("files.write", { path: "w.txt", content: "a" }, { mode: "policy", approvalKey: "workflow:x" });
  assert.equal(await readFile(join(root, "workspace", "w.txt"), "utf8"), "a");
});

test("a saved workflow's tool step waits for a yes, then runs once it is given", async (t) => {
  const { branch, root } = await app(t);
  savePolicy(branch.store, "local", { preset: "ask-before-changes" });
  const made = branch.workflows.create("local", {
    name: "Write it", steps: [{ name: "Write", kind: "tool", tool: "files.write", args: { path: "flow.txt", content: "z" } }],
  });
  const waiting = await branch.workflows.run("local", made.id);
  assert.equal(waiting.status, "waiting_approval");
  await assert.rejects(access(join(root, "workspace", "flow.txt")));
  const done = await branch.workflows.resume("local", made.id);
  assert.equal(done.status, "completed", done.error ?? "");
  assert.equal(await readFile(join(root, "workspace", "flow.txt"), "utf8"), "z");
});

test("a scheduled workflow step under Lockdown never runs", async (t) => {
  const { branch, root } = await app(t);
  setLockdown(branch.store, "local", { on: true });
  const made = branch.workflows.create("local", {
    name: "Write it", steps: [{ name: "Write", kind: "tool", tool: "files.write", args: { path: "locked.txt", content: "z" } }],
  });
  const waiting = await branch.workflows.run("local", made.id, "schedule");
  assert.notEqual(waiting.status, "completed");
  await assert.rejects(access(join(root, "workspace", "locked.txt")));
});

test("Try a tool keeps its question but obeys Branch's own files and Lockdown", async (t) => {
  const { branch, root } = await app(t);
  const gate = (tool, args, context) => manualVerdict(branch.runtime, tool, args, context, argumentFingerprint(JSON.stringify(args)));
  const attempt = (input) => tryTool(branch.registry, branch.store, "local", branch.runtime.context({}),
    { arguments: {}, confirm: false, ...input }, () => null, gate);
  const guarded = await attempt({ name: "files.write", arguments: { path: "../data/gateway.json", content: "{}" }, confirm: true });
  assert.equal(guarded.status, "refused");
  assert.match(guarded.reason, /never lets a task/);
  savePolicy(branch.store, "local", { preset: "ask-before-changes" });
  assert.equal((await attempt({ name: "files.write", arguments: { path: "t.txt", content: "q" } })).status, "asked");
  setLockdown(branch.store, "local", { on: true });
  const locked = await attempt({ name: "files.write", arguments: { path: "t.txt", content: "q" }, confirm: true });
  assert.equal(locked.status, "refused");
  await assert.rejects(access(join(root, "workspace", "t.txt")));
});
