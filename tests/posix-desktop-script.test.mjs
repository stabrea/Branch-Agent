import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { DesktopScriptRunner } from "../dist/integrations/desktop-script.js";
import {
  macChord, macDesktopScript, macFailure, osascriptArgs, parseGeometry, pngSize, posixAvailability,
  screencaptureArgs, xdotoolArgs, xdotoolChord,
} from "../dist/integrations/desktop-script-posix.js";

/**
 * Wave mac1: the screen and keyboard on a Mac and on Linux, as commands. Nothing here runs the real
 * osascript, screencapture, open or xdotool: every program is a stand-in that records what it was
 * asked, or a small script in a temporary folder.
 */
const nasty = "-x $(open -a Calculator) `whoami`'); Application('Finder').delete(); //";
const signal = () => AbortSignal.timeout(10_000);

function recorder(answer) {
  const calls = [];
  return {
    calls,
    exec: async (executable, args) => {
      calls.push({ executable, args });
      return { status: "completed", exitCode: 0, stdout: "", stderr: "", ...(await answer(executable, args)) };
    },
  };
}
const ok = (result) => ({ stdout: JSON.stringify({ ok: true, result }) });

test("off Windows the screen stays out of reach until the Stop notice works there, and says so", async () => {
  for (const platform of ["darwin", "linux", "freebsd"]) {
    const fake = recorder(() => ({}));
    const runner = new DesktopScriptRunner(undefined, { platform, exec: fake.exec });
    await assert.rejects(runner.run("windows", {}, signal()), /not available on this computer yet/);
    assert.equal(fake.calls.length, 0, `${platform}: nothing was started`);
    await runner.close();
  }
});

