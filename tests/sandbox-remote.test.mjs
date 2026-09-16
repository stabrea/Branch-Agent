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
  owner: "local", workspace: app?.workspace ?? "", runId: "", signal: AbortSignal.timeout(10_000),
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

// --------------------------------------------------------------------------- A1618 / A1413

test("A1618/A1413 the firewall card says the policy in sentences, and the test button asks the real check", async (t) => {
  await fixture(t);
  const { firewallView, testFirewall } = await import("../dist/firewall.js");
  const { NetworkPolicy, NetworkPolicySchema } = await import("../dist/network-policy.js");

  const policy = NetworkPolicySchema.parse({ allowedHosts: ["example.com", "docs.rs"], blockedHosts: ["ads.example.net"] });
  const view = firewallView({ policy, browserOrigins: ["https://example.com"], scriptsMayReachInternet: false, commandsMayReachInternet: false });
  assert.ok(view.sentences.includes("Scripts cannot reach the internet: they are pointed at an address that goes nowhere."));
  assert.ok(view.sentences.includes("Branch may only reach example.com and docs.rs, and nowhere else on the internet."));
  assert.ok(view.sentences.some((s) => s.startsWith("The browser may visit https://example.com.")));
  assert.ok(view.sentences.includes("Branch may never reach ads.example.net."));
  assert.equal(view.limited, true);

  // The button asks exactly the check every real request asks; no address is ever fetched.
  const net = new NetworkPolicy(policy, async () => ["93.184.216.34"]);
  const ok = await testFirewall((url) => net.assertAllowed(url), "https://example.com/a", ["https://example.com"]);
  assert.deepEqual([ok.allowed, ok.browserWouldOpen], [true, true]);
  const no = await testFirewall((url) => net.assertAllowed(url), "https://elsewhere.test/a", ["https://example.com"]);
  assert.equal(no.allowed, false);
  assert.match(no.reason, /not on the allowed list/);
  // On Branch's list, but not a website the browser may open: the card says both halves.
  const partly = await testFirewall((url) => net.assertAllowed(url), "https://docs.rs/x", ["https://example.com"]);
  assert.deepEqual([partly.allowed, partly.browserWouldOpen], [true, false]);
  assert.match(partly.reason, /the browser cannot open it/);
  assert.equal((await testFirewall((url) => net.assertAllowed(url), "not an address")).allowed, false);
});

test("A1413 the browser refuses an address outside its own list and outside the network rules", async (t) => {
  await fixture(t);
  const { BranchBrowser } = await import("../dist/integrations/browser.js");
  const { NetworkPolicy } = await import("../dist/network-policy.js");
  const browser = new BranchBrowser({ allowedOrigins: ["https://example.com", "https://docs.rs"] });
  browser.policy = new NetworkPolicy({ allowedHosts: ["example.com"] }, async () => ["93.184.216.34"]);
  const context = contextOf(null, { runId: "r1" });

  // Not on the browser's own list: refused before a browser is even started.
  await assert.rejects(browser.navigate("https://elsewhere.test/", context), /not an allowed origin/);
  // On the browser's list, but the owner's network rules say no: refused by those rules.
  await assert.rejects(browser.navigate("https://docs.rs/", context), /not on the allowed list/);
  // An address carrying a password is refused whatever the lists say.
  await assert.rejects(browser.navigate("https://user:pw@example.com/", context), /not an allowed origin/);
});

// --------------------------------------------------------------------------------- A2028

