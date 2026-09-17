import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, PolicyRuleSchema } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import {
  saveWallSettings, tighterNetwork, wallApplies, wallNetworkFor, wallNetworks, wallSettings,
} from "../dist/sandbox.js";
import { seatbeltArgs, sandboxExecPath } from "../dist/sandbox-seatbelt.js";
import {
  bwrapArgs, bwrapAvailability, bwrapMissing, namespacesOff, seccompFilter, seccompStarterScript, withSeccomp,
} from "../dist/sandbox-bwrap.js";
import { SandboxProxy, proxyEnvironment } from "../dist/sandbox-proxy.js";
import { explainDenial, widenable } from "../dist/sandbox-denial.js";
import { openWall, sandboxBackendSet, SandboxBackendSettingsSchema, wallReport } from "../dist/sandbox-backends.js";
import { walledTools, wallContextFor } from "../dist/sandbox-wall.js";
import { ApprovalGate } from "../dist/approvals.js";

/**
 * Wave mac3 (os-sandbox): the wall around programs. Everything here is worked out on paper — the
 * profile, the bubblewrap arguments, the filter bytes — or run against fakes and a local stand-in
 * site. The one exception runs macOS's own sandbox on this Mac, inside temporary folders only.
 */

const memoryStore = (initial = {}) => {
  const saved = new Map(Object.entries(initial));
  return {
    get: (_kind, _owner, key) => (saved.has(key) ? { data: saved.get(key) } : undefined),
    save: (_kind, _owner, key, data) => { saved.set(key, data); },
    run: () => ({ sessionId: "s1" }),
  };
};
const emptyPolicy = { preset: "off", rules: [], limits: { toolCallsPerMinute: 0, modelRoundsPerMinute: 0 }, unmatchedCommands: "allow" };
const wallFor = (overrides = {}) => ({
  network: "per-site", keySites: {}, unreadable: [], answer: () => undefined, granted: () => [], spend() {}, ...overrides,
});

/* ------------------------------------------------------------------ tighten-only */

test("W1 the switch ships off and a rule can only make the wall stricter", () => {
  assert.equal(wallSettings(memoryStore(), "local").mode, "off");
  assert.equal(wallSettings(memoryStore(), "local").network, "none");
  // A damaged record is read as the strictest thing it could mean, never as "off".
  const damaged = wallSettings(memoryStore({ "os-sandbox": { mode: "sideways" } }), "local");
  assert.deepEqual([damaged.mode, damaged.network], ["on", "none"]);
  // Every combination: the wall applies at least whenever the setting alone says so.
  for (const mode of ["off", "when-needed", "on"]) for (const risky of [false, true]) {
    const alone = mode === "on";
    if (alone) assert.equal(wallApplies(mode, risky), true, `${mode}/${risky} dropped the wall`);
    if (risky) assert.equal(wallApplies("when-needed", risky), true);
  }
  assert.equal(wallApplies("off", true), false, "off adds no wall of its own");
  assert.equal(wallApplies("when-needed", false), false);
  for (const network of wallNetworks) for (const choice of [null, undefined, "no-internet", "limits-only", "none"]) {
    const got = wallNetworkFor(network, choice);
    assert.equal(tighterNetwork(got, network), got, `${network} with ${choice} became looser (${got})`);
    if (choice === "no-internet") assert.equal(got, "none");
  }
  assert.equal(tighterNetwork("open", "limited"), "limited");
  assert.equal(tighterNetwork("none", "open"), "none");
  assert.throws(() => saveWallSettings(memoryStore(), "local", { mode: "on", netless: false }), /Unrecognized key/);
});

test("W2 the runtime hands the wall only to program tools, from the owner's settings and rules", () => {
  const base = { owner: "local", approvals: new ApprovalGate(), permission: "shell.execute", target: "ls", args: {},
    context: { runId: "r1" }, choice: null, policy: emptyPolicy };
  const off = memoryStore();
  assert.deepEqual(wallContextFor({ ...base, store: off, tool: "shell.execute" }), {}, "off hands nothing");
  const on = memoryStore({ "os-sandbox": { mode: "on", network: "open" } });
  assert.deepEqual(wallContextFor({ ...base, store: on, tool: "files.write" }), {}, "not a program tool");
  assert.deepEqual([...walledTools].sort(), ["code.run", "process.start", "shell.execute"]);
  const given = wallContextFor({ ...base, store: on, tool: "shell.execute" }).osSandbox;
  if (process.platform === "win32") { assert.equal(given, undefined, "Windows is left exactly as it was"); return; }
  assert.equal(given.network, "open");
  // A rule that says "no internet" makes the wall's network stricter too.
  assert.equal(wallContextFor({ ...base, store: on, tool: "shell.execute", choice: "no-internet" }).osSandbox.network, "none");
  // "When needed": nothing for a call no rule asks about; the wall for one a rule asks about.
  const needed = memoryStore({ "os-sandbox": { mode: "when-needed", network: "none" } });
  assert.deepEqual(wallContextFor({ ...base, store: needed, tool: "shell.execute" }), {});
  const asking = { ...emptyPolicy, rules: [PolicyRuleSchema.parse({ tool: "shell.execute", decision: "ask" })] };
  assert.ok(wallContextFor({ ...base, store: needed, tool: "shell.execute", policy: asking }).osSandbox);
  assert.ok(wallContextFor({ ...base, store: needed, tool: "shell.execute", choice: "limits-only" }).osSandbox);
});

