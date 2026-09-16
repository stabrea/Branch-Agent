import test from "node:test";
import assert from "node:assert/strict";
import { launchHandOver } from "../dist/desktop/hand-over.js";

test("the hand-over script is started through the Task Scheduler so it outlives the app, with spawn as the fallback", async () => {
  const calls = [];
  const exec = (file, args, options, callback) => { calls.push({ file, args, options }); callback(null); };
  let spawned = null;
  const spawn = (command, args, options) => { spawned = { command, args, options }; return { unref() { spawned.unrefd = true; } }; };
  const how = await launchHandOver("C:\\tmp\\apply-update.cmd", 4242, { exec, spawn, systemRoot: "C:\\Windows" });
  assert.equal(how, "task");
  assert.equal(spawned, null, "no direct child was started");
  assert.deepEqual(calls.map((c) => c.args[0]), ["/Create", "/Run", "/Delete"]);
  assert.ok(calls.every((c) => c.file.endsWith("System32\\schtasks.exe") && c.options.windowsHide === true));
  const create = calls[0].args;
  assert.equal(create[create.indexOf("/TN") + 1], "BranchAgentUpdate-4242");
  assert.equal(create[create.indexOf("/TR") + 1], 'cmd.exe /d /c ""C:\\tmp\\apply-update.cmd" 4242"');
  assert.deepEqual(calls[1].args, ["/Run", "/TN", "BranchAgentUpdate-4242"]);
  assert.deepEqual(calls[2].args, ["/Delete", "/F", "/TN", "BranchAgentUpdate-4242"]);
  // When the scheduler is unavailable the script is still started, directly.
  const failing = (_file, _args, _options, callback) => callback(new Error("schtasks missing"));
  const fallback = await launchHandOver("C:\\tmp\\apply-update.cmd", 7, { exec: failing, spawn, systemRoot: "C:\\Windows" });
  assert.equal(fallback, "spawn");
  assert.deepEqual(spawned.args, ["/d", "/c", "C:\\tmp\\apply-update.cmd", "7"]);
  assert.equal(spawned.options.detached, true);
  assert.equal(spawned.unrefd, true);
});
