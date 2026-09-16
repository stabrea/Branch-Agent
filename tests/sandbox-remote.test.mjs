import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";

/**
 * Wave 8: real sandboxes where this computer offers one, workspaces on another computer over SSH,
 * and the last of the approval-policy rows. Nothing here starts a container, a Linux distribution,
 * Windows Sandbox or an SSH connection: every outside program is a fake that records what it was
 * asked to do, which is the only way to assert the exact arguments anyway.
 */

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-sandbox-remote-"));
  const provider = { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }],
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, root, workspace: join(root, "workspace") };
}

/** A context good enough for a tool that only wants the workspace, a run id and a signal. */
const contextOf = (app, extra = {}) => ({
  owner: "local", workspace: app.workspace ?? "", runId: "", signal: AbortSignal.timeout(10_000),
  budget: { step() {}, charge() {}, remaining: () => 1000, limits: { maxSteps: 9, maxTokens: 9 }, steps: 0, tokens: 0 },
  permissions: new Set(), depth: 0, ...extra,
});

/** A stand-in for every outside program: it answers, and remembers exactly what it was asked. */
function fakeWorld(answers = {}) {
  const calls = [];
  const probe = async (executable, args) => {
    calls.push({ kind: "probe", executable, args });
    const answer = answers[executable];
    if (!answer) return { code: null, stdout: "", stderr: "", missing: true };
    return { code: 0, stdout: answer.version ?? "1.0", stderr: "", missing: false };
  };
  const spawn = async (options) => {
    calls.push({ kind: "run", ...options });
    const answer = answers[options.executable];
    return { status: "completed", exitCode: 0, stdout: answer?.stdout ?? "", stderr: "",
      truncated: false, durationMs: 1 };
  };
  return { calls, probe, spawn, runs: () => calls.filter((c) => c.kind === "run") };
}

// ------------------------------------------------------------ A2131 / A2152 / A2160 / A2277 / A0797

test("A2277/A0797 an approval rule picks the backend, and code.run and process.start both honour it", async (t) => {
  const { app, workspace } = await fixture(t);
  const { PolicyRuleSchema, savePolicy, evaluatePolicy, readPolicy } = await import("../dist/policy.js");

  // The rule shape carries where a program runs and what it may see, alongside how tightly it is held.
  const rule = PolicyRuleSchema.parse({ tool: "code.run", decision: "allow", sandbox: "no-internet", backend: "docker", paths: ["reports"] });
  assert.equal(rule.backend, "docker");
  savePolicy(app.store, "local", { rules: [rule] });
  const { rule: matched } = evaluatePolicy(readPolicy(app.store, "local"), { tool: "code.run", target: "", readOnly: false });
  assert.equal(matched?.backend, "docker");
  assert.deepEqual(matched?.paths, ["reports"]);
  assert.ok(workspace);
});

test("A2152 the container backend builds the exact arguments, against a fake docker that never runs one", async (t) => {
  const { root } = await fixture(t);
  const { ContainerBackend, dockerArgv, SandboxBackendSettingsSchema } = await import("../dist/sandbox-backends.js");
  const world = fakeWorld({ docker: { version: "27.0.0", stdout: "42" } });
  const settings = SandboxBackendSettingsSchema.parse({ image: "node:22-alpine" });
  const backend = new ContainerBackend(settings, world.probe, world.spawn);
  assert.equal((await backend.available()).ok, true);

  const slice = { hostPath: join(root, "workspace") };
  const handle = await backend.prepare(slice);
  assert.equal(handle.mount, "/work");
  const limits = { timeoutMs: 5000, maxMemoryMb: 512, maxCpuSeconds: 20, maxOutputBytes: 8192, network: false, job: true };
  const result = await handle.run({ executable: "node", args: ["-e", "1"] }, limits, AbortSignal.timeout(5000));

  assert.equal(result.backend, "docker");
  assert.deepEqual(result.argv, ["docker", ...dockerArgv({ image: "node:22-alpine", hostPath: slice.hostPath, command: { executable: "node", args: ["-e", "1"] }, limits })]);
  assert.deepEqual(result.argv.slice(0, 12), ["docker", "run", "--rm", "--network", "none", "--memory", "512m", "--cpus", "1", "--read-only", "--workdir", "/work"]);
  assert.ok(result.argv.includes(`${slice.hostPath}:/work:rw`), "the folder is mounted read-write under /work");
  assert.ok(result.argv.includes("node:22-alpine"));
  // The fake was asked to start docker, and nothing else on this computer was started at all.
  assert.deepEqual(world.runs().map((c) => c.executable), ["docker"]);
  await handle.dispose();
});