test("W3 site answers come from explicit rules and this conversation's yeses; a no always wins", () => {
  if (process.platform === "win32") return;
  const approvals = new ApprovalGate();
  const rules = [
    PolicyRuleSchema.parse({ tool: "*", decision: "allow" }),
    PolicyRuleSchema.parse({ tool: "network.site", match: "blocked.test", decision: "deny" }),
    PolicyRuleSchema.parse({ tool: "network.site", match: "always.test", decision: "allow" }),
    PolicyRuleSchema.parse({ tool: "sandbox.write", match: "/tmp/kept.txt", decision: "allow" }),
    PolicyRuleSchema.parse({ tool: "sandbox.write", match: "/tmp/*", decision: "allow" }),
  ];
  const wall = wallContextFor({ store: memoryStore({ "os-sandbox": { mode: "on", network: "per-site" } }), owner: "local",
    approvals, context: { runId: "r1" }, tool: "shell.execute", permission: "shell.execute", target: "x", args: {},
    choice: null, policy: { ...emptyPolicy, rules } }).osSandbox;
  assert.equal(wall.answer("network.site", "new.test"), undefined, "a broad * rule never opens a site");
  assert.equal(wall.answer("network.site", "always.test"), "allow");
  approvals.remember("s1", "network.site", "blocked.test", "allow");
  assert.equal(wall.answer("network.site", "blocked.test"), "deny", "a rule's no beats a yes");
  approvals.remember("s1", "network.site", "always.test", "deny");
  assert.equal(wall.answer("network.site", "always.test"), "deny", "a conversation's no beats a rule's yes");
  approvals.remember("s1", "sandbox.write", "/tmp/once.txt", "allow");
  assert.deepEqual(wall.granted("sandbox.write").sort(), ["/tmp/kept.txt", "/tmp/once.txt"], "a pattern is never a standing widening");
  wall.spend("sandbox.write", "/tmp/once.txt");
  assert.deepEqual(wall.granted("sandbox.write"), ["/tmp/kept.txt"], "a yes for one retry is used up");
});

/* ------------------------------------------------------------------ macOS profile */

test("W4 the macOS profile never contains a path, and writes stop at the workspace", () => {
  const workspace = '/Users/o/work "(allow file-write*)"';
  const args = seatbeltArgs({ workspace, network: "none", home: "/Users/o", temp: ["/private/tmp"], unreadable: ["/Volumes/Keys"],
    extraWrites: ["/Users/o/notes.txt"], dataDir: "/Users/o/.branch-data" }, { executable: "/usr/bin/env", args: ["ls", "-la"] });
  assert.equal(args[0], "-p");
  const profile = args[1];
  assert.match(profile, /^\(version 1\)\n\(deny default\)/);
  assert.ok(!profile.includes("/Users/o"), "no path is pasted into the profile");
  assert.ok(!/network-outbound|network-inbound/.test(profile), "no network when none is allowed");
  assert.deepEqual(args.slice(-4), ["--", "/usr/bin/env", "ls", "-la"]);
  const params = Object.fromEntries(args.filter((arg) => arg.startsWith("-D")).map((arg) => arg.slice(2).split(/=(.*)/s).slice(0, 2)));
  assert.equal(params.WRITE_0, workspace);
  assert.equal(params.WRITE_1, "/private/tmp");
  assert.equal(params.GRANTED_0, "/Users/o/notes.txt");
  assert.equal(params.KEEP_0, `${workspace}/.git`);
  assert.equal(params.KEEP_1, `${workspace}/.branch`);
  assert.equal(params.KEEP_2, `${workspace}/.agents`);
  const hidden = Object.entries(params).filter(([key]) => key.startsWith("HIDDEN_")).map(([, value]) => value);
  for (const place of ["/Users/o/.ssh", "/Users/o/.aws", "/Users/o/Library/Keychains", "/Volumes/Keys", "/Users/o/.branch-data"])
    assert.ok(hidden.includes(place), `${place} is readable`);
  // The refusals come after every allowance, so none of them can be reopened.
  const lastAllow = profile.lastIndexOf("(allow file-write*");
  assert.ok(profile.indexOf('(deny file-write* (literal (param "KEEP_0"))') > lastAllow);
  assert.ok(profile.indexOf('(deny file-read* file-write* (literal (param "HIDDEN_0"))') > lastAllow);
  assert.throws(() => seatbeltArgs({ workspace: "relative/path", network: "none" }, { executable: "/bin/ls", args: [] }), /full paths/);
});

