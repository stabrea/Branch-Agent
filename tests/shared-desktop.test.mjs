// FQ-execution.desktop: the shared Linux desktop (VNC/Xvfb) and the owner taking it over. Every
// "docker"/"xdotool" call here is a fake that only records what it was asked, so this file needs
// no Docker and touches no real display; the pure argv builders prove the real commands are right.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, Budget, setLockdown, lockdownToolRefusalText } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import {
  LinuxDesktopSandbox, dockerRunArgv, dockerExecArgv, dockerStopArgv, xvfbArgv, x11vncArgv, xdotoolArgv,
  readLinuxDesktop, saveLinuxDesktop, switchedOffMessage, takenOverMessage, notRunningMessage, vncPort, display,
} from "../dist/integrations/linux-desktop.js";
import { TakeOverBanner, takeOverNotice } from "../dist/integrations/linux-desktop-banner.js";
import { bannerPage } from "../dist/desktop/banner-window.js";

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
  assert.ok(argv.includes("--network"), "network isolation is enforced");
  assert.ok(argv.includes("none"), "--network none for isolation");
  assert.ok(argv.includes("--pids-limit"), "process limit is set");
  assert.ok(argv.includes("256"), "pids limit is 256");
  assert.ok(argv.includes("--label"), "labels are set");
  assert.ok(argv.includes("branch.shared-desktop=1"), "label marks shared desktop containers");
  assert.ok(argv.includes("--cap-drop"));
  assert.deepEqual(argv.slice(argv.indexOf("-p"), argv.indexOf("-p") + 2), ["-p", "127.0.0.1:15900:5900"], "the VNC port stays on this computer only");
  assert.equal(argv.at(-4), "branch-linux-desktop:latest");
  assert.equal(argv.at(-3), "sh");
});

test("xdotool argument lists for opening a program, typing and a key press", () => {
  assert.deepEqual(xdotoolArgv({ type: "open", app: "xterm" }), ["exec", "--", "xterm"]);
  assert.deepEqual(xdotoolArgv({ type: "type", text: "hello" }), ["type", "--clearmodifiers", "--", "hello"]);
  assert.deepEqual(xdotoolArgv({ type: "key", chord: "ctrl+s" }), ["key", "--clearmodifiers", "ctrl+s"]);
  const exec = dockerExecArgv("abc123", { type: "open", app: "xterm" });
  assert.deepEqual(exec, ["exec", "-e", "DISPLAY=:1", "abc123", "xdotool", "exec", "--", "xterm"]);
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
  assert.deepEqual(exec.args, ["exec", "-e", "DISPLAY=:1", "abcdef012345", "xdotool", "exec", "--", "xterm"]);
});

test("the owner taking over the shared desktop stops the assistant from acting on it until it is handed back", async (t) => {
  const { app } = await fixture(t);
  const { desktop, calls } = sandboxFixture(app);
  await desktop.start("local");
  await desktop.act("local", { type: "open", app: "xterm" }); // the assistant is mid-task on the desktop
  const before = calls.filter((call) => call.args[0] === "exec").length;

  await desktop.takeOver("local"); // <-- the owner takes over (the notice's "Take over" button does the same)
  assert.equal(desktop.controlOf("local"), "user");
  // takeOver kills any in-flight xdotool process, which counts as one additional exec call
  const afterTakeOver = calls.filter((call) => call.args[0] === "exec").length;
  assert.equal(afterTakeOver, before + 1, "takeOver sends a pkill to abort in-flight actions");

  await assert.rejects(desktop.act("local", { type: "type", text: "hello" }), (error) => {
    assert.equal(error.message, takenOverMessage);
    return true;
  });
  assert.equal(calls.filter((call) => call.args[0] === "exec").length, afterTakeOver, "no new commands sent after takeOver while owner holds it");

  await desktop.handBack("local"); // the owner hands it back
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

  await desktop.handBack("local");
  const typed = await app.registry.execute("desktop.shared.type", { text: "hi" }, ctx());
  assert.equal(typed.ran, "type");

  const stopped = await app.registry.execute("desktop.shared.stop", {}, ctx());
  assert.deepEqual(stopped, { stopped: true });
  assert.ok(calls.some((call) => call.args[0] === "stop"));
});

