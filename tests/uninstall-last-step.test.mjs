import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { uninstallScript } from "../dist/install/installer.js";

/**
 * The uninstaller cannot delete the folder it runs from, so its last step is handed to a second
 * command started in %TEMP%. The installed folder is `%LOCALAPPDATA%\Programs\Branch Agent`, which has
 * a space in it, and the step quoted that path in a way that did not survive: the folder was left
 * behind and the removal was given a differently named path instead. The earlier test used an install
 * folder without a space, which is why it never saw this.
 *
 * Only the last step is run here, taken from the real generated script and pointed at folders this
 * test makes. The rest of the script is never run: it closes Branch by name, and the owner's copy may
 * be open on this computer.
 */
const onWindows = process.platform === "win32";
const system32 = join(process.env.SystemRoot ?? "C:/Windows", "System32");
const back = String.fromCharCode(92);
const windowsPath = (path) => path.split("/").join(back);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function script(installRoot) {
  return uninstallScript({
    installRoot, executableName: "Branch Agent.exe", uninstallHive: "HKCU",
    userDataDir: `${installRoot}-data`, shortcuts: [],
  });
}

/** The step handed to a second command, and the line before it that names the folder for it. */
function lastStep(text) {
  const lines = text.split("\r\n");
  const handed = lines.filter((line) => line.startsWith('start "'));
  assert.equal(handed.length, 1, "exactly one step is handed to a second command");
  const at = lines.indexOf(handed[0]);
  return `${lines[at - 1]}\r\n${handed[0]}`;
}

/** A throwaway folder holding a fake Programs and a fake %TEMP%, each with a folder that must survive. */
function box(t) {
  const root = mkdtempSync(join(tmpdir(), "uninstall-last-step-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = (...parts) => {
    const path = join(root, ...parts);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "keep.txt"), "x");
    return path;
  };
  return {
    root,
    temp: folder("Temp"),
    installed: folder("Programs", "Branch Agent"),
    otherProgram: folder("Programs", "Branch"),
    otherTemp: folder("Temp", "Agent"),
  };
}

/**
 * Only programs that host a console window count: this machine is shared, and a window some other
 * program opens meanwhile is not the uninstaller's. A leaked console can only appear in one of these,
 * and the control test below proves such a window is still seen.
 */
const consoleHosts = new Set(["conhost", "openconsole", "windowsterminal", "cmd", "wscript", "cscript", "powershell", "pwsh"]);
function windowsOnScreen() {
  const ask = "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -Property Id,ProcessName | ConvertTo-Json -Compress";
  const printed = execFileSync(join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", ask], { encoding: "utf8", windowsHide: true }).trim();
  const rows = printed ? JSON.parse(printed) : [];
  return new Set((Array.isArray(rows) ? rows : [rows])
    .filter((row) => consoleHosts.has(String(row.ProcessName).toLowerCase())).map((row) => row.Id));
}

/** Runs one line the way the uninstaller's own console would, hidden, and watches the screen. */
async function runHidden(folders, line) {
  const file = join(folders.root, "last-step.cmd");
  writeFileSync(file, `@echo off\r\n${line}\r\nexit /b 0\r\n`, "utf8");
  const before = windowsOnScreen();
  const opened = new Set();
  spawn(join(system32, "cmd.exe"), ["/d", "/c", file], {
    stdio: "ignore", windowsHide: true,
    env: { ...process.env, TEMP: windowsPath(folders.temp), TMP: windowsPath(folders.temp) },
  });
  for (let waited = 0; waited < 7000; waited += 400) {
    await sleep(400);
    for (const id of windowsOnScreen()) if (!before.has(id)) opened.add(id);
  }
  return opened;
}

/**
 * Nested inside `cmd /c "..."`, a path is outside quotes for one of the two parsers whichever way it is
 * quoted, so the folder's path must not be on that line at all: it is set in a variable on the line
 * before and expanded only when the step runs, when nothing is parsed again.
 */
test("the last step never puts the folder's path on the line that is parsed twice", () => {
  const root = "C:\\Users\\Tom&Jerry\\AppData\\Local\\Programs\\Branch Agent";
  const [named, handed] = lastStep(script(root)).split("\r\n");
  assert.equal(named, `set "BRANCH_REMOVE=${root}"`, "the folder is named once, whole, inside quotes");
  assert.ok(!handed.includes("Tom&Jerry"), `the path is not on the handed-over line: ${handed}`);
  assert.match(handed, /cmd\.exe \/d \/v:on \/c /, "the step expands the name only when it runs");
  assert.match(handed, /rmdir \/s \/q "!BRANCH_REMOVE!"/);
  assert.match(handed, /^start "" \/b /, "it stays in the uninstaller's own console");
  assert.equal(lastStep(script("C:\\A%PATH%B\\Branch Agent")).split("\r\n")[0], 'set "BRANCH_REMOVE=C:\\A%%PATH%%B\\Branch Agent"',
    "a % in the path is doubled, because the script's own parser reads it even inside quotes");
});

test("this test can see a console window that is meant to be seen", { skip: !onWindows }, async (t) => {
  const folders = box(t);
  const opened = await runHidden(folders, `start "" ${windowsPath(system32)}${back}cmd.exe /d /c ${windowsPath(system32)}${back}ping.exe -n 3 127.0.0.1`);
  assert.ok(opened.size >= 1, "a console that should be visible was not seen, so the zero below would mean nothing");
});

test("the last step removes the installed folder, and only that folder, with nothing on screen",
  { skip: !onWindows }, async (t) => {
    const folders = box(t);
    const opened = await runHidden(folders, lastStep(script(windowsPath(folders.installed))));
    assert.equal(existsSync(folders.installed), false, "the installed folder is gone");
    assert.equal(existsSync(folders.otherProgram), true, "another program's folder beside it is untouched");
    assert.equal(existsSync(folders.otherTemp), true, "a folder in %TEMP% is untouched");
    assert.deepEqual([...opened], [], "no window appeared");
  });

/**
 * A Windows account folder can hold `&`, `^`, `!`, `%` or `'`. Before this, `&` cut the path at that
 * character and removed the folder named by what came before it, and `^` left the install behind. Each
 * case puts the install under such a folder and a folder named by the part before the character beside
 * it, which must survive.
 */
test("a folder name with & ^ ! % or ' still removes only the installed folder", { skip: !onWindows }, async (t) => {
  for (const [parent, before] of [["Tom&Jerry", "Tom"], ["Tom^Jerry", "Tom"], ["Tom!Jerry", "Tom"],
    ["100%Done", "100"], ["A%PATH%B", "A"], ["Tom's", "Tom"], ["Tom(1)", "Tom"]]) {
    const folders = box(t);
    const installed = join(folders.root, parent, "Programs", "Branch Agent");
    const neighbour = join(folders.root, before);
    for (const path of [installed, neighbour]) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "keep.txt"), "x"); }
    await runHidden(folders, lastStep(script(windowsPath(installed))));
    assert.equal(existsSync(installed), false, `${parent}: the installed folder is gone`);
    assert.equal(existsSync(neighbour), true, `${parent}: the folder named "${before}" beside it is untouched`);
    assert.equal(existsSync(folders.otherTemp), true, `${parent}: a folder in %TEMP% is untouched`);
  }
});