test("W5 behind the door, only the door's ports are reachable", () => {
  const command = { executable: "/usr/bin/curl", args: [] };
  const door = seatbeltArgs({ workspace: "/w", network: "per-site", proxyPorts: [4100, 4101], temp: [] }, command)[1];
  assert.match(door, /\(allow network-outbound \(remote ip "localhost:4100"\)\)/);
  assert.match(door, /\(allow network-outbound \(remote ip "localhost:4101"\)\)/);
  assert.ok(!/\(allow network-outbound\)\n/.test(door), "not the whole internet");
  const open = seatbeltArgs({ workspace: "/w", network: "open", temp: [] }, command)[1];
  assert.match(open, /\(allow network-outbound\)\n/);
  // A port that is not a real port gives no network at all rather than some network.
  const bad = seatbeltArgs({ workspace: "/w", network: "per-site", proxyPorts: [4100, 70000], temp: [] }, command)[1];
  assert.ok(!bad.includes("network-outbound"));
  const noDoor = seatbeltArgs({ workspace: "/w", network: "limited", temp: [] }, command)[1];
  assert.ok(!noDoor.includes("network-outbound"), "limited with no door is no network");
});

/* ------------------------------------------------------------------ Linux arguments and filter */

test("W6 bubblewrap arguments: read-only disk, writable workspace, protected folders, no network", () => {
  const kinds = { "/home/o/.ssh": "dir", "/home/o/.netrc": "file" };
  const args = bwrapArgs({ workspace: "/home/o/work", network: "none", home: "/home/o", temp: "/tmp", seccompFd: 9,
    extraWrites: ["/home/o/notes"], kindOf: (path) => kinds[path] ?? null }, { executable: "/usr/bin/python3", args: ["-c", "1"] });
  const joined = args.join(" ");
  for (const flag of ["--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-net", "--proc /proc", "--ro-bind / /",
    "--bind /tmp /tmp", "--bind /home/o/work /home/o/work", "--bind-try /home/o/notes /home/o/notes",
    "--ro-bind-try /home/o/work/.git /home/o/work/.git", "--ro-bind-try /home/o/work/.agents /home/o/work/.agents",
    "--tmpfs /home/o/.ssh --remount-ro /home/o/.ssh", "--ro-bind /dev/null /home/o/.netrc", "--seccomp 9", "--chdir /home/o/work"])
    assert.ok(joined.includes(flag), `missing ${flag}`);
  assert.ok(!joined.includes("/home/o/.aws"), "a place that is not there needs nothing hidden");
  assert.ok(joined.indexOf("--ro-bind-try /home/o/work/.git") > joined.indexOf("--bind /home/o/work"), ".git is put back read-only after the workspace");
  assert.deepEqual(args.slice(-4), ["--", "/usr/bin/python3", "-c", "1"]);
  const open = bwrapArgs({ workspace: "/w", network: "open", kindOf: () => null }, { executable: "/bin/true", args: [] });
  assert.ok(!open.includes("--unshare-net"));
  const door = bwrapArgs({ workspace: "/w", network: "per-site", doorDir: "/tmp/door", kindOf: () => null }, { executable: "/bin/true", args: [] });
  assert.ok(door.includes("--unshare-net"), "behind the door the program still has a network of its own");
  assert.ok(door.join(" ").includes("--bind /tmp/door /tmp/door"));
  const started = withSeccomp("/usr/bin/bwrap", "/tmp/f.bpf", ["--x"]);
  assert.deepEqual(started, { executable: "/bin/sh", args: ["-c", seccompStarterScript, "branch-wall", "/tmp/f.bpf", "/usr/bin/bwrap", "--x"] });
  assert.ok(!seccompStarterScript.includes("/tmp"), "the starter line is fixed text");
});

/** A tiny classic-BPF reader, enough to run the filter on paper. */
function runFilter(bytes, data) {
  const view = (offset) => (offset === 0 ? data.nr : offset === 4 ? data.arch : offset === 16 ? data.arg0 : 0);
  let acc = 0;
  for (let pc = 0; pc < bytes.length / 8;) {
    const code = bytes.readUInt16LE(pc * 8), jt = bytes[pc * 8 + 2], jf = bytes[pc * 8 + 3], k = bytes.readUInt32LE(pc * 8 + 4);
    if (code === 0x20) { acc = view(k); pc += 1; }
    else if (code === 0x15) pc += 1 + (acc === k ? jt : jf);
    else if (code === 0x35) pc += 1 + (acc >= k ? jt : jf);
    else if (code === 0x06) return k;
    else throw new Error(`unknown op ${code}`);
  }
  throw new Error("fell off the end");
}

