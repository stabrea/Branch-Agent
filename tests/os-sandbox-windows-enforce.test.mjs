import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { discardTemp } from "./temp-dir.mjs";
import { denyWindowsPaths, windowsAccount } from "../dist/sandbox-windows-wall.js";
import { openWall } from "../dist/sandbox-backends.js";

const run = promisify(execFile);

/**
 * FQ-security.os's remaining Windows gap: the "unreadable" places an owner lists (WallSettings,
 * sandbox.ts) were silently ignored on Windows — openWall handed the program back untouched. This
 * makes them real there with a temporary `icacls` deny rule (sandbox-windows-wall.ts). WF1-WF3 work
 * out the rule and the wiring on paper, against a fake `icacls`, and run on every platform. WF4 is
 * the real enforcement test: it runs `icacls` for true and spawns a separate process to prove a
 * denied file is actually unreadable, not just that the right arguments were built — Windows only,
 * skipped everywhere else the way the rest of this wave's platform-only tests are.
 */

const fakeRun = (answers = {}) => {
  const calls = [];
  const runner = async (executable, args) => {
    calls.push([executable, ...args]);
    const path = args[0];
    return { code: answers[path] ?? 0 };
  };
  runner.calls = calls;
  return runner;
};

test("WF1 denying writes one icacls call per path, denies the given account, and skips a path that failed", async () => {
  const runner = fakeRun({ "/bad": 1 });
  const wall = await denyWindowsPaths(["/keep/a", "/bad", "/keep/b"], { account: "HOST\\owner", run: runner });
  assert.deepEqual(wall.denied, ["/keep/a", "/keep/b"], "the path icacls refused is left out");
  assert.deepEqual(runner.calls, [
    ["icacls", "/keep/a", "/deny", "HOST\\owner:(OI)(CI)F"],
    ["icacls", "/bad", "/deny", "HOST\\owner:(OI)(CI)F"],
    ["icacls", "/keep/b", "/deny", "HOST\\owner:(OI)(CI)F"],
  ]);
});

test("WF2 closing removes the rule only from the paths it actually denied, and only once", async () => {
  const runner = fakeRun({ "/bad": 1 });
  const wall = await denyWindowsPaths(["/keep/a", "/bad"], { account: "HOST\\owner", run: runner });
  runner.calls.length = 0;
  await wall.close();
  assert.deepEqual(runner.calls, [["icacls", "/keep/a", "/remove:d", "HOST\\owner"]], "the path that was never denied is never touched again");
  await wall.close();
  assert.equal(runner.calls.length, 1, "closing twice removes the rule only once");
});

test("WF3 the account defaults to this computer's own, and openWall wires the list in only when it is not empty", async () => {
  assert.match(windowsAccount({ USERNAME: "o", USERDOMAIN: "HOST" }), /^HOST\\o$/);
  assert.match(windowsAccount({ USERNAME: "o" }), /^o$/, "a computer with no domain still has an account");
  assert.throws(() => windowsAccount({}), /needs an account name/);

  const start = { executable: "/bin/true", args: [], cwd: "/w", env: {} };
  const emptyWall = { network: "open", keySites: {}, unreadable: [], answer: () => undefined, granted: () => [], spend() {} };
  const untouched = await openWall(emptyWall, start, { workspace: "/w" }, { platform: "win32" });
  assert.equal(untouched.start, start, "nothing to deny leaves Windows exactly as before");

  const runner = fakeRun();
  const listed = { ...emptyWall, unreadable: ["/w/secret.txt"] };
  const opened = await openWall(listed, start, { workspace: "/w" },
    { platform: "win32", denyWindowsPaths: (paths) => denyWindowsPaths(paths, { account: "HOST\\owner", run: runner }) });
  assert.equal(opened.start, start, "the program itself is not rewritten, only the place around it");
  assert.deepEqual(runner.calls, [["icacls", "/w/secret.txt", "/deny", "HOST\\owner:(OI)(CI)F"]]);
  runner.calls.length = 0;
  await opened.finish({ exitCode: 0, stdout: "", stderr: "" });
  assert.deepEqual(runner.calls, [["icacls", "/w/secret.txt", "/remove:d", "HOST\\owner"]], "finish() lifts the rule even on a plain success");
});

const windowsOnly = { skip: process.platform !== "win32" && "the Windows file restriction is Windows only" };

test("WF4 real enforcement: a denied file is actually unreadable by a separate process, and readable again once closed", windowsOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-wall-win-"));
  t.after(() => discardTemp(root));
  const secret = join(root, "secret.txt");
  await writeFile(secret, "real-value-1234", "utf8");

  const tryRead = async () => {
    try {
      await run(process.execPath, ["-e", `require("node:fs").readFileSync(${JSON.stringify(secret)})`]);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(await tryRead(), true, "readable before the wall denies it");

  const wall = await denyWindowsPaths([secret]);
  assert.deepEqual(wall.denied, [secret], "icacls really reached the file");
  try {
    assert.equal(await tryRead(), false, "a separate process, not just this one, is refused");
  } finally {
    await wall.close();
  }
  assert.equal(await tryRead(), true, "closing the wall gives the file back");
  assert.equal((await readFile(secret, "utf8")), "real-value-1234");
});

test("WF5 real enforcement through openWall: the sandboxed tool's own path", windowsOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-wall-win-"));
  t.after(() => discardTemp(root));
  const secret = join(root, "hidden", "key.txt");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "hidden")));
  await writeFile(secret, "s3cret", "utf8");
  const wall = { network: "open", keySites: {}, unreadable: [secret], answer: () => undefined, granted: () => [], spend() {} };
  const opened = await openWall(wall, { executable: process.execPath, args: ["-e", "1"], cwd: root, env: {} },
    { workspace: root }, { platform: "win32" });
  try {
    await assert.rejects(run(process.execPath, ["-e", `require("node:fs").readFileSync(${JSON.stringify(secret)})`]));
  } finally {
    await opened.finish({ exitCode: 0, stdout: "", stderr: "" });
  }
  await assert.doesNotReject(run(process.execPath, ["-e", `require("node:fs").readFileSync(${JSON.stringify(secret)})`]));
});