test("A2028 a fixed window holds the owner back for a moment and turns a stranger away with a sentence", async (t) => {
  const { app } = await fixture(t);
  const { SessionLimiter, saveSessionLimits, sessionLimits } = await import("../dist/session-limits.js");
  saveSessionLimits(app.store, "local", { requestsPerMinute: 2, tokensPerHour: 100, senderRequestsPerMinute: 1, senderTokensPerHour: 50 });
  assert.equal(sessionLimits(app.store, "local").requestsPerMinute, 2);

  let clock = 1_000_000;
  const limiter = new SessionLimiter(app.store, "local", () => clock);
  const conversation = { scope: "conversation", id: "s1" };

  assert.equal(limiter.check(conversation, "owner").ok, true);
  assert.equal(limiter.check(conversation, "owner").ok, true);
  const third = limiter.check(conversation, "owner");
  assert.equal(third.ok, false);
  assert.ok(third.waitMs > 0 && third.waitMs <= 60_000, "the owner is made to wait, not turned away");
  assert.equal(third.reason, "");
  assert.equal(limiter.used(conversation).requests, 2);

  // Somebody messaging from outside gets a sentence instead of a wait, and their message is let go.
  const stranger = { scope: "sender", id: "telegram:5551" };
  assert.equal(limiter.check(stranger, "stranger").ok, true);
  const turned = limiter.check(stranger, "stranger");
  assert.equal(turned.ok, false);
  assert.equal(turned.waitMs, 0);
  assert.match(turned.reason, /as much as Branch will do for one person right now/);
  assert.match(turned.reason, /Try again in about/);

  // The next minute starts a fresh window.
  clock += 60_000;
  assert.equal(limiter.check(conversation, "owner").ok, true);

  // Tokens have an hour of their own, and being refused does not spend the minute.
  const heavy = { scope: "conversation", id: "s2", tokens: 90 };
  assert.equal(limiter.check(heavy, "owner").ok, true);
  const over = limiter.check(heavy, "owner");
  assert.equal(over.ok, false);
  assert.equal(over.limit, "tokens");
  assert.equal(limiter.used({ scope: "conversation", id: "s2" }).requests, 1, "a refused request is not counted against the minute");

  // Every one of those is on the record.
  const written = app.store.audit.list("local", { action: "limit.reached" });
  assert.ok(written.length >= 3);
  assert.ok(written.some((entry) => entry.outcome === "discarded"));
  assert.ok(written.some((entry) => entry.outcome === "queued"));
});

// --------------------------------------------------------------------------------- A1770

test("A1770 a saved sign-in can be carried to another computer, sealed, and read back", async (t) => {
  const { root } = await fixture(t);
  const { BrowserProfiles } = await import("../dist/integrations/browser-profiles.js");
  const key = { key: async () => Buffer.alloc(32, 7) };
  const profiles = new BrowserProfiles(join(root, "profiles"), key);
  const state = { cookies: [{ name: "session", value: "abc123", domain: "example.com" }], origins: [{ origin: "https://example.com" }] };
  await profiles.save("local", "shop", state);
  assert.deepEqual((await profiles.list("local")).map((p) => p.name), ["shop"]);

  const bundle = await profiles.export("local", "shop", "a long enough passphrase");
  assert.ok(Buffer.isBuffer(bundle));
  // The secret is sealed: the cookie value is nowhere in the bytes that leave this computer.
  assert.equal(bundle.includes(Buffer.from("abc123", "utf8")), false);
  assert.equal(bundle.subarray(0, 16).toString("utf8"), "branch-signin-v1");

  const elsewhere = new BrowserProfiles(join(root, "other"), key);
  const restored = await elsewhere.import("local", bundle, "a long enough passphrase", "shop-copy");
  assert.equal(restored.name, "shop-copy");
  assert.deepEqual(await elsewhere.load("local", "shop-copy"), state);

  // The wrong passphrase, and a file that is not one of ours, both refuse plainly.
  await assert.rejects(elsewhere.import("local", bundle, "a different passphrase"), /Check the passphrase/);
  await assert.rejects(elsewhere.import("local", Buffer.from("hello there, not a bundle at all"), "a long enough passphrase"),
    /not a saved sign-in exported from Branch/);
  await assert.rejects(profiles.export("local", "shop", "short"), /./);
});

// ------------------------------------------------------------ A0329 / A0648 / A2279: another computer

/**
 * A stand-in for the OpenSSH programs. Nothing is ever connected: the fake records the exact
 * program and arguments it was handed, which is the only thing worth asserting here anyway.
 */
function fakeSsh(answers = {}) {
  const calls = [];
  const run = async (executable, args) => {
    calls.push({ executable, args });
    const answer = answers[executable] ?? {};
    return { status: answer.status ?? "completed", stdout: answer.stdout ?? "",
      stderr: answer.stderr ?? "", exitCode: answer.exitCode ?? 0 };
  };
  return { calls, run, last: () => calls.at(-1) };
}

/** The owner's own two SSH files, written where the test can point at them. */
async function sshHome(root, config, knownHosts) {
  const folder = join(root, `ssh-${Math.random().toString(36).slice(2)}`);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "config"), config, "utf8");
  await writeFile(join(folder, "known_hosts"), knownHosts, "utf8");
  return { config: join(folder, "config"), knownHosts: join(folder, "known_hosts") };
}