test("W7 the system-call filter refuses tracing, non-local sockets with no network, and foreign calls", () => {
  const KILL = 0x80000000, EPERM = 0x00050001, ALLOW = 0x7fff0000;
  const x64 = 0xc000003e, arm64 = 0xc00000b7;
  const none = seccompFilter({ network: "none", arch: "x64" });
  assert.equal(runFilter(none, { arch: x64, nr: 101 }), EPERM, "ptrace");
  assert.equal(runFilter(none, { arch: x64, nr: 41, arg0: 2 }), EPERM, "an internet socket");
  assert.equal(runFilter(none, { arch: x64, nr: 41, arg0: 1 }), ALLOW, "a local socket");
  assert.equal(runFilter(none, { arch: x64, nr: 0 }), ALLOW, "read");
  assert.equal(runFilter(none, { arch: x64, nr: 0x40000029 }), KILL, "an x32 call");
  assert.equal(runFilter(none, { arch: 0x40000003, nr: 1 }), KILL, "another processor type");
  const door = seccompFilter({ network: "per-site", arch: "arm64" });
  assert.equal(runFilter(door, { arch: arm64, nr: 117 }), EPERM, "ptrace on arm64");
  assert.equal(runFilter(door, { arch: arm64, nr: 198, arg0: 2 }), ALLOW, "the door needs a local internet socket");
  assert.equal(runFilter(seccompFilter({ network: "none", arch: "arm64" }), { arch: arm64, nr: 198, arg0: 10 }), EPERM);
  assert.throws(() => seccompFilter({ network: "none", arch: "mips" }), /cannot filter/);
});

test("W8 a missing bwrap or switched-off namespaces is a plain refusal", async () => {
  const probe = (answer) => async (executable, args) => { probe.calls.push([executable, ...args]); return answer; };
  probe.calls = [];
  assert.deepEqual(await bwrapAvailability(probe({ code: 0, stderr: "", missing: false }), async () => null), { ok: false, reason: bwrapMissing });
  assert.deepEqual(await bwrapAvailability(probe({ code: 1, stderr: "setting up uid map: Permission denied", missing: false }), async () => "/usr/bin/bwrap"),
    { ok: false, reason: namespacesOff });
  assert.deepEqual(await bwrapAvailability(probe({ code: 0, stderr: "", missing: false }), async () => "/usr/bin/bwrap"), { ok: true, path: "/usr/bin/bwrap" });
  assert.deepEqual(probe.calls.at(-1), ["/usr/bin/bwrap", "--unshare-user", "--ro-bind", "/", "/", "--", "/bin/true"]);
  const linux = await wallReport({ platform: "linux", locateBwrap: async () => null });
  assert.deepEqual(linux, { platform: "linux", available: false, reason: bwrapMissing });
  assert.equal((await wallReport({ platform: "win32" })).available, false);
  assert.equal((await wallReport({ platform: "darwin", exists: async () => true })).available, true);
});

/* ------------------------------------------------------------------ putting a program behind it */

const plain = (cwd) => ({ executable: "/usr/bin/printenv", args: ["TOKEN"], cwd, env: { PATH: "/usr/bin", TOKEN: "real-value-1234" } });

test("W9 on Windows the start is handed back untouched; elsewhere nothing starts without a wall", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-wall-"));
  t.after(() => discardTemp(root));
  const start = plain(root);
  const windows = await openWall(wallFor(), start, { workspace: root }, { platform: "win32" });
  assert.equal(windows.start, start, "Windows is left exactly as it was");
  await assert.rejects(openWall(wallFor(), start, { workspace: root }, { platform: "freebsd" }), /macOS and Linux only/);
  await assert.rejects(openWall(wallFor(), start, { workspace: root }, { platform: "darwin", exists: async () => false }), /sandbox-exec\) is missing/);
  await assert.rejects(openWall(wallFor(), start, { workspace: root }, { platform: "linux", locateBwrap: async () => null }), /needs bubblewrap/);
});

test("W10 macOS: the program sees a stand-in key and only the door; a new site stops the task with a question", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-wall-")));
  t.after(() => discardTemp(root));
  const wall = wallFor({ keySites: { TOKEN: "api.example.test" } });
  const opened = await openWall(wall, plain(root), { workspace: root, secrets: { TOKEN: "real-value-1234" } },
    { platform: "darwin", exists: async (path) => path === sandboxExecPath });
  t.after(() => opened.close());
  assert.equal(opened.start.executable, "/usr/bin/sandbox-exec");
  assert.match(opened.start.env.TOKEN, /^branch_[a-f0-9]{32}$/);
  assert.ok(!JSON.stringify(opened.start).includes("real-value-1234"), "the real key is nowhere in what starts");
  const port = Number(new URL(opened.start.env.HTTP_PROXY).port);
  assert.match(opened.start.args[1], new RegExp(`localhost:${port}`));
  assert.match(opened.start.env.ALL_PROXY, /^socks5h:\/\/127\.0\.0\.1:\d+$/);
  // A program tries a site nobody has decided about.
  const refused = await new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => socket.write("GET http://new.example.test/ HTTP/1.1\r\nHost: new.example.test\r\nConnection: close\r\n\r\n"));
    let text = ""; socket.on("data", (chunk) => { text += chunk; }); socket.on("end", () => resolve(text)); socket.on("close", () => resolve(text));
  });
  assert.match(refused, /403/);
  await assert.rejects(opened.finish({ exitCode: 6, stdout: "", stderr: "" }),
    (error) => error.name === "ApprovalRequiredError" && error.tool === "network.site" && error.target === "new.example.test");
});