test("a Mac runs one fixed script, and the request is only ever a separate JSON argument", async (t) => {
  const fake = recorder((executable, args) => ok(args[3] === "windows"
    ? { windows: [{ handle: "501:1", title: "Notes", program: "Notes", processId: 501, minimised: false, width: 800, height: 600 }] }
    : { how: "keys", into: "", value: "" }));
  const runner = new DesktopScriptRunner(undefined, { enabled: true, platform: "darwin", exec: fake.exec });
  t.after(() => runner.close());
  const listed = await runner.run("windows", {}, signal());
  assert.equal(listed.windows[0].title, "Notes");
  await runner.run("type", { handle: "501:1", text: nasty }, signal());
  const [first, second] = fake.calls;
  assert.equal(first.executable, "/usr/bin/osascript");
  assert.deepEqual(first.args.slice(0, 2), ["-l", "JavaScript"]);
  assert.deepEqual(first.args.slice(3), ["windows", "{}"]);
  assert.deepEqual(second.args.slice(3), ["type", JSON.stringify({ handle: "501:1", text: nasty })]);
  assert.equal(await readFile(second.args[2], "utf8"), macDesktopScript, "the script on disk is the fixed one");
  assert.ok(!macDesktopScript.includes("Calculator") && !macDesktopScript.includes("${"), "nothing is ever written into it");
  assert.match(macDesktopScript, /JSON\.parse\(argv\[1\]/);
  assert.deepEqual(osascriptArgs("/s.js", "read", { limit: 5 }), ["-l", "JavaScript", "/s.js", "read", '{"limit":5}']);
});

test("a Mac presses keys with Command for ctrl, and a Mac's refusals point at the right switch", async (t) => {
  assert.deepEqual(macChord("^s"), { key: "s", modifiers: ["command down"] });
  assert.deepEqual(macChord("^+%{ENTER}"), { keyCode: 36, modifiers: ["command down", "shift down", "option down"] });
  assert.deepEqual(macChord("{F5}"), { keyCode: 96, modifiers: [] });
  assert.throws(() => macChord("{INSERT}"), /no insert key/);
  assert.throws(() => macChord("^{BOGUS"), /not a key/);
  const fake = recorder(() => ok({ sent: "^s", title: "Notes" }));
  const runner = new DesktopScriptRunner(undefined, { enabled: true, platform: "darwin", exec: fake.exec });
  t.after(() => runner.close());
  await runner.run("key", { handle: "501:1", keys: "^s" }, signal());
  assert.deepEqual(JSON.parse(fake.calls[0].args[4]), { handle: "501:1", chord: "^s", key: "s", modifiers: ["command down"] });

  assert.match(macFailure("execution error: Error: Not authorized to send Apple events to System Events. (-1743)"), /Privacy & Security, Automation/);
  assert.match(macFailure("execution error: System Events got an error: osascript is not allowed assistive access. (-25211)"), /Privacy & Security, Accessibility/);
  assert.match(macFailure("could not create image from display"), /Screen & System Audio Recording/);
  assert.equal(macFailure("execution error: Error: That window is no longer open. (-2700)"), "That window is no longer open.");
  const refusing = recorder(() => ({ exitCode: 1, stderr: "execution error: Error: That window is no longer open. (-2700)" }));
  const gone = new DesktopScriptRunner(undefined, { enabled: true, platform: "darwin", exec: refusing.exec });
  t.after(() => gone.close());
  await assert.rejects(gone.run("act", { handle: "1:1", verb: "focus" }, signal()), /^Error: That window is no longer open\.$/);
});

test("a Mac takes pictures with screencapture and opens things with open, never an option", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-posix-shot-"));
  t.after(() => discardTemp(root));
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(1280, 16); png.writeUInt32BE(720, 20);
  assert.deepEqual(pngSize(png), { width: 1280, height: 720 });
  assert.deepEqual(pngSize(Buffer.from("nope")), { width: 0, height: 0 });
  const fake = recorder(async (executable, args) => {
    if (executable === "/usr/sbin/screencapture") { await writeFile(args.at(-1), png); return {}; }
    if (args[3] === "frame") return ok({ x: 10, y: 20, width: 300, height: 200, title: "Notes", minimised: false });
    return {};
  });
  const runner = new DesktopScriptRunner(undefined, { enabled: true, platform: "darwin", exec: fake.exec });
  t.after(() => runner.close());
  const out = join(root, "shot.png");
  assert.deepEqual(await runner.run("screenshot", { display: 2, outPath: out }, signal()), { width: 1280, height: 720, title: "Screen 2" });
  const window = await runner.run("screenshot", { handle: "501:1", outPath: out }, signal());
  assert.equal(window.method, "screen", "a patch of the screen is said to be one, so private windows are checked again");
  assert.equal(window.title, "Notes");
  const shots = fake.calls.filter((call) => call.executable === "/usr/sbin/screencapture").map((call) => call.args);
  assert.deepEqual(shots, [["-x", "-D", "2", out], ["-x", "-R", "10,20,300,200", out]]);
  assert.deepEqual(screencaptureArgs({ outPath: "/o.png", region: { x: 1, y: 2, width: 3, height: 4 } }), ["-x", "-R", "1,2,3,4", "/o.png"]);

  await runner.run("open", { app: "TextEdit" }, signal());
  await runner.run("open", { path: "/Users/me/workspace/notes.txt" }, signal());
  const opened = fake.calls.filter((call) => call.executable === "/usr/bin/open").map((call) => call.args);
  assert.deepEqual(opened, [["-a", "TextEdit"], ["/Users/me/workspace/notes.txt"]]);
  await assert.rejects(runner.run("open", { app: "-n" }, signal()), /not a program Branch can open/);
});

