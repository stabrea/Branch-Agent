/**
 * Never breaks, threat 1: the assistant can never change its own program, the gateway's settings,
 * the saved-work database or the updater — whatever the rules, a standing yes, Lockdown or a switch
 * say. Temporary folders and fake paths only; nothing here touches the real install.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, access } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { protectedAreas, protectedTarget, placeWords } from "../dist/never-break/protected.js";

const areas = protectedAreas({ workspace: "/home/o/work", dataDir: "/home/o/.branch", installRoot: "/opt/branch",
  platform: "linux", selfPids: [4242, 4241] });
const check = (tool, args, readOnly = false, target = "") => protectedTarget({ tool, readOnly, args, target }, areas);

test("a file tool may not change the program, the settings or the database", () => {
  assert.match(check("files.write", { path: "/home/o/.branch/gateway.json", content: "{}" }), /gateway's settings|Branch's own files/);
  assert.match(check("files.write", { path: "../.branch/branch.sqlite" }), /never lets a task/);
  assert.match(check("files.delete", { path: "/opt/branch/dist/cli.js" }), /Branch's own files/);
  assert.equal(check("files.write", { path: "notes/today.md", content: "hello" }), null, "ordinary work is untouched");
  assert.equal(check("files.write", { path: "/home/o/work/.branch/x" }), null, "a folder of the same name in the workspace is fine");
});

test("reading is refused only for the database and the keys", () => {
  assert.match(check("files.read", { path: "/home/o/.branch/branch.sqlite" }, true), /read Branch's saved-work database/);
  assert.match(check("files.read", { path: "/home/o/.branch/locker.key" }, true), /keys/);
  assert.equal(check("files.read", { path: "/opt/branch/README.md" }, true), null, "reading the program's own help is fine");
});

test("every word of a command is checked, and a sweeping command naming a parent is refused", () => {
  assert.match(check("shell.execute", { executable: "rm", args: ["-rf", "/home/o/.branch"] }), /never lets a task/);
  const home = protectedAreas({ workspace: join(homedir(), "never-work"), dataDir: join(homedir(), ".never-branch"),
    installRoot: "/opt/branch", platform: "linux" });
  for (const line of ["echo x > ~/.never-branch/gateway.json", "cp evil.js $HOME/.never-branch/branch.sqlite",
    "cp evil.js ${HOME}/../../opt/branch/dist/cli.js"])
    assert.match(protectedTarget({ tool: "shell.execute", readOnly: false, args: { executable: "sh", args: ["-c", line] }, target: "" }, home) ?? "",
      /never lets a task/, line);
  assert.match(check("shell.execute", { executable: "rm", args: ["-rf", "/home/o"] }), /never lets a task/, "rm on a parent folder");
  assert.equal(check("shell.execute", { executable: "git", args: ["status", "/home/o"] }), null, "a look at a parent is not sweeping");
  assert.equal(check("shell.execute", { executable: "/opt/branch/node", args: ["build.js"] }, false, "/opt/branch/node build.js"), null,
    "running the program's own runtime is not changing it");
  assert.equal(check("shell.execute", { executable: "npm", args: ["test"] }), null);
});

test("commands that would stop, reinstall or update Branch itself are refused", () => {
  for (const [executable, args] of [
    ["launchctl", ["bootout", "gui/501/com.keepoak.branch-agent"]],
    ["systemctl", ["--user", "stop", "branch-agent.service"]],
    ["schtasks.exe", ["/Delete", "/TN", "Branch Agent daemon"]],
    ["node", ["dist/cli.js", "daemon", "uninstall"]],
    ["pkill", ["-f", "cli.js"]],
    ["kill", ["-9", "4242"]],
  ]) assert.match(check("shell.execute", { executable, args }) ?? "", /stop, reinstall or update Branch itself/, `${executable} ${args.join(" ")}`);
  assert.equal(check("shell.execute", { executable: "kill", args: ["777"] }), null, "another program may be stopped");
});

test("a developer's workspace inside the program folder stays usable", () => {
  const dev = protectedAreas({ workspace: "/src/branch/workspace", dataDir: "/src/branch/.branch", installRoot: "/src/branch", platform: "linux" });
  const run = (path) => protectedTarget({ tool: "files.write", readOnly: false, args: { path }, target: path }, dev);
  assert.equal(run("/src/branch/workspace/a.txt"), null);
  assert.match(run("/src/branch/dist/runtime.js"), /never lets a task/);
  assert.match(run("/src/branch/.branch/branch.sqlite"), /never lets a task/);
});

test("Windows and macOS paths are compared without regard to case", () => {
  const win = protectedAreas({ workspace: "C:\\Users\\o\\work", dataDir: "C:\\Users\\o\\AppData\\Local\\Branch Agent\\state",
    installRoot: "C:\\Users\\o\\AppData\\Local\\Programs\\Branch Agent", platform: process.platform === "win32" ? "win32" : "darwin" });
  if (process.platform !== "win32") return; // path.resolve only understands drive letters on Windows
  assert.match(protectedTarget({ tool: "files.write", readOnly: false, args: { path: "c:\\users\\o\\appdata\\local\\branch agent\\state\\gateway.json" }, target: "" }, win) ?? "", /never lets/);
});

test("words that could name a place are picked out of a command", () => {
  assert.deepEqual(placeWords("cat a.txt > ../x/y; echo gateway.json"), ["../x/y", "gateway.json"]);
});

async function app(t, steps) {
  const root = await mkdtemp(join(tmpdir(), "branch-never-deny-"));
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request); return steps[Math.min(provider.requests.length - 1, steps.length - 1)];
  } };
  const branch = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await branch.close(); await discardTemp(root); });
  return { branch, root };
}

test("no rule, standing yes, hook or Lockdown-off can lift the refusal", async (t) => {
  const target = "../data/gateway.json";
  const call = { id: "c1", name: "files.write", arguments: JSON.stringify({ path: target, content: "{\"port\":1}" }) };
  const { branch, root } = await app(t, [{ content: "", toolCalls: [call] }, { content: "done", toolCalls: [] }]);
  savePolicy(branch.store, "local", { preset: "custom", rules: [{ tool: "*", decision: "allow", remember: "always" }] });
  const sessionId = branch.store.createSession("local");
  branch.runtime.approvals.remember(sessionId, "files.write", target, "allow", { label: "writing it" });
  branch.runtime.askHooks = async () => ({ decision: "allow", hook: "permissive" });
  const context = branch.runtime.context({ runId: branch.store.createRun("local", "probe", sessionId).id });
  const verdict = branch.runtime.checkPolicy("files.write", JSON.parse(call.arguments), context);
  assert.equal(verdict.decision, "deny");
  assert.match(verdict.reason, /whatever the rules or permissions say/);

  const run = await branch.runtime.run({ prompt: "rewrite your gateway settings", sessionId, onTextDelta: () => undefined });
  const denied = branch.store.events(run.id).find((event) => event.kind === "policy.denied");
  assert.ok(denied, "the call was refused on the record");
  await assert.rejects(access(join(root, "data", "gateway.json")), "nothing was written");
  await writeFile(join(root, "workspace", "ok.txt"), "x");
  assert.equal(branch.runtime.checkPolicy("files.write", { path: "ok.txt", content: "y" }, context).decision, "allow",
    "the same permissive rules still let ordinary work through");
});
