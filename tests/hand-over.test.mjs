import test from "node:test";
import assert from "node:assert/strict";
import { hiddenLauncher, launchHandOver } from "../dist/desktop/hand-over.js";

test("the hand-over script is started hidden through the Task Scheduler so it outlives the app, with spawn as the fallback", async () => {
  const calls = [];
  const exec = (file, args, options, callback) => { calls.push({ file, args, options }); callback(null); };
  let spawned = null;
  const spawn = (command, args, options) => { spawned = { command, args, options }; return { unref() { spawned.unrefd = true; } }; };
  const written = [];
  const write = (file, content) => written.push({ file, content });
  const how = await launchHandOver("C:\\tmp\\apply-update.cmd", 4242, { exec, spawn, write, systemRoot: "C:\\Windows", platform: "win32" });
  assert.equal(how, "task");
  assert.equal(spawned, null, "no direct child was started");
  assert.deepEqual(calls.map((c) => c.args[0]), ["/Create", "/Run", "/Delete"]);
  assert.ok(calls.every((c) => c.file.endsWith("System32\\schtasks.exe") && c.options.windowsHide === true));
  const create = calls[0].args;
  assert.equal(create[create.indexOf("/TN") + 1], "BranchAgentUpdate-4242");
  // The task runs a Windows Script Host launcher, not a console, so nothing flashes on screen.
  assert.equal(create[create.indexOf("/TR") + 1], '"C:\\Windows\\System32\\wscript.exe" //B //Nologo "C:\\tmp\\apply-update.cmd.launch.vbs"');
  assert.deepEqual(written, [{ file: "C:\\tmp\\apply-update.cmd.launch.vbs", content: hiddenLauncher("C:\\tmp\\apply-update.cmd", 4242) }]);
  // The launcher hides the window (style 0), does not wait, and quotes the script path for cmd.
  const expected = 'CreateObject("WScript.Shell").Run "cmd.exe /d /c ""' + '""C:\\tmp\\apply-update.cmd""' + ' 4242""", 0, False\r\n';
  assert.equal(hiddenLauncher("C:\\tmp\\apply-update.cmd", 4242), expected);
  assert.deepEqual(calls[1].args, ["/Run", "/TN", "BranchAgentUpdate-4242"]);
  assert.deepEqual(calls[2].args, ["/Delete", "/F", "/TN", "BranchAgentUpdate-4242"]);
  // When the scheduler is unavailable the script is still started — through the same hidden launcher,
  // never through cmd.exe itself. A detached child is given no console to hide, so it opens its own:
  // `windowsHide` is accepted and ignored there, and a console really appeared on screen. Windows
  // Script Host has no window to open. `tests/windows-hidden-helpers.test.mjs` measures that claim
  // against the real screen rather than against these arguments.
  const failing = (_file, _args, _options, callback) => callback(new Error("schtasks missing"));
  const fallback = await launchHandOver("C:\\tmp\\apply-update.cmd", 7, { exec: failing, spawn, write, systemRoot: "C:\\Windows", platform: "win32" });
  assert.equal(fallback, "spawn");
  assert.equal(spawned.command, "C:\\Windows\\System32\\wscript.exe", "the fallback starts no console program");
  assert.deepEqual(spawned.args, ["//B", "//Nologo", "C:\\tmp\\apply-update.cmd.launch.vbs"]);
  assert.equal(spawned.options.detached, true);
  assert.equal(spawned.unrefd, true);
  // The launcher it runs is written even when the scheduler is never reached.
  assert.deepEqual(written.at(-1), { file: "C:\\tmp\\apply-update.cmd.launch.vbs", content: hiddenLauncher("C:\\tmp\\apply-update.cmd", 7) });
});