// -------------------------------------------------------------- review fixes: the switch, the owner's hold, races

/** A promise the test settles itself, so an interleaving is written down rather than timed. */
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** Like `sandboxFixture`, but `docker run` and `docker stop` can be held until the test lets them go,
 * and the notice stand-in says whether it is showing. */
function heldFixture(app, desktop = new LinuxDesktopSandbox(app.store)) {
  saveLinuxDesktop(app.store, "local", { mode: "on" });
  const calls = [];
  const hold = { run: null, stop: null };
  let started = 0;
  desktop.runner = async (file, args) => {
    calls.push({ file, args });
    if (args[0] === "image") return "ok";
    if (args[0] === "run") { started += 1; if (hold.run) await hold.run.promise; return `abcdef01234${started}\n`; }
    if (args[0] === "stop" && hold.stop) await hold.stop.promise;
    return "";
  };
  const banner = { visible: false, shown: 0, async show() { this.shown += 1; this.visible = true; }, async hide() { this.visible = false; } };
  desktop.banner = banner;
  desktop.port = async () => 15902;
  desktop.password = () => "test-pass";
  desktop.pauseMs = 1;
  desktop.probe = async () => true;
  const ran = (verb) => calls.filter((call) => call.args[0] === verb);
  return { desktop, calls, hold, banner, ran };
}
const settle = async (until) => { for (let i = 0; i < 200 && !until(); i++) await new Promise((done) => setTimeout(done, 5)); };

test("switching the feature off stops a desktop that is running, and start no longer hands its password back", async (t) => {
  const { app } = await fixture(t);
  const { desktop, ran } = heldFixture(app);
  await desktop.start("local");
  saveLinuxDesktop(app.store, "local", { mode: "off" }); // saved anywhere, not only through the Settings route
  await assert.rejects(desktop.act("local", { type: "key", chord: "Return" }), (error) => {
    assert.equal(error.message, switchedOffMessage);
    return true;
  });
  assert.deepEqual(ran("stop").map((call) => call.args), [["stop", "abcdef012341"]], "the container was taken down");
  assert.equal(desktop.controlOf("local"), "none");
  await assert.rejects(desktop.start("local"), (error) => { assert.equal(error.message, switchedOffMessage); return true; });
});

test("start checks the switch too: a desktop still running when the switch went off is stopped, not handed back", async (t) => {
  const { app } = await fixture(t);
  const { desktop, ran } = heldFixture(app);
  await desktop.start("local");
  saveLinuxDesktop(app.store, "local", { mode: "off" });
  await assert.rejects(desktop.start("local"), (error) => { assert.equal(error.message, switchedOffMessage); return true; });
  assert.equal(ran("stop").length, 1);
  assert.equal(desktop.controlOf("local"), "none");
});

test("saving only the mode keeps the image the owner chose", async (t) => {
  const { app } = await fixture(t);
  saveLinuxDesktop(app.store, "local", { mode: "on", image: "my-desktop:1" });
  saveLinuxDesktop(app.store, "local", { mode: "when-needed" });
  assert.equal(readLinuxDesktop(app.store, "local").image, "my-desktop:1");
});

test("turning Lockdown on stops a running shared desktop at once, and it reads as off while Lockdown is on", async (t) => {
  const { app } = await fixture(t);
  const { desktop, ran } = heldFixture(app, app.linuxDesktop);
  await desktop.start("local");
  setLockdown(app.store, "local", { on: true });
  await settle(() => ran("stop").length > 0);
  assert.equal(ran("stop").length, 1, "Lockdown took the container down without waiting for the next action");
  assert.equal(desktop.controlOf("local"), "none");
  assert.equal(readLinuxDesktop(app.store, "local").mode, "off");
  await assert.rejects(desktop.start("local"), (error) => { assert.equal(error.message, lockdownToolRefusalText); return true; });
  setLockdown(app.store, "local", { on: false });
  assert.equal(readLinuxDesktop(app.store, "local").mode, "on", "the owner's own switch comes back after Lockdown");
});

