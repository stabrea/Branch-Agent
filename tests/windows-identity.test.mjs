import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { refreshWindowsIdentity, shortcutChanges, shortcutPaths, windowsAppId, refreshShortcutsFlag } from "../dist/install/windows-identity.js";
import { performInstall, shippedIconPath, uninstallKey } from "../dist/install/installer.js";

// mac7/win-icon: the owner's Windows taskbar showed Electron's atom for Branch because the 0.18.0
// shortcuts named the program file (the stock Electron one) as their icon. None of this opens a window.

const root = "C:\\Users\\p\\AppData\\Local\\Programs\\Branch Agent";
const exe = join(root, "Branch Agent.exe");
const ico = join(root, shippedIconPath);
const env = { APPDATA: "C:\\Users\\p\\AppData\\Roaming", USERPROFILE: "C:\\Users\\p" };
const [startMenu, pinned, desktop] = shortcutPaths(env);

test("the app ID is fixed: shortcuts and the running app must carry the same one, release after release", () => {
  assert.equal(windowsAppId, "KeepOak.BranchAgent");
  assert.equal(refreshShortcutsFlag, "--refresh-shortcuts");
  assert.equal(startMenu, join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Branch Agent.lnk"));
  assert.equal(pinned, join(env.APPDATA, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar", "Branch Agent.lnk"),
    "a Branch pinned to the taskbar keeps its own shortcut, and its icon, there");
  assert.equal(desktop, join(env.USERPROFILE, "Desktop", "Branch Agent.lnk"));
});

test("a 0.18.0 shortcut (icon = the Electron program) is pointed at the KeepOak .ico and the app ID", () => {
  assert.deepEqual(shortcutChanges({ target: exe, icon: exe, iconIndex: 0 }, exe, ico),
    { target: exe, appUserModelId: windowsAppId, icon: ico, iconIndex: 0 });
  // Windows may hand paths back in another case; that is still this copy's shortcut.
  assert.ok(shortcutChanges({ target: exe.toUpperCase() }, exe, ico));
  assert.equal(shortcutChanges({ target: exe, icon: ico.toLowerCase(), iconIndex: 0, appUserModelId: windowsAppId }, exe, ico), null,
    "a shortcut that is already right is not written again");
  assert.equal(shortcutChanges({ target: "D:\\Portable\\Branch Agent.exe", icon: "D:\\x.exe" }, exe, ico), null,
    "a shortcut to another copy is left alone");
  assert.deepEqual(shortcutChanges({ target: exe }, exe, null), { target: exe, appUserModelId: windowsAppId },
    "without the .ico only the app ID is written");
});

function fakes({ files, shortcuts, registry }) {
  const written = [], regWrites = [];
  return {
    written, regWrites,
    deps: {
      exists: (path) => files.has(path) || path in shortcuts,
      readShortcut: (path) => { if (shortcuts[path] === "broken") throw new Error("not a shortcut"); return shortcuts[path]; },
      updateShortcut: (path, fields) => { written.push([path, fields]); return true; },
      readRegistry: async (_key, name) => registry[name] ?? null,
      writeRegistry: async (key, entries) => { regWrites.push([key, entries]); },
    },
  };
}

test("an update fixes the shortcuts and the Add or remove programs icon a 0.18.0 install left behind", async () => {
  const f = fakes({
    files: new Set([ico]),
    shortcuts: { [startMenu]: { target: exe, icon: exe, iconIndex: 0 }, [pinned]: { target: exe, icon: exe, iconIndex: 0 },
      [desktop]: { target: exe, icon: exe, iconIndex: 0 } },
    registry: { InstallLocation: root, DisplayIcon: exe },
  });
  const report = await refreshWindowsIdentity({ installRoot: root, executableName: "Branch Agent.exe", env, hive: "HKCU\\T" }, f.deps);
  assert.deepEqual(report, { updated: [startMenu, pinned, desktop], displayIcon: true });
  for (const [, fields] of f.written) assert.deepEqual(fields, { target: exe, appUserModelId: windowsAppId, icon: ico, iconIndex: 0 });
  assert.deepEqual(f.regWrites, [[uninstallKey("HKCU\\T"), [{ name: "DisplayIcon", type: "REG_SZ", value: ico }]]]);
});

test("nothing is written when all is right, and nothing of another install is touched", async () => {
  const right = { target: exe, icon: ico, iconIndex: 0, appUserModelId: windowsAppId };
  const done = fakes({ files: new Set([ico]), shortcuts: { [startMenu]: right }, registry: { InstallLocation: root, DisplayIcon: ico } });
  assert.deepEqual(await refreshWindowsIdentity({ installRoot: root, executableName: "Branch Agent.exe", env }, done.deps),
    { updated: [], displayIcon: false });
  assert.equal(done.written.length + done.regWrites.length, 0);

  // A portable copy elsewhere: the installed copy's shortcuts and its list entry are not its to change.
  const portable = "D:\\Stick\\Branch Agent";
  const other = fakes({
    files: new Set([join(portable, shippedIconPath)]),
    shortcuts: { [startMenu]: { target: exe, icon: exe }, [desktop]: "broken" },
    registry: { InstallLocation: root, DisplayIcon: exe },
  });
  assert.deepEqual(await refreshWindowsIdentity({ installRoot: portable, executableName: "Branch Agent.exe", env }, other.deps),
    { updated: [], displayIcon: false });
  assert.equal(other.written.length + other.regWrites.length, 0);
});

test("the installer asks the installed app to stamp its shortcuts, and still installs when that fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "branch-win-icon-"));
  t.after(() => discardTemp(dir));
  const source = join(dir, "unpacked");
  await mkdir(join(source, "resources", "app", "public", "assets"), { recursive: true });
  await writeFile(join(source, "Branch Agent.exe"), "program");
  await writeFile(join(source, shippedIconPath), "icon");
  const calls = [];
  const deps = {
    run: async (file, args) => { calls.push([file, args]); return ""; },
    quit: async () => ({ wasRunning: false, stopped: false }),
    locked: async () => false,
  };
  const options = (name) => ({
    source, installRoot: join(dir, name), executableName: "Branch Agent.exe", version: "0.18.1",
    startMenuDir: join(dir, name, "menu"), desktopDir: null, uninstallHive: "HKCU\\T", userDataDir: join(dir, name, "data"),
    legacyDataDirs: [],
  });
  const stamped = [];
  const good = await performInstall(options("a"), { ...deps, stampShortcuts: async (executable) => { stamped.push(executable); } });
  assert.deepEqual(stamped, [join(dir, "a", "Branch Agent.exe")]);
  assert.equal(good.shortcutsStamped, true);
  // The script-host shortcut already names the .ico, so a failed stamp still shows the KeepOak mark.
  const script = calls.find(([file]) => file.endsWith("cscript.exe"));
  assert.ok(script, "the shortcut script ran");
  const bad = await performInstall(options("b"), { ...deps, stampShortcuts: async () => { throw new Error("no desktop"); } });
  assert.equal(bad.shortcutsStamped, false);
  const icon = calls.find(([, args]) => args.includes("DisplayIcon") && args.some((a) => a.includes(join(dir, "b"))));
  assert.equal(icon[1][icon[1].indexOf("/d") + 1], join(dir, "b", shippedIconPath));
});

test("the app ID is set on Windows before the first window and before anything can quit", async () => {
  const main = await readFile(new URL("../dist/desktop/main.js", import.meta.url), "utf8");
  const id = main.indexOf('if (process.platform === "win32")\n    app.setAppUserModelId(windowsAppId);');
  assert.ok(id > 0, "set only on Windows, with the shared ID");
  for (const later of ["requestSingleInstanceLock()", "whenReady()"]) assert.ok(main.indexOf(later) > id, `${later} comes after`);
  // The one module-level code path that makes windows (createWindow) only runs from whenReady.
  assert.ok(main.indexOf("refreshShortcutsFlag)") > id);
  assert.match(main, /await refreshWindowsShortcuts\(\);\s*return start\(\);/, "shortcuts are put right before the window opens");
});