test("W11 a blocked write names the file once, the yes widens exactly that file, and it is used up", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-wall-")));
  t.after(() => discardTemp(root));
  const deps = { platform: "darwin", exists: async () => true };
  const blocked = { exitCode: 1, stdout: "", stderr: "touch: /Users/o/report.txt: Operation not permitted\n" };
  const first = await openWall(wallFor({ network: "none" }), plain(root), { workspace: root }, deps);
  await assert.rejects(first.finish(blocked), (error) => error.tool === "sandbox.write" && error.target === "/Users/o/report.txt"
    && /let the next try write to it, once/.test(error.label));
  const spent = [];
  const granted = wallFor({ network: "none", granted: () => ["/Users/o/report.txt", join(homedir(), ".ssh", "config")], spend: (kind, path) => spent.push(path) });
  const second = await openWall(granted, plain(root), { workspace: root }, deps);
  assert.ok(second.start.args.includes("-DGRANTED_0=/Users/o/report.txt"));
  assert.ok(!second.start.args.some((arg) => arg.startsWith("-DGRANTED_1")), "a hidden place is never widened");
  assert.deepEqual(spent, ["/Users/o/report.txt"]);
  // Still failing after the one retry: a sentence, not another question.
  assert.match(await second.finish(blocked), /stopped this command writing to \/Users\/o\/report\.txt/);
  const answered = await openWall(wallFor({ network: "none", answer: () => "deny" }), plain(root), { workspace: root }, deps);
  assert.match(await answered.finish(blocked), /stopped this command writing/);
  const offline = await openWall(wallFor({ network: "none" }), plain(root), { workspace: root }, deps);
  assert.match(await offline.finish({ exitCode: 6, stdout: "", stderr: "curl: (6) Could not resolve host: example.com" }), /reaching the internet/);
});

test("W12 Linux: bwrap through the fixed starter, the filter written, the door bridged, all cleaned up", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-wall-")));
  t.after(() => discardTemp(root));
  const probed = [];
  const deps = { platform: "linux", locateBwrap: async () => "/usr/bin/bwrap", kindOf: () => null,
    probe: async (executable, args) => { probed.push([executable, ...args]); return { code: 0, stdout: "", stderr: "", missing: false }; } };
  const opened = await openWall(wallFor({ keySites: { TOKEN: "api.example.test" } }), plain(root), { workspace: root, secrets: { TOKEN: "real-value-1234" } }, deps);
  assert.equal(opened.start.executable, "/bin/sh");
  const [flag, script, name, filter, bwrap, ...rest] = opened.start.args;
  assert.deepEqual([flag, script, name, bwrap], ["-c", seccompStarterScript, "branch-wall", "/usr/bin/bwrap"]);
  assert.equal((await readFile(filter)).length % 8, 0, "the filter is whole instructions");
  const marker = rest.indexOf("--");
  assert.equal(rest[marker + 1], process.execPath, "the door's bridge runs first inside the wall");
  assert.deepEqual([rest[marker + 4], rest[marker + 6], rest[marker + 7]], ["3128", "1080", "--"]);
  assert.deepEqual(rest.slice(-3), ["--", "/usr/bin/printenv", "TOKEN"]);
  assert.equal(opened.start.env.HTTP_PROXY, "http://127.0.0.1:3128");
  assert.match(opened.start.env.TOKEN, /^branch_/);
  assert.ok(rest.includes("--unshare-net"));
  const staging = dirname(filter);
  assert.ok(rest.join(" ").includes(`--bind ${staging} ${staging}`), "the door's folder is shared with the program");
  assert.ok((await stat(staging)).isDirectory());
  await opened.close();
  assert.equal(await stat(staging).catch(() => null), null, "the door's folder is gone");
});