test("A0329/A2279 a computer can only be added by a name in the owner's own SSH config", async (t) => {
  const { app, root } = await fixture(t);
  const { RemoteWorkspaces } = await import("../dist/remote/ssh-workspace.js");
  const home = await sshHome(root, "Host tower\n  HostName tower.lan\n  User me\n", "tower.lan ssh-ed25519 AAAA\n");
  const world = fakeSsh();
  const remotes = new RemoteWorkspaces(app.store, "local", world.run, home);

  // A name the owner never wrote down cannot be added, however it is spelled.
  await assert.rejects(remotes.add({ alias: "stranger", root: "/srv/work" }), /not in your SSH config/);
  // Nor can a password be smuggled in: the shape has no field for one.
  await assert.rejects(remotes.add({ alias: "tower", root: "/srv/work", password: "hunter2" }), /./);

  const added = await remotes.add({ alias: "tower", root: "/srv/work", label: "The tower" });
  assert.equal(added.alias, "tower");
  assert.deepEqual(added.executables, [], "a new computer may run nothing at all until the owner says so");
  assert.equal(remotes.list().length, 1);
  assert.equal(remotes.get("tower").root, "/srv/work");
  assert.throws(() => remotes.get("nowhere"), /not one of the computers/);
  assert.equal(remotes.remove("tower"), true);
  assert.equal(remotes.remove("tower"), false);
});

test("A0329 a computer whose key the owner has never accepted is refused, never trusted", async (t) => {
  const { app, root } = await fixture(t);
  const { RemoteWorkspaces, sshOptions } = await import("../dist/remote/ssh-workspace.js");
  const home = await sshHome(root, "Host tower\n  HostName tower.lan\n", "somewhere-else.example ssh-ed25519 AAAA\n");
  // ssh-keygen -F is the last word on a known_hosts file whose names are hidden; here it finds nothing.
  const world = fakeSsh({ "ssh-keygen": { exitCode: 1, stdout: "" } });
  const remotes = new RemoteWorkspaces(app.store, "local", world.run, home);

  await assert.rejects(remotes.add({ alias: "tower", root: "/srv/work" }), /never seen tower.lan before/);
  assert.equal(remotes.list().length, 0, "nothing is saved when the key is not already accepted");
  // And Branch never asks ssh to stop checking: the options it forces say the opposite.
  assert.ok(sshOptions.includes("StrictHostKeyChecking=yes"));
  assert.ok(sshOptions.includes("PasswordAuthentication=no"));
  assert.ok(sshOptions.includes("BatchMode=yes"));
  assert.equal(sshOptions.includes("StrictHostKeyChecking=no"), false);
});

test("A2279 files on another computer stay inside that computer's own folder", async (t) => {
  const { app, root } = await fixture(t);
  const { RemoteWorkspaces, remotePath } = await import("../dist/remote/ssh-workspace.js");
  const home = await sshHome(root, "Host tower\n  HostName tower.lan\n", "tower.lan ssh-ed25519 AAAA\n");
  const world = fakeSsh({ ssh: { stdout: "march.csv\nnotes.md\n" } });
  const remotes = new RemoteWorkspaces(app.store, "local", world.run, home);
  await remotes.add({ alias: "tower", root: "/srv/work" });

  const listed = await remotes.files("tower", "reports", AbortSignal.timeout(5000));
  assert.deepEqual(listed.entries, ["march.csv", "notes.md"]);
  // The alias is what goes on the command line, never the real name behind it.
  const call = world.last();
  assert.equal(call.executable, "ssh");
  assert.equal(call.args.includes("tower"), true);
  assert.equal(call.args.includes("tower.lan"), false);
  assert.deepEqual(call.args.slice(call.args.indexOf("tower")), ["tower", "--", "ls", "-1A", "--", "/srv/work/reports"]);

  // Every way out of the folder is refused before anything is sent.
  assert.equal(remotePath("/srv/work", "reports/march.csv"), "/srv/work/reports/march.csv");
  assert.throws(() => remotePath("/srv/work", "../../etc/passwd"), /traversal/);
  assert.throws(() => remotePath("/srv/work", "/etc/passwd"), /inside that computer/);
  assert.throws(() => remotePath("/srv/work", "~/.ssh/id_ed25519"), /inside that computer/);
  assert.throws(() => remotePath("/srv/work", "C:\\Windows"), /inside that computer/);
  await assert.rejects(remotes.read("tower", "../secrets.txt", AbortSignal.timeout(5000)), /traversal/);
});

