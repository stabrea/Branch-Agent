import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installedLocation, legacyDataDirs, migrateLegacyData, type MigrationReport } from "./layout.js";
import { createShortcuts, regDeleteKeyArgs, runTool, systemTool, writeRegistryValues, type RegistryValue, type RunTool } from "./windows.js";

/**
 * Installing without a signed installer. The release zip already carries a complete Node runtime
 * (the app's own executable), so a two-line Windows script unpacks the zip and hands the real work
 * back to this file: copy the app into the person's own programs folder, make the Start menu entry,
 * register an Uninstall entry, keep the previous version, and bring older data along.
 */
export const defaultUninstallHive = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
export const uninstallKeyName = "BranchAgent";
export const publisher = "Branch Agent";

export interface InstallOptions {
  /** Folder holding the unpacked app (the one with the executable in it). */
  source: string;
  /** Where the app is installed, normally %LOCALAPPDATA%\Programs\Branch Agent. */
  installRoot: string;
  executableName: string;
  version: string;
  /** Folder for the Start menu shortcut. */
  startMenuDir: string;
  /** Folder for the desktop shortcut, or null to skip it. */
  desktopDir?: string | null;
  /** Root of the Add/Remove Programs list; tests pass their own so nothing real is written. */
  uninstallHive?: string;
  /** Where the app keeps saved work after this install. */
  userDataDir: string;
  legacyDataDirs?: string[];
}
export interface InstallReport {
  installRoot: string;
  executable: string;
  previousKept: string | null;
  shortcuts: string[];
  uninstallKey: string;
  uninstaller: string;
  data: MigrationReport;
}
export interface InstallDeps { run?: RunTool; systemRoot?: string }

export function defaultInstallRoot(env: NodeJS.ProcessEnv): string {
  const local = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Local");
  return join(local, "Programs", "Branch Agent");
}
export function uninstallKey(hive = defaultUninstallHive): string {
  return `${hive}\\${uninstallKeyName}`;
}
export const runKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const runValueName = "Branch Agent";

/**
 * mac7/app-icon: the KeepOak icon that travels inside the app, and what Windows shows when it is not
 * there. The executable itself is the stock Electron one (see scripts/package-desktop.mjs, which
 * copies it back over the packaged one so Smart App Control keeps recognising its hash), so it still
 * carries Electron's own logo. Every shortcut and every list entry has to name the `.ico` instead.
 */
export const shippedIconPath = join("resources", "app", "public", "assets", "keepoak.ico");
export function shortcutIcon(installRoot: string, executableName: string, hasIcon: boolean): string {
  return hasIcon ? `${join(installRoot, shippedIconPath)},0` : `${join(installRoot, executableName)},0`;
}

/** What Add/Remove Programs shows, and how it removes the app again. */
export function uninstallEntries(options: {
  installRoot: string; executableName: string; version: string; uninstaller: string; icon?: string;
}): RegistryValue[] {
  const quiet = `"${options.uninstaller}" /quiet`;
  return [
    { name: "DisplayName", type: "REG_SZ", value: "Branch Agent" },
    { name: "DisplayVersion", type: "REG_SZ", value: options.version },
    { name: "Publisher", type: "REG_SZ", value: publisher },
    { name: "InstallLocation", type: "REG_SZ", value: options.installRoot },
    { name: "DisplayIcon", type: "REG_SZ", value: options.icon ?? join(options.installRoot, options.executableName) },
    { name: "UninstallString", type: "REG_SZ", value: `"${options.uninstaller}"` },
    { name: "QuietUninstallString", type: "REG_SZ", value: quiet },
    { name: "NoModify", type: "REG_DWORD", value: "1" },
    { name: "NoRepair", type: "REG_DWORD", value: "1" },
  ];
}

/** The removal script left in the install folder; saved work is deliberately kept. */
export function uninstallScript(options: {
  installRoot: string; executableName: string; uninstallHive: string; userDataDir: string; shortcuts: string[];
}): string {
  const sys = "%SystemRoot%\\System32\\";
  const remove = options.shortcuts.map((path) => `del /q "${path}" 2>NUL`);
  return [
    "@echo off", "setlocal",
    // bucket 22: `--delete-data` removes conversations and files too; without it they are always kept.
    'set "DELETE_DATA="', 'for %%A in (%*) do if /i "%%~A"=="--delete-data" set "DELETE_DATA=1"',
    `if not defined DELETE_DATA echo Removing Branch Agent. Your conversations and files stay in ${options.userDataDir}.`,
    "if defined DELETE_DATA echo Removing Branch Agent, with its conversations and files.",
    `${sys}taskkill.exe /IM "${options.executableName}" /F >NUL 2>&1`,
    `${sys}ping.exe -n 3 127.0.0.1 >NUL`,
    `${sys}schtasks.exe /Delete /F /TN "Branch Agent daemon" >NUL 2>&1`,
    `${sys}reg.exe delete "${runKey}" /v "${runValueName}" /f >NUL 2>&1`,
    `${sys}reg.exe delete "${uninstallKey(options.uninstallHive)}" /f >NUL 2>&1`,
    ...remove,
    `rmdir /s /q "${options.installRoot}.previous" 2>NUL`,
    `if defined DELETE_DATA rmdir /s /q "${options.userDataDir}" 2>NUL`,
    // A script cannot delete the folder it is running from, so the last step runs from the temp folder.
    `start "" /d "%TEMP%" ${sys}cmd.exe /d /c "${sys}ping.exe -n 4 127.0.0.1 >NUL & rmdir /s /q ""${options.installRoot}"""`,
    "exit /b 0", "",
  ].join("\r\n");
}