test("while the owner holds the desktop the assistant can neither stop it, start it again, nor act, until the owner hands it back", async (t) => {
  const { app } = await fixture(t);
  const { desktop, ran } = heldFixture(app, app.linuxDesktop);
  const ctx = () => runContext("run-2", "local", ["desktop.control"]);
  await desktop.start("local");
  await desktop.takeOver("local");
  for (const [name, input] of [["desktop.shared.stop", {}], ["desktop.shared.start", {}], ["desktop.shared.type", { text: "hi" }]])
    await assert.rejects(app.registry.execute(name, input, ctx()), (error) => { assert.equal(error.message, takenOverMessage); return true; }, name);
  await assert.rejects(desktop.stop("local"), (error) => { assert.equal(error.message, takenOverMessage); return true; });
  await assert.rejects(desktop.start("local"), (error) => { assert.equal(error.message, takenOverMessage); return true; });
  assert.equal(ran("stop").length, 0, "the owner's desktop was not taken down");
  assert.equal(ran("run").length, 1, "no second desktop was started with control back at the assistant");
  assert.equal(desktop.controlOf("local"), "user");
  await desktop.handBack("local");
  assert.equal((await app.registry.execute("desktop.shared.type", { text: "hi" }, ctx())).ran, "type");
});

test("handing back is the owner's alone: no tool does it, and the refusal names only places that exist", async (t) => {
  const { app } = await fixture(t);
  const tools = app.registry.names().filter((name) => name.startsWith("desktop.shared."));
  assert.deepEqual(tools.sort(), ["desktop.shared.key", "desktop.shared.open", "desktop.shared.start", "desktop.shared.stop", "desktop.shared.type"]);
  assert.doesNotMatch(takenOverMessage, /desktop\.shared\.release/);
  assert.match(takenOverMessage, /Settings/);
  const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(page, /id="linux-desktop-hand-back"/, "the Hand back button the refusal points to is on the Settings card");
  assert.match(page, /id="linux-desktop-mode"/, "the switch the switched-off refusal points to is on the Settings card");
});

test("the Settings routes: switching off stops the desktop at once, hand back is the owner's, and no key reaches either", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const call = (method, path, key, body) => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${key}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const { desktop, ran } = heldFixture(app, app.linuxDesktop);
  await desktop.start("local");
  const card = await fetch(server.url + "/linux-desktop.js");
  assert.equal(card.status, 200, "the Settings card's own script is served, so its buttons work");
  await card.text();

  const shown = await call("GET", "/api/linux-desktop", server.token);
  assert.equal(shown.status, 200);
  assert.deepEqual({ mode: shown.body.mode, running: shown.body.running, control: shown.body.control }, { mode: "on", running: true, control: "agent" });
  assert.equal(JSON.stringify(shown.body).includes("test-pass"), false, "reading the card never hands out the VNC password");

  const run = app.sessionTokens.create(app.runtime.owner, { name: "run", scope: "run", minutes: 5 }).token;
  for (const path of ["/api/linux-desktop", "/api/linux-desktop/take-over", "/api/linux-desktop/hand-back"])
    assert.equal((await call("POST", path, run, { mode: "off" })).status, 401, `a short-lived key is refused ${path}`);

  assert.equal((await call("POST", "/api/linux-desktop/take-over", server.token)).body.control, "user");
  await assert.rejects(desktop.act("local", { type: "key", chord: "Return" }), /let go of it/);
  assert.equal((await call("POST", "/api/linux-desktop/hand-back", server.token)).body.control, "agent");
  assert.equal((await desktop.act("local", { type: "key", chord: "Return" })).ran, "key");

  const off = await call("POST", "/api/linux-desktop", server.token, { mode: "off" });
  assert.equal(off.status, 200);
  assert.equal(off.body.running, false);
  assert.equal(ran("stop").length, 1, "the container was taken down as the switch went off, not at the next action");
});