test("W13 the plain box puts scripts behind the wall only when the call carries one", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-wall-")));
  t.after(() => discardTemp(root));
  const spawned = [];
  const spawn = async (options) => { spawned.push(options); return { status: "failed", exitCode: 1, stdout: "", stderr: "boom", truncated: false, durationMs: 1 }; };
  const set = sandboxBackendSet({ settings: SandboxBackendSettingsSchema.parse({}), spawn,
    probe: async () => ({ code: 0, stdout: "", stderr: "", missing: false }), wall: { platform: "darwin", exists: async () => true } });
  const handle = await set["job-object"].prepare({ hostPath: root });
  const limits = { timeoutMs: 1000, maxMemoryMb: 64, maxCpuSeconds: 1, maxOutputBytes: 1000, network: false, job: false };
  const bare = await handle.run({ executable: "/bin/echo", args: ["hi"] }, limits, AbortSignal.timeout(5000));
  assert.deepEqual(bare.argv, ["/bin/echo", "hi"], "no wall, no change");
  const walled = await handle.run({ executable: "/bin/echo", args: ["hi"] }, { ...limits, wall: wallFor({ network: "none" }) }, AbortSignal.timeout(5000));
  assert.equal(walled.argv[0], "/usr/bin/sandbox-exec");
  assert.equal(spawned[1].executable, "/usr/bin/sandbox-exec");
  const kept = await handle.argvFor({ executable: "/bin/sleep", args: ["9"] }, { ...limits, wall: wallFor({ network: "per-site" }) });
  assert.equal(kept.executable, "/usr/bin/sandbox-exec");
  assert.equal(kept.env.HTTP_PROXY, "http://127.0.0.1:9", "a program left running gets no door, only the dead address");
  assert.ok(!kept.args[1].includes("network-outbound"));
});

/* ------------------------------------------------------------------ denials */

test("W14 a denial is told apart from an ordinary failure", () => {
  const options = { network: "open", workspace: "/w", hidden: ["/home/o/.ssh"] };
  assert.equal(explainDenial({ exitCode: 0, stdout: "", stderr: "Operation not permitted" }, options), null);
  assert.equal(explainDenial({ exitCode: 127, stdout: "", stderr: "sandbox: command not found" }, options), null);
  assert.equal(explainDenial({ exitCode: 1, stdout: "", stderr: "error: tests failed" }, options), null);
  assert.equal(explainDenial({ exitCode: 1, stdout: "", stderr: "OSError: [Errno 30] Read-only file system: '/usr/lib/x.pyc'" }, options).path, "/usr/lib/x.pyc");
  assert.equal(explainDenial({ exitCode: 1, stdout: "", stderr: "open /w/.git/hooks/pre-commit: operation not permitted" }, options).path, undefined);
  assert.equal(explainDenial({ exitCode: 1, stdout: "", stderr: "Permission denied" }, options).kind, "unknown");
  assert.equal(explainDenial({ exitCode: 6, stdout: "", stderr: "Could not resolve host" }, options), null, "with network allowed, a lookup failure is just a failure");
  assert.equal(widenable("/home/o/.ssh/id_ed25519", options), false);
  assert.equal(widenable("/w/.agents/x", options), false);
  assert.equal(widenable("/", options), false);
  assert.equal(widenable("/home/o/out.txt", options), true);
});

/* ------------------------------------------------------------------ the door */