/**
 * The script shipped next to the release zip. It unpacks the zip with the tar that comes with
 * Windows, then runs this module from inside the unpacked app, so installing needs nothing installed.
 */
export function bootstrapperScript(options: { assetName: string; executableName: string }): string {
  const sys = "%SystemRoot%\\System32\\";
  return [
    "@echo off", "setlocal enabledelayedexpansion", "title Install Branch Agent",
    // bucket 22: `/quiet` (or `--quiet`) never waits for a key press, so a script can run it. The stand-in
    // is `type NUL`, not `rem`: a `rem` would swallow the rest of the line it lands on, `exit` included.
    'set "PAUSE=pause"', 'for %%A in (%*) do if /i "%%~A"=="/quiet" set "PAUSE=type NUL"',
    'for %%A in (%*) do if /i "%%~A"=="--quiet" set "PAUSE=type NUL"',
    'set "HERE=%~dp0"', `set "ZIP=%HERE%${options.assetName}"`,
    'set "STAGE=%TEMP%\\branch-agent-setup"',
    `if not exist "%ZIP%" ( echo Put this file in the same folder as ${options.assetName} and run it again. & %PAUSE% & exit /b 1 )`,
    'rmdir /s /q "%STAGE%" 2>NUL', 'mkdir "%STAGE%"',
    "echo Unpacking Branch Agent...",
    `${sys}tar.exe -xf "%ZIP%" -C "%STAGE%"`,
    "if errorlevel 1 powershell.exe -NoProfile -NonInteractive -Command \"Expand-Archive -LiteralPath $env:ZIP -DestinationPath $env:STAGE -Force\"",
    `set "APP=%STAGE%"`,
    `if not exist "%APP%\\${options.executableName}" for /d %%D in ("%STAGE%\\*") do if exist "%%~fD\\${options.executableName}" set "APP=%%~fD"`,
    `if not exist "%APP%\\${options.executableName}" ( echo The download did not contain the app. & %PAUSE% & exit /b 1 )`,
    "echo Installing...",
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"%APP%\\${options.executableName}" "%APP%\\resources\\app\\dist\\install\\install-cli.js" install --source "%APP%" %*`,
    "set CODE=%ERRORLEVEL%",
    'rmdir /s /q "%STAGE%" 2>NUL',
    "if not \"%CODE%\"==\"0\" ( echo Installing did not finish. & %PAUSE% & exit /b %CODE% )",
    "echo Done. Branch Agent is in your Start menu.", "%PAUSE%", "exit /b 0", "",
  ].join("\r\n");
}

async function keepPrevious(installRoot: string, executableName: string): Promise<string | null> {
  const previous = `${installRoot}.previous`;
  const installed = await stat(join(installRoot, executableName)).then(() => true, () => false);
  if (!installed) return null;
  await rm(previous, { recursive: true, force: true });
  await cp(installRoot, previous, { recursive: true, force: true });
  return previous;
}

function shortcutTargets(options: InstallOptions): { path: string; desktop: boolean }[] {
  const targets = [{ path: join(options.startMenuDir, "Branch Agent.lnk"), desktop: false }];
  if (options.desktopDir) targets.push({ path: join(options.desktopDir, "Branch Agent.lnk"), desktop: true });
  return targets;
}

/** Whether the copy that was just installed carries the KeepOak `.ico`. */
async function hasShippedIcon(installRoot: string): Promise<boolean> {
  return stat(join(installRoot, shippedIconPath)).then(() => true, () => false);
}

/** Copies the app into place, makes the shortcuts, registers Uninstall and brings older data along. */
export async function performInstall(options: InstallOptions, deps: InstallDeps = {}): Promise<InstallReport> {
  const executable = join(options.installRoot, options.executableName);
  const previousKept = await keepPrevious(options.installRoot, options.executableName);
  await mkdir(options.installRoot, { recursive: true });
  await cp(options.source, options.installRoot, { recursive: true, force: true });
  await mkdir(options.startMenuDir, { recursive: true });
  if (options.desktopDir) await mkdir(options.desktopDir, { recursive: true });
  const iconLocation = shortcutIcon(options.installRoot, options.executableName, await hasShippedIcon(options.installRoot));
  const shortcuts = await createShortcuts(
    shortcutTargets(options).map((target) => ({
      path: target.path, target: executable, workingDirectory: options.installRoot,
      description: "Branch Agent — your assistant on this computer", iconLocation,
    })), deps);
  const hive = options.uninstallHive ?? defaultUninstallHive;
  const uninstaller = join(options.installRoot, "Uninstall Branch Agent.cmd");
  await writeFile(uninstaller, uninstallScript({
    installRoot: options.installRoot, executableName: options.executableName,
    uninstallHive: hive, userDataDir: options.userDataDir, shortcuts,
  }), "utf8");
  await writeRegistryValues(uninstallKey(hive), uninstallEntries({
    installRoot: options.installRoot, executableName: options.executableName,
    version: options.version, uninstaller, icon: iconLocation.replace(/,0$/, ""),
  }), deps);
  const target = installedLocation(options.userDataDir).dataDir;
  await mkdir(target, { recursive: true });
  const data = await migrateLegacyData(
    options.legacyDataDirs ?? legacyDataDirs(process.env), target);
  return { installRoot: options.installRoot, executable, previousKept, shortcuts, uninstallKey: uninstallKey(hive), uninstaller, data };
}

/** Removes the Add/Remove Programs entry; the folder itself is removed by the uninstall script. */
export async function removeUninstallEntry(hive: string, deps: InstallDeps = {}): Promise<void> {
  const run = deps.run ?? runTool;
  await run(systemTool("reg.exe", deps.systemRoot), regDeleteKeyArgs(uninstallKey(hive))).catch(() => undefined);
}
