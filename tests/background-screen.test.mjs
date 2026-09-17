/**
 * r17-i (R17-078): using apps in the background. Only the exact programs and arguments are checked,
 * with a fake runner: no script is run here, so nothing asks macOS or Linux for a permission.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  backgroundCommand, linuxBackgroundScript, macBackgroundScript, pythonPath, readBackground, runBackground, xdotoolPath,
} from "../dist/reach/background-screen.js";

test("the Mac script never brings an app forward, types, or clicks at a position", () => {
  for (const forbidden of ["frontmost", "AXRaise", "keystroke", "key code", "click at", "activate()", "doShellScript", "do shell script"])
    assert.equal(macBackgroundScript.includes(forbidden), false, `the Mac script uses ${forbidden}`);
  for (const forbidden of ["grab_focus", "generate_mouse_event", "subprocess", "os.system", "eval("])
    assert.equal(linuxBackgroundScript.includes(forbidden), false, `the Linux script uses ${forbidden}`);
  assert.match(macBackgroundScript, /JSON\.parse\(argv\[1\]/, "the request is read as data");
});

test("a request becomes one program with an argument list, the request travelling as JSON", () => {
  const mac = backgroundCommand("darwin", { action: "press", handle: "501:1", name: "Send" });
  assert.equal(mac.executable, "/usr/bin/osascript");
  assert.deepEqual(mac.args.slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.equal(mac.args[3], macBackgroundScript);
  assert.deepEqual(mac.args.slice(4), ["press", JSON.stringify({ handle: "501:1", name: "Send" })]);

  const linux = backgroundCommand("linux", { action: "set-text", handle: "2:1", name: "Subject", text: "Hi'; rm -rf ~" });
  assert.equal(linux.executable, pythonPath);
  assert.deepEqual(linux.args, ["-c", linuxBackgroundScript, "set-text", JSON.stringify({ handle: "2:1", name: "Subject", text: "Hi'; rm -rf ~" })]);

  const typed = backgroundCommand("linux", { action: "type", xwindow: 4194312, text: "-- --window 1" });
  assert.deepEqual(typed, { executable: xdotoolPath, args: ["type", "--window", "4194312", "--delay", "12", "--", "-- --window 1"] });
  assert.equal(typed.args.includes("windowactivate"), false);
  assert.equal(typed.args.includes("mousemove"), false);
});

test("what cannot be done in the background says so in one sentence", () => {
  assert.throws(() => backgroundCommand("darwin", { action: "type", text: "x" }), /front window/);
  assert.throws(() => backgroundCommand("win32", { action: "windows" }), /Mac and on Linux/);
  assert.throws(() => backgroundCommand("darwin", { action: "press", handle: "1:1" }), /which control/);
  assert.throws(() => backgroundCommand("linux", { action: "controls" }), /which window/);
  assert.throws(() => backgroundCommand("linux", { action: "type", text: "x" }), /X window/);
});

test("answers and failures are read into plain words", () => {
  assert.deepEqual(readBackground("darwin", { status: "ok", exitCode: 0, stdout: '{"ok":true,"result":{"pressed":"Send"}}', stderr: "" }), { pressed: "Send" });
  assert.throws(() => readBackground("darwin", { status: "failed", exitCode: 1, stdout: "", stderr: "execution error: not allowed assistive access. (-25211)" }), /Accessibility/);
  assert.throws(() => readBackground("linux", { status: "ok", exitCode: 0, stdout: '{"ok":false,"error":"no-atspi"}', stderr: "" }), /gir1\.2-atspi/);
  assert.throws(() => readBackground("linux", { status: "ok", exitCode: 0, stdout: '{"ok":false,"error":"no-control"}', stderr: "" }), /no control with that name/);
  assert.throws(() => readBackground("linux", { status: "ok", exitCode: 0, stdout: "garbage", stderr: "" }), /could read/);
  assert.deepEqual(readBackground("linux", { status: "ok", exitCode: 0, stdout: "", stderr: "" }), { done: true });
});

test("runBackground hands the fake runner exactly one call", async () => {
  const calls = [];
  const exec = async (executable, args) => { calls.push([executable, args]); return { status: "ok", exitCode: 0, stdout: '{"ok":true,"result":{"windows":[]}}', stderr: "" }; };
  assert.deepEqual(await runBackground(exec, "darwin", { action: "windows" }, AbortSignal.timeout(1000)), { windows: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/osascript");
  await assert.rejects(runBackground(exec, "darwin", { action: "windows", extra: true }, AbortSignal.timeout(1000)), /Unrecognized|unrecognized/);
  assert.equal(calls.length, 1);
});