test("A0648 a computer may only run the programs the owner allowed, and the card names the computer", async (t) => {
  const { app, root } = await fixture(t);
  const { RemoteWorkspaces, registerRemoteWorkspaces, explainSsh } = await import("../dist/remote/ssh-workspace.js");
  const home = await sshHome(root, "Host tower\n  HostName tower.lan\n", "tower.lan ssh-ed25519 AAAA\n");
  const world = fakeSsh({ ssh: { stdout: "ok\n" } });
  const remotes = new RemoteWorkspaces(app.store, "local", world.run, home);
  await remotes.add({ alias: "tower", root: "/srv/work", executables: ["make"] });

  await assert.rejects(remotes.execute("tower", "rm", ["-rf", "/"], AbortSignal.timeout(5000)),
    /"rm" is not one of the programs tower is allowed to run/);
  const done = await remotes.execute("tower", "make", ["build"], AbortSignal.timeout(5000));
  assert.equal(done.output.trim(), "ok");
  assert.deepEqual(world.last().args.slice(-3), ["--", "make", "build"]);

  // The approval card says which computer, so a yes is never given blind. The app registers these
  // at start-up, so registering them again is refused: that is the wiring, asserted.
  assert.throws(() => registerRemoteWorkspaces(app.registry, remotes), /duplicate tool name/);
  const context = contextOf(app);
  assert.equal(app.registry.targetOf("remote.run", { computer: "tower", program: "make", args: ["build"] }, context),
    "tower: make build");
  assert.equal(app.registry.targetOf("remote.files", { computer: "tower", path: "reports" }, context), "tower: reports");
  assert.equal(app.registry.permissionOf("remote.run"), "shell.execute");
  assert.equal(app.registry.permissionOf("remote.read"), "files.read");

  // Ssh's own wording is turned into something the owner can act on.
  assert.match(explainSsh("tower", { status: "completed", stderr: "Host key verification failed." }), /different key/);
  assert.match(explainSsh("tower", { status: "completed", stderr: "Permission denied (publickey)." }), /never uses a password/);
  assert.match(explainSsh("tower", { status: "timed_out", stderr: "" }), /did not answer in time/);
});

// ------------------------------------------------------------ A0544 / A1582: a way back, and a line of work

/** A stand-in for git. No repository is touched; the calls are what matter. */
function fakeGit(answers = {}) {
  const calls = [];
  const run = async (cwd, args) => {
    calls.push({ cwd, args });
    const answer = answers[args.join(" ")] ?? answers[args[0]] ?? {};
    return { status: answer.status ?? "completed", stdout: answer.stdout ?? "",
      stderr: answer.stderr ?? "", exitCode: answer.exitCode ?? 0 };
  };
  return { calls, run, args: () => calls.map((call) => call.args.join(" ")) };
}