test("A2131/A2160 a backend that is not on this computer refuses plainly and names what to install", async (t) => {
  await fixture(t);
  const { sandboxBackendSet, chooseSandboxBackend, SandboxBackendSettingsSchema } = await import("../dist/sandbox-backends.js");
  const world = fakeWorld({});  // nothing is installed
  const set = sandboxBackendSet({ settings: SandboxBackendSettingsSchema.parse({}), probe: world.probe, spawn: world.spawn });

  await assert.rejects(chooseSandboxBackend(set, "docker"), /Docker Desktop or Podman/);
  await assert.rejects(chooseSandboxBackend(set, "wsl"), /Windows Subsystem for Linux/);
  await assert.rejects(chooseSandboxBackend(set, "windows-sandbox"), /switch it on in Settings/);
  // The plain box is always there, and is what a call with no rule gets.
  assert.equal((await chooseSandboxBackend(set, null)).name, "job-object");
  // Nothing was ever started: only version questions were asked.
  assert.equal(world.runs().length, 0);
});

test("A2160 the Linux backend and the throwaway desktop make the files and arguments they promise", async (t) => {
  const { root } = await fixture(t);
  const { WslBackend, WindowsSandboxBackend, wslPath, windowsSandboxFile, SandboxBackendSettingsSchema } =
    await import("../dist/sandbox-backends.js");
  const slice = { hostPath: join(root, "workspace") };
  await mkdir(slice.hostPath, { recursive: true });
  await writeFile(join(slice.hostPath, "note.txt"), "hello", "utf8");
  const limits = { timeoutMs: 5000, maxMemoryMb: 256, maxCpuSeconds: 10, maxOutputBytes: 4096, network: false, job: true };

  assert.equal(wslPath("C:\\work\\thing"), "/mnt/c/work/thing");
  const wslWorld = fakeWorld({ "wsl.exe": { version: "2.0" } });
  const wsl = new WslBackend(SandboxBackendSettingsSchema.parse({ distro: "Ubuntu" }), wslWorld.probe, wslWorld.spawn);
  const wslHandle = await wsl.prepare(slice);
  const ran = await wslHandle.run({ executable: "python3", args: ["-c", "print(1)"] }, limits, AbortSignal.timeout(5000));
  assert.deepEqual(ran.argv.slice(0, 5), ["wsl.exe", "-d", "Ubuntu", "--cd", wslHandle.mount]);
  assert.deepEqual(ran.argv.slice(5), ["--", "python3", "-c", "print(1)"]);
  // The folder was copied in, not handed over: the copy has the file, and it is not the original.
  assert.notEqual(wslHandle.mount, slice.hostPath);
  await wslHandle.dispose();

  const wsbWorld = fakeWorld({ "WindowsSandbox.exe": { version: "" } });
  const wsb = new WindowsSandboxBackend(SandboxBackendSettingsSchema.parse({ windowsSandbox: true }), wsbWorld.probe, wsbWorld.spawn);
  const wsbHandle = await wsb.prepare(slice);
  const opened = await wsbHandle.run({ executable: "cmd.exe", args: ["/c", "dir"] }, limits, AbortSignal.timeout(5000));
  assert.equal(opened.argv[0], "WindowsSandbox.exe");
  assert.ok(opened.argv[1].endsWith(".wsb"));
  const written = await readFile(opened.argv[1], "utf8");
  assert.equal(written, windowsSandboxFile({ hostPath: slice.hostPath, command: { executable: "cmd.exe", args: ["/c", "dir"] } }));
  assert.match(written, /<HostFolder>/);
  assert.match(written, /<SandboxFolder>C:\\work<\/SandboxFolder>/);
  assert.match(written, /<ReadOnly>false<\/ReadOnly>/);
  assert.match(written, /<Networking>Disable<\/Networking>/);
  await wsbHandle.dispose();
});

