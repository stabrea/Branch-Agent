// FQ-execution.desktop: the shared Linux desktop (VNC/Xvfb) and the owner taking it over. Every
// "docker"/"xdotool" call here is a fake that only records what it was asked, so this file needs
// no Docker and touches no real display; the pure argv builders prove the real commands are right.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, Budget } from "../dist/index.js";
import {
  LinuxDesktopSandbox, dockerRunArgv, dockerExecArgv, dockerStopArgv, xvfbArgv, x11vncArgv, xdotoolArgv,
  readLinuxDesktop, saveLinuxDesktop, switchedOffMessage, takenOverMessage, notRunningMessage, vncPort, display,
} from "../dist/integrations/linux-desktop.js";

const runContext = (runId, owner, permissions) => ({
  owner, workspace: ".", runId, signal: new AbortController().signal, budget: new Budget(),
  permissions: new Set(permissions), depth: 0,
});

/** A fake `docker`/`xdotool` runner that only records what it was asked and answers with a fixed id. */
function fakeRunner({ image = "branch-linux-desktop:latest" } = {}) {
  const calls = [];
  const runner = async (file, args) => {
    calls.push({ file, args });
    if (args[0] === "image" && args[1] === "inspect") return "ok";
    if (args[0] === "run") return "abcdef012345\n";
    return "";
  };
  return { calls, runner, image };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-shared-desktop-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } },
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}

// -------------------------------------------------------------- the commands themselves

test("Xvfb, x11vnc and the container's docker run line are built exactly, and nothing is ever pulled", () => {
  assert.deepEqual(xvfbArgv(), [":1", "-screen", "0", "1280x800x24", "-nolisten", "tcp"]);
  assert.deepEqual(x11vncArgv("s3cr3t"), ["-display", ":1", "-rfbport", "5900", "-passwd", "s3cr3t", "-forever", "-shared", "-quiet"]);
  const argv = dockerRunArgv("branch-linux-desktop:latest", 15900, "s3cr3t");
  assert.ok(argv.includes("--pull=never"), "the image is never pulled automatically");
  assert.ok(argv.includes("--cap-drop"));
  assert.deepEqual(argv.slice(argv.indexOf("-p"), argv.indexOf("-p") + 2), ["-p", "127.0.0.1:15900:5900"], "the VNC port stays on this computer only");
  assert.equal(argv.at(-4), "branch-linux-desktop:latest");
  assert.equal(argv.at(-3), "sh");
});

test("xdotool argument lists for opening a program, typing and a key press", () => {
  assert.deepEqual(xdotoolArgv({ type: "open", app: "xterm" }), ["spawn", "xterm"]);
  assert.deepEqual(xdotoolArgv({ type: "type", text: "hello" }), ["type", "--clearmodifiers", "hello"]);
  assert.deepEqual(xdotoolArgv({ type: "key", chord: "ctrl+s" }), ["key", "--clearmodifiers", "ctrl+s"]);
  const exec = dockerExecArgv("abc123", { type: "open", app: "xterm" });
  assert.deepEqual(exec, ["exec", "-e", "DISPLAY=:1", "abc123", "xdotool", "spawn", "xterm"]);
  assert.deepEqual(dockerStopArgv("abc123"), ["stop", "abc123"]);
});

// -------------------------------------------------------------- settings

test("the switch is off until the owner turns it on, and the image name is saved", async (t) => {
  const { app } = await fixture(t);
  const before = readLinuxDesktop(app.store, "local");
  assert.equal(before.mode, "off");
  const after = saveLinuxDesktop(app.store, "local", { mode: "on", image: "my-desktop:1" });
  assert.equal(after.mode, "on");
  assert.equal(after.image, "my-desktop:1");
  assert.deepEqual(readLinuxDesktop(app.store, "local"), after);
});

// -------------------------------------------------------------- the sandbox itself

test("starting the shared desktop is refused in plain words while the switch is off", async (t) => {
  const { app } = await fixture(t);
  const { runner } = fakeRunner();
  const desktop = new LinuxDesktopSandbox(app.store, {});
  desktop.runner = runner;
  await assert.rejects(desktop.start("local"), (error) => {
    assert.equal(error.message, switchedOffMessage);
    return true;
  });
});

test("Docker missing is reported as the external part that is not done, not a crash", async (t) => {
  const { app } = await fixture(t);
  saveLinuxDesktop(app.store, "local", { mode: "on" });
  const desktop = new LinuxDesktopSandbox(app.store);
  desktop.runner = async () => { const error = new Error("not found"); error.code = "ENOENT"; throw error; };
  const check = await desktop.available("local");
  assert.equal(check.ok, false);
  assert.match(check.reason, /Docker is not installed/);
  await assert.rejects(desktop.start("local"), /Docker is not installed/);
});

/** A sandbox wired to a fake docker/xdotool and a VNC probe that answers on the second try. The
 * notice window is a stand-in too, so no real popup appears on whoever's screen the tests run on. */