test("Linux says plainly when the session or xdotool rules screen control out", () => {
  const found = () => "/usr/bin/xdotool";
  assert.equal(posixAvailability("linux", { DISPLAY: ":0" }, found), null);
  assert.match(posixAvailability("linux", { DISPLAY: ":0" }, () => null), /needs xdotool, which is not installed/);
  assert.match(posixAvailability("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, found), /Wayland/);
  assert.match(posixAvailability("linux", {}, found), /no desktop session here/);
  assert.equal(posixAvailability("darwin", {}, () => null), null);
  assert.match(posixAvailability("sunos", {}, found), /not available on this computer/);
});

test("Linux builds xdotool arguments with typed words after --, and refuses what it cannot do", () => {
  assert.deepEqual(xdotoolArgs("type", { handle: "4194310", text: nasty }),
    ["windowactivate", "--sync", "4194310", "type", "--clearmodifiers", "--delay", "12", "--", nasty]);
  assert.deepEqual(xdotoolArgs("key", { handle: "7", keys: "^+{PGUP}" }),
    ["windowactivate", "--sync", "7", "key", "--clearmodifiers", "ctrl+shift+Prior"]);
  assert.deepEqual(xdotoolArgs("click", { handle: "7", x: 10.4, y: 20 }),
    ["windowactivate", "--sync", "7", "mousemove", "--window", "7", "10", "20", "click", "1"]);
  assert.deepEqual(xdotoolArgs("act", { handle: "7", verb: "minimise" }), ["windowminimize", "7"]);
  assert.deepEqual(xdotoolArgs("act", { handle: "7", verb: "close" }), ["windowclose", "7"]);
  assert.equal(xdotoolChord("% "), "alt+space");
  assert.equal(xdotoolChord("{F11}"), "F11");
  assert.throws(() => xdotoolArgs("key", { handle: "7; rm -rf /", keys: "a" }), /no longer open/);
  assert.throws(() => xdotoolArgs("click", { handle: "7", name: "OK" }), /by its name is not available on Linux yet/);
  assert.throws(() => xdotoolArgs("read", { handle: "7" }), /Reading what is in a window is not available on Linux yet/);
  assert.throws(() => xdotoolArgs("screenshot", { handle: "7" }), /Taking a picture of the screen is not available on Linux yet/);
  assert.deepEqual(parseGeometry("Window 7\n  Position: 0,0 (screen: 0)\n  Geometry: 1024x768\n"), { width: 1024, height: 768 });
});

test("a stand-in xdotool is really run, one question at a time, to list and use windows", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-posix-xdo-"));
  t.after(() => discardTemp(root));
  const log = join(root, "asked.log");
  const xdotool = join(root, "xdotool");
  await writeFile(xdotool, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  search) printf '11\\n12\\n' ;;
  getwindowname) if [ "$2" = 11 ]; then echo "Text Editor"; else echo ""; fi ;;
  getwindowpid) echo 0 ;;
  getwindowgeometry) printf 'Window %s\\n  Geometry: 640x480\\n' "$2" ;;
esac
`, { mode: 0o755 });
  const runner = new DesktopScriptRunner(undefined, {
    enabled: true, platform: "linux", env: { DISPLAY: ":99" }, locate: (name) => (name === "xdotool" ? xdotool : null),
  });
  t.after(() => runner.close());
  const listed = await runner.run("windows", {}, signal());
  assert.deepEqual(listed.windows, [{ handle: "11", title: "Text Editor", className: "", program: "", processId: 0, minimised: false, width: 640, height: 480 }]);
  await runner.run("type", { handle: "11", text: nasty }, signal());
  const acted = await runner.run("act", { handle: "11", verb: "close" }, signal());
  assert.deepEqual(acted, { verb: "close", title: "Text Editor", stillOpen: true });
  const asked = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(asked[0], "search --onlyvisible --name .");
  assert.ok(asked.includes(`windowactivate --sync 11 type --clearmodifiers --delay 12 -- ${nasty}`), "the words arrived as one argument, untouched");
  assert.ok(asked.includes("windowclose 11"));
  await assert.rejects(runner.run("clipboard", { mode: "read" }, signal()), /The clipboard is not available on Linux yet/);
});
