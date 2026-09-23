import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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

function script(installRoot, extra = {}) {
  return uninstallScript({
    installRoot, executableName: "Branch Agent.exe", uninstallHive: "HKCU",
    userDataDir: `${installRoot}-data`, shortcuts: [], ...extra,
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

/** Runs one line the way the uninstaller's own console would, hidden, and watches the screen (or until `enough` windows are seen). */
async function runHidden(folders, line, enough = Infinity) {
  const file = join(folders.root, "last-step.cmd");
  writeFileSync(file, `@echo off\r\n${line}\r\nexit /b 0\r\n`, "utf8");
  const before = windowsOnScreen();
  const opened = new Set();
  spawn(join(system32, "cmd.exe"), ["/d", "/c", file], {
    stdio: "ignore", windowsHide: true,
    env: { ...process.env, TEMP: windowsPath(folders.temp), TMP: windowsPath(folders.temp) },
  });
  for (let waited = 0; waited < (enough === Infinity ? 7000 : 30000) && opened.size < enough; waited += 400) {
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

/*
 * One look at the screen starts PowerShell, which takes seconds on a busy build machine; a console that
 * lived two seconds could open and close between two looks. This one lives up to 30 seconds and is
 * closed as soon as it has been seen.
 */
test("this test can see a console window that is meant to be seen", { skip: !onWindows }, async (t) => {
  const folders = box(t);
  const opened = await runHidden(folders, `start "" ${windowsPath(system32)}${back}cmd.exe /d /c ${windowsPath(system32)}${back}ping.exe -n 31 127.0.0.1`, 1);
  for (const id of opened) spawnSync(join(system32, "taskkill.exe"), ["/pid", String(id), "/t", "/f"], { stdio: "ignore", windowsHide: true });
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

/**
 * The other lines that name a folder. `%` is read by the script's parser even inside quotes, so every
 * path the uninstaller writes goes through one helper — not only the last step, which was fixed first
 * (review of 4239a931). And the line telling the owner where their files stay printed the path without
 * quotes, so an `&` in it ran the rest of the path as a command.
 */
test("every path the uninstaller writes has its % doubled and sits inside quotes", () => {
  const text = uninstallScript({
    installRoot: "C:\\Users\\100%Done\\Programs\\Branch Agent", executableName: "Branch Agent.exe", uninstallHive: "HKCU",
    userDataDir: "C:\\Users\\100%Done\\Branch", shortcuts: ["C:\\Users\\100%Done\\Desktop\\Branch Agent.lnk"],
  });
  const naming = text.split("\r\n").filter((line) => line.includes("Done"));
  assert.equal(naming.length, 5, `the five lines that name a folder: ${naming.join(" | ")}`);
  for (const line of naming) {
    assert.ok(!/[^%]%Done/.test(line), `no lone % before "Done": ${line}`);
    // `set "NAME=value"` puts its opening quote before the name, which is how set keeps the value whole.
    assert.match(line, /"(BRANCH_REMOVE=)?C:\\Users\\100%%Done\\[^"]*"/, `the path is whole and inside quotes: ${line}`);
  }
});

function runLines(folders, lines, cwd) {
  const file = join(folders.root, "lines.cmd");
  writeFileSync(file, `@echo off\r\nsetlocal\r\n${lines.join("\r\n")}\r\nexit /b 0\r\n`, "utf8");
  return spawnSync(join(system32, "cmd.exe"), ["/d", "/c", file], { cwd, encoding: "utf8", windowsHide: true,
    env: { ...process.env, TEMP: windowsPath(folders.temp), TMP: windowsPath(folders.temp) } });
}
const lineOf = (text, start) => text.split("\r\n").find((line) => line.startsWith(start));

test("asked to delete their data, an owner under a folder named 100%Done has it deleted", { skip: !onWindows }, async (t) => {
  const folders = box(t);
  const account = join(folders.root, "100%Done");
  const data = join(account, "Branch"), neighbour = join(folders.root, "100");
  const previous = join(account, "Programs", "Branch Agent.previous"), shortcut = join(account, "Desktop", "Branch Agent.lnk");
  for (const path of [data, neighbour, previous, join(account, "Desktop")]) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "keep.txt"), "x"); }
  writeFileSync(shortcut, "x");
  const text = script(windowsPath(join(account, "Programs", "Branch Agent")), { userDataDir: windowsPath(data), shortcuts: [windowsPath(shortcut)] });
  runLines(folders, ['set "DELETE_DATA=1"', lineOf(text, "if defined DELETE_DATA rmdir"), lineOf(text, "rmdir /s /q"), lineOf(text, "del /q")], folders.root);
  assert.equal(existsSync(data), false, "the conversations and files are gone, as asked");
  assert.equal(existsSync(previous), false, "the kept previous version is gone");
  assert.equal(existsSync(shortcut), false, "the shortcut is gone");
  assert.equal(existsSync(neighbour), true, "a folder named by the part before the % is untouched");
});

test("the script sets its own parser settings instead of keeping its caller's", () => {
  const lines = script("C:\\Branch Agent").split("\r\n");
  assert.deepEqual(lines.slice(0, 2), ["@echo off", "setlocal EnableExtensions DisableDelayedExpansion"]);
});

/**
 * Runs the generated script as its caller would, minus the lines that reach outside this test: closing
 * Branch by name, and the scheduled task and registry entries. Every path it names is checked to lie in
 * this test's own folder before anything runs.
 */
async function runScriptUnder(folders, flags, text, args) {
  const outside = ["taskkill.exe", "schtasks.exe", "reg.exe"];
  const lines = text.split("\r\n").filter((line) => !outside.some((name) => line.includes(name)));
  const root = windowsPath(folders.root);
  for (const line of lines) for (const [, path] of line.matchAll(/"(?:BRANCH_REMOVE=)?([A-Za-z]:\\[^"]*)"/g))
    assert.ok(path.replaceAll("%%", "%").startsWith(`${root}${back}`), `a path outside the test's folder: ${line}`);
  const file = join(folders.root, "uninstall.cmd");
  writeFileSync(file, lines.join("\r\n"), "utf8");
  const env = { ...process.env, TEMP: windowsPath(folders.temp), TMP: windowsPath(folders.temp) };
  delete env.B;
  spawnSync(join(system32, "cmd.exe"), [...flags, "/c", file, ...args], { cwd: folders.root, stdio: "ignore", windowsHide: true, env });
  await sleep(6000); // the last step waits about three seconds before it removes the folder
}

/**
 * A caller with delayed expansion on (`cmd /v:on`, or the Command Processor `DelayedExpansion` registry
 * value) used to strip `!` from every path the script names, so `Tom!Jerry` became `TomJerry` and a folder
 * of that name would have been removed instead (review of 3ff7c9de). A caller with extensions off broke
 * `if defined`, so data the owner asked to delete was kept. Each account folder here has a decoy beside it
 * named the way it used to be misread, holding the same four things, and every decoy must survive.
 */
test("a caller's delayed expansion or disabled extensions change nothing the uninstaller removes",
  { skip: !onWindows }, async (t) => {
    for (const [flags, account, misread] of [[["/d", "/v:on"], "Tom!Jerry", "TomJerry"], [["/d", "/v:on"], "A!B!C", "AC"],
      [["/d", "/e:off"], "Tom!Jerry", "TomJerry"]]) {
      const folders = box(t);
      const make = (name) => {
        const base = join(folders.root, name);
        const paths = { installed: join(base, "Programs", "Branch Agent"), previous: join(base, "Programs", "Branch Agent.previous"),
          data: join(base, "Branch"), shortcut: join(base, "Desktop", "Branch Agent.lnk") };
        for (const path of [paths.installed, paths.previous, paths.data, join(base, "Desktop")]) {
          mkdirSync(path, { recursive: true }); writeFileSync(join(path, "keep.txt"), "x");
        }
        writeFileSync(paths.shortcut, "x");
        return paths;
      };
      const real = make(account), decoy = make(misread);
      const text = script(windowsPath(real.installed), { userDataDir: windowsPath(real.data), shortcuts: [windowsPath(real.shortcut)] });
      await runScriptUnder(folders, flags, text, ["--delete-data"]);
      const under = `${flags.join(" ")}, ${account}`;
      for (const [what, path] of Object.entries(real)) assert.equal(existsSync(path), false, `${under}: the ${what} is removed`);
      for (const [what, path] of Object.entries(decoy)) assert.equal(existsSync(path), true, `${under}: the ${misread} ${what} is untouched`);
    }
  });

test("the line saying where the files stay prints the path and runs nothing from it", { skip: !onWindows }, async (t) => {
  const folders = box(t);
  const data = join(folders.root, "x&md made-by-the-echo", "Branch");
  const text = script(windowsPath(join(folders.root, "Programs", "Branch Agent")), { userDataDir: windowsPath(data) });
  const ran = runLines(folders, [lineOf(text, "if not defined DELETE_DATA echo")], folders.root);
  assert.equal(existsSync(join(folders.root, "made-by-the-echo")), false, "no part of the path was run as a command");
  assert.ok(ran.stdout.includes(windowsPath(data)), `the whole path is shown: ${ran.stdout.trim()}`);
  assert.equal(ran.stderr.trim(), "", "and nothing complained");
});
