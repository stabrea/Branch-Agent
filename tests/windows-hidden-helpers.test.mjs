import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchHandOver } from "../dist/desktop/hand-over.js";

/**
 * CBQ-001: a packaged Windows update must not put a console window on the owner's screen, and closing
 * one helper must not start another.
 *
 * The tests that came before this one assert that the code passes `windowsHide: true`. That is a test
 * of the source, not of the screen, and it passes while a console is really appearing: on Windows
 * `detached: true` and `windowsHide: true` cannot both apply, so the flag is present and ignored. So
 * these tests start the real launchers and then ask Windows which top-level windows exist.
 *
 * A test that only ever reports "no window appeared" is indistinguishable from a blind one, so the
 * first test here makes a console that is meant to be seen and fails if it cannot see it.
 */
const onWindows = process.platform === "win32";
const system32 = join(process.env.SystemRoot ?? "C:/Windows", "System32");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every process that owns a top-level window right now, by process id. */
/**
 * Only programs that host a console window count. This machine is shared — the owner, other agents'
 * test browsers, notifications — and counting every new window on the desktop failed this test once
 * when nothing of ours had appeared. A task started through the Task Scheduler is not a child of this
 * process, so windows cannot be matched to it by process tree; but the only window a leaked console can
 * appear in is one of these hosts, and the first test below proves such a window is still seen.
 */
const consoleHosts = new Set(["conhost", "openconsole", "windowsterminal", "cmd", "wscript", "cscript", "powershell", "pwsh"]);
function windowsOnScreen() {
  const ask = "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } |"
    + " Select-Object -Property Id,ProcessName | ConvertTo-Json -Compress";
  const printed = execFileSync(join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", ask],
    { encoding: "utf8", windowsHide: true, maxBuffer: 1 << 22 }).trim();
  const rows = printed ? JSON.parse(printed) : [];
  return new Map((Array.isArray(rows) ? rows : [rows])
    .filter((row) => consoleHosts.has(String(row.ProcessName).toLowerCase()))
    .map((row) => [row.Id, row.ProcessName]));
}

/** Runs `start`, then watches the screen for as long as the work can take, or until `enough` windows are seen. */
async function windowsOpenedBy(start, watchMs = 4000, enough = Infinity) {
  const before = windowsOnScreen();
  const result = await start();
  const opened = new Map();
  for (let waited = 0; waited < watchMs && opened.size < enough; waited += 400) {
    await sleep(400);
    for (const [id, name] of windowsOnScreen()) if (!before.has(id)) opened.set(id, name);
  }
  return { opened, result };
}

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "cbq-001-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "hand-over.cmd");
  const done = join(root, "handed-over.txt");
  writeFileSync(script, `@echo off\r\n${join(system32, "ping.exe")} -n 2 127.0.0.1 >NUL\r\n`
    + `echo %1>> "${done}"\r\n`, "utf8");
  return { root, script, done };
}

/** The scheduler is asked for first; this makes it refuse, which is the fallback the fix is about. */
const noScheduler = { exec: (_file, _args, _options, callback) => callback(new Error("schtasks missing")) };

/*
 * One look at the screen starts PowerShell, which takes seconds on a busy build machine; a console that
 * lived two seconds could open and close between two looks. This one lives up to 30 seconds and is
 * closed as soon as it has been seen.
 */
test("this test can see a console window that is meant to be seen", { skip: !onWindows }, async () => {
  let shown;
  const { opened } = await windowsOpenedBy(async () => {
    shown = spawn(join(system32, "cmd.exe"), ["/d", "/c", join(system32, "ping.exe"), "-n", "31", "127.0.0.1"],
      { detached: true, stdio: "ignore" });
    shown.unref();
  }, 30000, 1);
  spawnSync(join(system32, "taskkill.exe"), ["/pid", String(shown.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  assert.ok(opened.size >= 1,
    "a plain console opened no window this test could see, so every zero below would be meaningless");
  await sleep(2000);
});

test("the update hand-over opens no window through the scheduler, ten times over",
  { skip: !onWindows }, async (t) => {
    const { script, done } = workspace(t);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const { opened, result } = await windowsOpenedBy(() => launchHandOver(script, 900000 + attempt, {}));
      assert.equal(result, "task", `attempt ${attempt} did not take the scheduler route`);
      assert.deepEqual([...opened], [], `attempt ${attempt} put a window on the screen`);
    }
    assert.equal(readCount(done), 10, "every attempt really ran, so the zeros above are about work that happened");
  });

test("and none through the fallback either, which is where the flag was being ignored",
  { skip: !onWindows }, async (t) => {
    const { script, done } = workspace(t);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const { opened, result } = await windowsOpenedBy(() => launchHandOver(script, 910000 + attempt, noScheduler));
      assert.equal(result, "spawn", `attempt ${attempt} did not take the fallback route`);
      assert.deepEqual([...opened], [], `attempt ${attempt} put a window on the screen`);
    }
    assert.equal(readCount(done), 10, "every attempt really ran");
  });

test("one hand-over is one hand-over: no second launcher and no task left behind",
  { skip: !onWindows }, async (t) => {
    const { root, script, done } = workspace(t);
    await launchHandOver(script, 920001, {});
    await sleep(3000);
    assert.equal(readCount(done), 1, "the work ran exactly once, not twice");
    assert.equal(taskExists("BranchAgentUpdate-920001"), false, "the scheduled task deleted itself");
    assert.ok(existsSync(join(root, "hand-over.cmd.launch.vbs")), "the launcher it wrote is in the test's own folder");
  });

function readCount(file) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).length;
}

function taskExists(name) {
  try {
    execFileSync(join(system32, "schtasks.exe"), ["/Query", "/TN", name],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch { return false; }
}