// ------------------------------------------------------------------------------------ A1520

test("A1520 a script is read before anything is started, and a forbidden call or a network import refuses", async (t) => {
  await fixture(t);
  const { checkCodeBlock, maxScriptBytes } = await import("../dist/code-check.js");

  const spawning = checkCodeBlock("import { execSync } from 'node:child_process'; execSync('x')", { language: "javascript", network: true });
  assert.equal(spawning.ok, false);
  assert.deepEqual(spawning.found, ["start another program"]);
  assert.match(spawning.reason, /start another program/);

  const reaching = checkCodeBlock("import requests\nrequests.get('http://x')", { language: "python", network: false });
  assert.equal(reaching.ok, false);
  assert.deepEqual(reaching.found, ["reach the internet"]);
  // The same script is fine when the owner's rule lets it out.
  assert.equal(checkCodeBlock("import requests\nrequests.get('http://x')", { language: "python", network: true }).ok, true);

  assert.equal(checkCodeBlock("console.log(2 + 2)", { language: "javascript", network: false }).ok, true);
  const long = checkCodeBlock("x".repeat(maxScriptBytes + 1), { language: "javascript", network: false });
  assert.equal(long.ok, false);
  assert.match(long.reason, /Put it in a file/);
});

test("A1520/A0018 code.run refuses the forbidden script before it prepares anywhere to run it", async (t) => {
  const { app, root } = await fixture(t);
  const { CodeRunner, saveCodeRunSettings } = await import("../dist/code-run.js");
  await saveCodeRunSettings(app.store, "local", { enabled: true });
  const world = fakeWorld({ docker: { version: "27" } });
  const runner = new CodeRunner(app.store, "local", join(root, "workspace"), { create: async () => null }, world.probe, world.spawn);

  await assert.rejects(
    runner.run({ language: "javascript", source: "require('child_process')" }, contextOf(app)),
    /start another program/);
  // Nothing was prepared and nothing was started, not even a look for docker.
  assert.equal(world.calls.length, 0);
});

test("A0018/A2277 a rule's folder list is the only part of the workspace a sandboxed script can see", async (t) => {
  const { app, root } = await fixture(t);
  const workspace = join(root, "workspace");
  const { CodeRunner, saveCodeRunSettings } = await import("../dist/code-run.js");
  const { sliceFor } = await import("../dist/sandbox-backends.js");
  await mkdir(join(workspace, "reports"), { recursive: true });
  await saveCodeRunSettings(app.store, "local", { enabled: true });

  assert.deepEqual(await sliceFor(workspace, []), { hostPath: workspace });
  assert.deepEqual(await sliceFor(workspace, ["reports"]), { hostPath: join(workspace, "reports") });
  await assert.rejects(sliceFor(workspace, ["../elsewhere"]), /relative to your workspace/);
  await assert.rejects(sliceFor(workspace, ["C:\\Windows"]), /relative to your workspace/);

  const world = fakeWorld({ docker: { version: "27" } });
  const runner = new CodeRunner(app.store, "local", workspace, { create: async () => null }, world.probe, world.spawn);
  const result = await runner.run({ language: "javascript", source: "console.log(1)" },
    contextOf(app, { sandboxBackend: "docker", sandboxPaths: ["reports"] }));
  assert.equal(result.backend, "docker");
  assert.equal(result.folder, "reports");
  // The mount is the one folder, not the workspace.
  const started = world.runs().at(-1);
  assert.ok(started.args.includes(`${join(workspace, "reports")}:/work:rw`));
  assert.ok(!started.args.some((a) => a === `${workspace}:/work:rw`));
});