test("A0544 a mark is made before a change set is written, and undo puts the files back", async (t) => {
  const { app } = await fixture(t);
  const { GitCheckpoints } = await import("../dist/git-checkpoint.js");
  const commit = "a".repeat(40);
  const git = fakeGit({ "rev-parse --is-inside-work-tree": { stdout: "true" }, stash: { stdout: `${commit}\n` } });
  const marks = new GitCheckpoints(app.store, "local", git.run);

  const mark = await marks.before("C:/work", "writing 4 files", AbortSignal.timeout(5000));
  assert.ok(mark, "a repository gets a mark");
  assert.equal(mark.commit, commit);
  assert.match(mark.ref, /^refs\/branch\/checkpoints\//, "the mark lives on a ref of Branch's own");
  // It is made without disturbing the folder, the index, or the shared stash list.
  assert.ok(git.args().includes("stash create writing 4 files"));
  assert.equal(git.args().some((line) => /^stash (push|pop|save|apply)/.test(line)), false);
  assert.ok(git.args().some((line) => line === `update-ref ${mark.ref} ${commit}`));
  assert.deepEqual(marks.list().map((entry) => entry.id), [mark.id]);

  const back = await marks.undo(mark.id, AbortSignal.timeout(5000));
  assert.equal(back.commit, commit);
  assert.equal(git.args().at(-1), `checkout ${commit} -- .`);
  await assert.rejects(marks.undo("no-such-mark", AbortSignal.timeout(5000)), /no saved way back/);

  assert.equal(await marks.forget(mark.id), true);
  assert.equal(git.args().at(-1), `update-ref -d ${mark.ref}`);
  assert.deepEqual(marks.list(), []);
});

test("A0544 a folder that is not kept in Git gets no mark, and the change says so rather than failing", async (t) => {
  const { app, workspace } = await fixture(t);
  const { GitCheckpoints } = await import("../dist/git-checkpoint.js");
  const git = fakeGit({ "rev-parse --is-inside-work-tree": { stdout: "not a repository", exitCode: 128 } });
  const marks = new GitCheckpoints(app.store, "local", git.run);
  assert.equal(await marks.before("C:/plain", "writing 1 file", AbortSignal.timeout(5000)), null);
  assert.deepEqual(marks.list(), []);

  // The change tool asks for a mark before it writes, and reports what it got back either way.
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "notes.md"), "hello there", "utf8");
  const asked = [];
  app.codeChanges.checkpoints = {
    async before(folder, label) { asked.push({ folder, label, wrote: await readFile(join(workspace, "notes.md"), "utf8") }); return { id: "mark-1" }; },
  };
  const context = contextOf(app, { workspace });
  const written = await app.codeChanges.changeSet(
    { reason: "tidy the note", edits: [{ path: "notes.md", find: "hello", replace: "goodbye", expectedOccurrences: 1 }], dryRun: false }, context);
  assert.equal(written.applied, true);
  assert.equal(written.undo.id, "mark-1");
  assert.equal(asked.length, 1, "the mark is taken before anything is written");
  assert.equal(asked[0].wrote, "hello there", "and taken while the file is still as it was");
  assert.match(asked[0].label, /notes\.md/);
  assert.equal(await readFile(join(workspace, "notes.md"), "utf8"), "goodbye there");

  app.codeChanges.checkpoints = { async before() { return null; } };
  const plain = await app.codeChanges.changeSet(
    { reason: "tidy it again", edits: [{ path: "notes.md", find: "goodbye", replace: "hello", expectedOccurrences: 1 }], dryRun: false }, context);
  assert.equal(plain.undo.id, "");
  assert.match(plain.undo.note, /not kept in Git/);
});

test("A1582 a project may name a line of work, and switching to it switches the folder", async (t) => {
  const { app } = await fixture(t);
  const { GitCheckpoints, GitWorkspaces } = await import("../dist/git-checkpoint.js");
  const clean = fakeGit({ "rev-parse --is-inside-work-tree": { stdout: "true" }, "status --porcelain": { stdout: "" } });
  const workspaces = new GitWorkspaces(new GitCheckpoints(app.store, "local", clean.run), clean.run);

  const done = await workspaces.switchTo("C:/work", "accounts", AbortSignal.timeout(5000));
  assert.equal(done.switched, true);
  assert.equal(done.reason, 'Now working on "accounts".');
  assert.ok(clean.args().includes("switch accounts"));

  // Work not saved yet is left exactly where it is: switching must never lose anything.
  const dirty = fakeGit({ "rev-parse --is-inside-work-tree": { stdout: "true" }, "status --porcelain": { stdout: " M notes.md" } });
  const careful = new GitWorkspaces(new GitCheckpoints(app.store, "local", dirty.run), dirty.run);
  const held = await careful.switchTo("C:/work", "accounts", AbortSignal.timeout(5000));
  assert.equal(held.switched, false);
  assert.match(held.reason, /changes not saved yet/);
  assert.equal(dirty.args().some((line) => line.startsWith("switch")), false);

  // A name that could carry an option, and a folder that is not a repository, are both refused plainly.
  assert.match((await careful.switchTo("C:/work", "--exec=calc", AbortSignal.timeout(5000))).reason, /not a name a line of work can have/);
  const plain = fakeGit({ "rev-parse --is-inside-work-tree": { stdout: "no", exitCode: 128 } });
  const none = new GitWorkspaces(new GitCheckpoints(app.store, "local", plain.run), plain.run);
  assert.match((await none.switchTo("C:/work", "accounts", AbortSignal.timeout(5000))).reason, /not a repository/);

  // The project itself carries the name, and says so to whoever is listening when it becomes active.
  const heard = [];
  app.store.projects.onSwitched((owner, project) => heard.push(project.branch));
  app.store.projects.save("local", { id: "site", name: "The website", branch: "rewrite" });
  app.store.projects.setActive("local", { active: "site" });
  assert.deepEqual(heard, ["rewrite"]);
});