function sandboxFixture(app) {
  saveLinuxDesktop(app.store, "local", { mode: "on" });
  const { calls, runner } = fakeRunner();
  const banner = { shown: 0, hidden: 0, async show() { this.shown += 1; }, async hide() { this.hidden += 1; } };
  const desktop = new LinuxDesktopSandbox(app.store, { banner });
  desktop.runner = runner;
  desktop.port = async () => 15900;
  desktop.password = () => "test-pass";
  desktop.pauseMs = 1;
  let probes = 0;
  desktop.probe = async () => { probes += 1; return probes >= 2; };
  return { desktop, calls };
}

test("starting the shared desktop runs Xvfb/x11vnc in a container and hands back where to connect", async (t) => {
  const { app } = await fixture(t);
  const { desktop, calls } = sandboxFixture(app);
  const info = await desktop.start("local");
  assert.deepEqual(info, { host: "127.0.0.1", port: 15900, display, password: "test-pass" });
  const run = calls.find((call) => call.args[0] === "run");
  assert.ok(run, "docker run was called");
  assert.ok(run.args.join(" ").includes("Xvfb"), "Xvfb draws the desktop");
  assert.ok(run.args.join(" ").includes("x11vnc"), "x11vnc serves it over VNC");
  // Starting again while it is already up hands back the same session instead of another container.
  const again = await desktop.start("local");
  assert.deepEqual(again, info);
  assert.equal(calls.filter((call) => call.args[0] === "run").length, 1);
});

test("the assistant can operate a test application on the shared desktop while it holds control", async (t) => {
  const { app } = await fixture(t);
  const { desktop, calls } = sandboxFixture(app);
  await desktop.start("local");
  assert.equal(desktop.controlOf("local"), "agent");
  const answer = await desktop.act("local", { type: "open", app: "xterm" });
  assert.equal(answer.ran, "open");
  const exec = calls.find((call) => call.args[0] === "exec");
  assert.deepEqual(exec.args, ["exec", "-e", "DISPLAY=:1", "abcdef012345", "xdotool", "spawn", "xterm"]);
});

test("the owner taking over the shared desktop stops the assistant from acting on it until it is handed back", async (t) => {
  const { app } = await fixture(t);
  const { desktop, calls } = sandboxFixture(app);
  await desktop.start("local");
  await desktop.act("local", { type: "open", app: "xterm" }); // the assistant is mid-task on the desktop
  const before = calls.filter((call) => call.args[0] === "exec").length;

  desktop.takeOver("local"); // <-- the owner takes over (the notice's "Take over" button does the same)
  assert.equal(desktop.controlOf("local"), "user");

  await assert.rejects(desktop.act("local", { type: "type", text: "hello" }), (error) => {
    assert.equal(error.message, takenOverMessage);
    return true;
  });
  assert.equal(calls.filter((call) => call.args[0] === "exec").length, before, "nothing was sent to the desktop while the owner held it");

  desktop.release("local"); // the owner hands it back
  assert.equal(desktop.controlOf("local"), "agent");
  const after = await desktop.act("local", { type: "key", chord: "Return" });
  assert.equal(after.ran, "key");
});

test("stopping the shared desktop tears the container down and refuses further actions", async (t) => {
  const { app } = await fixture(t);
  const { desktop, calls } = sandboxFixture(app);
  await desktop.start("local");
  await desktop.stop("local");
  assert.deepEqual(calls.find((call) => call.args[0] === "stop").args, ["stop", "abcdef012345"]);
  await assert.rejects(desktop.act("local", { type: "key", chord: "Return" }), (error) => {
    assert.equal(error.message, notRunningMessage);
    return true;
  });
});

// -------------------------------------------------------------- wired into the product, not just a class

test("the shared desktop is reachable as tools, and takeOver reaches through them the same way", async (t) => {
  const { app } = await fixture(t);
  // `desktop.shared.*` is already registered on the running app (src/index.ts); wiring the fakes
  // onto that same instance, rather than making a second one, is what proves the tools reach it.
  const desktop = app.linuxDesktop;
  saveLinuxDesktop(app.store, "local", { mode: "on" });
  const { calls, runner } = fakeRunner();
  desktop.runner = runner;
  desktop.port = async () => 15901;
  desktop.password = () => "test-pass";
  desktop.pauseMs = 1;
  desktop.banner = { async show() {}, async hide() {} };
  let probes = 0;
  desktop.probe = async () => { probes += 1; return probes >= 2; };
  const permissions = ["desktop.control"];
  const ctx = () => runContext("run-1", "local", permissions);

  const started = await app.registry.execute("desktop.shared.start", {}, ctx());
  assert.equal(started.port, 15901);
  const opened = await app.registry.execute("desktop.shared.open", { app: "xterm" }, ctx());
  assert.equal(opened.ran, "open");

  desktop.takeOver("local");
  await assert.rejects(app.registry.execute("desktop.shared.type", { text: "hi" }, ctx()), /Branch has let go of it/);

  desktop.release("local");
  const typed = await app.registry.execute("desktop.shared.type", { text: "hi" }, ctx());
  assert.equal(typed.ran, "type");

  const stopped = await app.registry.execute("desktop.shared.stop", {}, ctx());
  assert.deepEqual(stopped, { stopped: true });
  assert.ok(calls.some((call) => call.args[0] === "stop"));
});