async function fakeSite(t) {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json", "x-echo": request.headers.authorization ?? "" });
    response.end(JSON.stringify({ echo: request.headers.authorization ?? "", leaked: "aws_secret_access_key=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, port: server.address().port };
}

async function door(t, options) {
  const proxy = new SandboxProxy(options);
  const address = await proxy.start();
  t.after(() => proxy.close());
  const raw = (text) => new Promise((resolve) => {
    const socket = connect(address.httpPort, "127.0.0.1", () => socket.write(text));
    let got = ""; socket.on("data", (chunk) => { got += chunk; }); socket.on("close", () => resolve(got));
    setTimeout(() => socket.end(), 500);
  });
  return { proxy, address, raw };
}

test("W15 the door asks about new sites, keeps to reading in limited mode, and follows the owner's rules", async (t) => {
  const site = await fakeSite(t);
  const answers = { "ok.test": "allow", "no.test": "deny", "ruled.test": "allow" };
  const { proxy, raw } = await door(t, { network: "limited", decide: (host) => answers[host] ?? "ask",
    check: async (url) => { if (url.hostname === "ruled.test") throw new Error("ruled.test is on the blocked list"); },
    upstream: () => ({ host: "127.0.0.1", port: site.port, secure: false }) });
  assert.match(await raw("GET http://ok.test/a HTTP/1.1\r\nHost: ok.test\r\nConnection: close\r\n\r\n"), /^HTTP\/1\.1 200/);
  assert.match(await raw("POST http://ok.test/a HTTP/1.1\r\nHost: ok.test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"), /405[\s\S]*only read/);
  assert.match(await raw("CONNECT ok.test:443 HTTP/1.1\r\nHost: ok.test:443\r\n\r\n"), /403[\s\S]*secure tunnel/);
  assert.match(await raw("GET http://no.test/ HTTP/1.1\r\nHost: no.test\r\nConnection: close\r\n\r\n"), /403[\s\S]*not allowed programs to reach no\.test/);
  assert.match(await raw("GET http://ruled.test/ HTTP/1.1\r\nHost: ruled.test\r\nConnection: close\r\n\r\n"), /blocked list/);
  assert.match(await raw("GET http://new.test/ HTTP/1.1\r\nHost: new.test\r\nConnection: close\r\n\r\n"), /asking the owner/);
  assert.deepEqual(proxy.asked, ["new.test"]);
  assert.deepEqual(site.seen.map((entry) => entry.method), ["GET"], "only the allowed read reached the site");
});

test("W16 a stand-in becomes the real key only for its own site, and the answer comes back clean", async (t) => {
  const site = await fakeSite(t);
  const keys = [{ name: "TOKEN", placeholder: `branch_${"a".repeat(32)}`, value: "real-value-1234", site: "api.example.test" }];
  const routed = [];
  const { proxy, raw } = await door(t, { network: "per-site", decide: () => "allow", keys,
    upstream: (target) => { routed.push(target); return { host: "127.0.0.1", port: site.port, secure: false }; } });
  const answer = await raw(`GET http://api.example.test/me HTTP/1.1\r\nHost: api.example.test\r\nAuthorization: Bearer ${keys[0].placeholder}\r\nConnection: close\r\n\r\n`);
  assert.equal(site.seen[0].authorization, "Bearer real-value-1234", "the site got the real key");
  assert.deepEqual(routed[0], { host: "api.example.test", port: 443, secure: true }, "a real key only ever goes out over a secure connection");
  assert.ok(!answer.includes("real-value-1234"), "the key is taken back out of the answer");
  assert.match(answer, /\[secret TOKEN\]/);
  assert.match(answer, /hidden key-like value/);
  assert.ok(proxy.hidden.size > 0);
  const elsewhere = await raw(`GET http://evil.test/ HTTP/1.1\r\nHost: evil.test\r\nX-Key: ${keys[0].placeholder}\r\nConnection: close\r\n\r\n`);
  assert.match(elsewhere, /403[\s\S]*belongs to api\.example\.test/);
  const unknown = await raw(`GET http://api.example.test/ HTTP/1.1\r\nHost: api.example.test\r\nX-Key: branch_${"b".repeat(32)}\r\nConnection: close\r\n\r\n`);
  assert.match(unknown, /stand-in key Branch does not know/);
  assert.equal(site.seen.length, 1);
});

test("W17 the SOCKS door connects only where the owner said yes", async (t) => {
  const site = await fakeSite(t);
  const { address } = await door(t, { network: "per-site", decide: (host) => (host === "ok.test" ? "allow" : "ask"),
    upstream: () => ({ host: "127.0.0.1", port: site.port, secure: false }) });
  const socks = (host) => new Promise((resolve) => {
    const socket = connect(address.socksPort, "127.0.0.1");
    const replies = [];
    socket.on("data", (chunk) => {
      replies.push(chunk);
      if (replies.length === 1) socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), Buffer.from(host), Buffer.from([0, 80])]));
      else if (replies.length === 2 && chunk[1] === 0) socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("close", () => resolve(replies));
    socket.write(Buffer.from([5, 1, 0]));
  });
  const yes = await socks("ok.test");
  assert.equal(yes[1][1], 0, "connected");
  assert.match(Buffer.concat(yes.slice(2)).toString(), /200 OK/);
  const no = await socks("other.test");
  assert.equal(no[1][1], 2, "refused");
  assert.deepEqual(proxyEnvironment({ httpPort: 1, socksPort: 2 }).ALL_PROXY, "socks5h://127.0.0.1:2");
});

/* ------------------------------------------------------------------ the app */

test("W18 the runtime hands program tools the wall; a short-lived key cannot take it down", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-wall-app-"));
  let turn = 0;
  const provider = { name: "scripted", async complete() {
    turn += 1;
    return turn === 1 ? { content: "", toolCalls: [{ id: "c1", name: "code.run", arguments: JSON.stringify({ language: "javascript", source: "1+1" }) }] }
      : { content: "done", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, presence: "daemon" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const host = new URL(server.url).host;
  const call = (method, path, body, token = server.token) => fetch(server.url + path, { method,
    headers: { authorization: `Bearer ${token}`, host, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (response) => ({ status: response.status, body: await response.json() }));

  const first = await call("GET", "/api/os-sandbox");
  assert.equal(first.status, 200);
  assert.equal(first.body.settings.mode, "off", "ships off");
  assert.equal(typeof first.body.computer.available, "boolean");
  const acting = app.sessionTokens.create(app.runtime.owner, { scope: "run", minutes: 60 });
  const sneaky = await call("POST", "/api/os-sandbox", { mode: "off" }, acting.token);
  assert.equal(sneaky.status, 401);
  assert.match(sneaky.body.error, /cannot change the wall/);
  assert.equal((await call("POST", "/api/sandboxes", { windowsSandbox: true }, acting.token)).status, 401);
  const saved = await call("POST", "/api/os-sandbox", { mode: "on", network: "per-site", keySites: { GITHUB_TOKEN: "API.GitHub.com" }, unreadable: [] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.settings.keySites, { GITHUB_TOKEN: "api.github.com" });

  const seen = [];
  const registry = app.runtime.registry;
  const original = registry.execute.bind(registry);
  registry.execute = async (name, args, context) => {
    if (name !== "code.run") return original(name, args, context);
    seen.push(context.osSandbox);
    return { ok: true };
  };
  await app.runtime.run({ prompt: "add", source: "owner" });
  assert.equal(seen.length, 1);
  if (process.platform === "win32") assert.equal(seen[0], undefined, "Windows is left exactly as it was");
  else {
    assert.equal(seen[0].network, "per-site");
    assert.deepEqual(seen[0].keySites, { GITHUB_TOKEN: "api.github.com" });
    assert.ok(seen[0].unreadable.some((place) => place.endsWith("data")), "Branch's own data folder is hidden");
    assert.equal(typeof seen[0].siteCheck, "function", "the door asks the owner's network rules");
  }
});

/* ------------------------------------------------------------------ the real thing, on this Mac */

test("W19 macOS's own sandbox refuses a write outside the workspace and allows one inside", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-wall-real-")));
  t.after(() => discardTemp(root));
  const workspace = join(root, "workspace"), outside = join(root, "outside");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(outside);
  const targets = { inside: join(workspace, "a.txt"), git: join(workspace, ".git", "hook"), outside: join(outside, "b.txt") };
  const script = `const fs=require("fs");const out={};for(const [k,p] of Object.entries(${JSON.stringify(targets)})){try{fs.writeFileSync(p,"x");out[k]="written"}catch(e){out[k]=e.code}}try{fs.readdirSync(${JSON.stringify(join(homedir(), ".ssh"))});out.keys="read"}catch(e){out.keys=e.code}console.log(JSON.stringify(out))`;
  // The temporary folder is writable by design, so for this check only a folder that holds nothing counts as "temporary".
  const args = seatbeltArgs({ workspace, network: "none", temp: [join(root, "scratch")] }, { executable: process.execPath, args: ["-e", script] });
  const output = await new Promise((resolve, reject) => execFile(sandboxExecPath, args, { cwd: workspace, timeout: 20_000 },
    (error, stdout) => (error ? reject(error) : resolve(stdout))));
  const result = JSON.parse(output.trim());
  assert.equal(result.inside, "written");
  assert.equal(result.git, "EPERM", ".git stays read-only");
  assert.equal(result.outside, "EPERM", "a write outside the workspace is refused");
  assert.notEqual(result.keys, "read", "where keys live is not readable");
  assert.equal(await stat(targets.outside).catch(() => null), null, "nothing was written outside");
});

/* ------------------------------------------------------------------ the card */

test("W20 the card lives in Settings, Computer, speaks French, fits 400 px and saves", async (t) => {
  const { chromium } = await import("playwright");
  const { openSettings } = await import("./places.mjs");
  const root = await mkdtemp(join(tmpdir(), "branch-wall-ui-"));
  const provider = { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  const card = page.locator("#os-sandbox-card");
  await card.waitFor({ state: "attached" });
  assert.equal(await card.getAttribute("data-home"), "settings:computer");
  await openSettings(page, "computer");
  await card.scrollIntoViewIfNeeded();
  assert.match(await card.textContent(), /The wall around programs/);
  assert.equal(await page.locator("#os-sandbox-mode").inputValue(), "off");
  assert.equal(await card.locator("button:not(.quiet-button)").count(), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "the page scrolls sideways");
  const wide = await page.evaluate(() => [...document.querySelectorAll("#os-sandbox-card *")]
    .filter((node) => node.getBoundingClientRect().right > document.documentElement.clientWidth + 1 || node.scrollWidth > node.clientWidth + 1)
    .map((node) => `${node.tagName} ${node.textContent.slice(0, 30)}`));
  assert.deepEqual(wide, []);
  await page.locator("#os-sandbox-mode").selectOption("when-needed");
  await page.locator("#os-sandbox-network").selectOption("per-site");
  await page.locator("#os-sandbox-keys").fill("GITHUB_TOKEN api.github.com");
  await card.getByRole("button", { name: "Save the wall" }).click();
  await page.locator("#os-sandbox-card [role=status]", { hasText: "Saved." }).waitFor();
  const saved = wallSettings(app.store, app.runtime.owner);
  assert.deepEqual([saved.mode, saved.network, saved.keySites], ["when-needed", "per-site", { GITHUB_TOKEN: "api.github.com" }]);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.getElementById("os-sandbox-card")?.textContent.includes("Le mur autour des programmes"));
  assert.deepEqual(errors, []);
});