test("two starts at once share one container", async (t) => {
  const { app } = await fixture(t);
  const { desktop, hold, ran } = heldFixture(app);
  hold.run = deferred();
  const first = desktop.start("local"), second = desktop.start("local");
  await settle(() => ran("run").length > 0);
  hold.run.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(ran("run").length, 1, "only one docker run");
});

test("stopping while a start is still under way takes that container down too", async (t) => {
  const { app } = await fixture(t);
  const { desktop, hold, ran } = heldFixture(app);
  hold.run = deferred();
  const starting = desktop.start("local");
  starting.catch(() => undefined);
  await settle(() => ran("run").length > 0);
  const stopping = desktop.stop("local");
  hold.run.resolve();
  await assert.rejects(starting);
  await stopping;
  assert.deepEqual(ran("stop").map((call) => call.args), [["stop", "abcdef012341"]], "docker stop was issued for the container the start made");
  assert.equal(desktop.controlOf("local"), "none");
});

test("the app closing while a start is under way takes that container down too", async (t) => {
  const { app } = await fixture(t);
  const { desktop, hold, ran } = heldFixture(app);
  hold.run = deferred();
  const starting = desktop.start("local");
  starting.catch(() => undefined);
  await settle(() => ran("run").length > 0);
  const closing = desktop.close();
  hold.run.resolve();
  await closing;
  await assert.rejects(starting);
  assert.deepEqual(ran("stop").map((call) => call.args), [["stop", "abcdef012341"]]);
});

test("a start asked for in the same moment the app closes leaves no container behind", async (t) => {
  const { app } = await fixture(t);
  const { desktop, ran } = heldFixture(app);
  const starting = desktop.start("local");
  starting.catch(() => undefined);
  await desktop.close();
  await assert.rejects(starting);
  assert.equal(desktop.controlOf("local"), "none");
  assert.ok(ran("run").length === 0 || ran("stop").length === ran("run").length, "every container started was stopped again");
});

test("a start made while a stop is still under way ends with the Take over notice showing", async (t) => {
  const { app } = await fixture(t);
  const { desktop, hold, banner, ran } = heldFixture(app);
  await desktop.start("local");
  hold.stop = deferred();
  const stopping = desktop.stop("local");
  await settle(() => ran("stop").length > 0);
  const again = desktop.start("local");
  // Give the new start every chance to put its notice up before the old stop finishes; the old
  // stop taking the notice down after that is exactly the bug.
  await settle(() => banner.shown >= 2);
  hold.stop.resolve();
  await stopping;
  await again;
  assert.equal(desktop.controlOf("local"), "agent");
  assert.equal(banner.visible, true, "the new desktop has its notice");
});

test("the notice on a Mac or Linux is the app's own window, with Take over words, and the app hands its window maker in", async (t) => {
  const made = [];
  const factory = async (closed, notice) => {
    const window = { showing: true, close() { this.showing = false; } };
    made.push({ closed, notice, window });
    return window;
  };
  const banner = new TakeOverBanner(undefined, { platform: "linux", window: factory });
  let takenOver = 0;
  await banner.show(() => { takenOver += 1; });
  assert.deepEqual(made[0].notice, takeOverNotice);
  made[0].closed(); // the owner pressed Take over
  assert.equal(takenOver, 1);
  const page = decodeURIComponent(bannerPage(takeOverNotice));
  assert.match(page, />Take over</);
  assert.doesNotMatch(page, />Stop</);

  const root = await mkdtemp(join(tmpdir(), "branch-shared-desktop-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), bannerWindow: factory,
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  assert.equal(app.linuxDesktop.banner.options.window, factory, "createBranch hands its notice window maker to the shared desktop");
});
