#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultInstallRoot, defaultUninstallHive, performInstall, removeUninstallEntry } from "./installer.js";
import { legacyDataDirs } from "./layout.js";
import { refreshShortcutsFlag } from "./windows-identity.js";
// bucket 22: the same installer on macOS and Linux (src/install/unix-install-cli.ts).
import { unixInstallMain } from "./unix-install-cli.js";

/**
 * The installer's own small program. It runs from inside the unpacked download, using the runtime
 * that download already carries, so a person installs Branch without installing anything first.
 */
const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};

async function version(source: string): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(join(source, "resources", "app", "package.json"), "utf8")) as { version?: string };
    return manifest.version ?? "0.0.0";
  } catch { return "0.0.0"; }
}

/**
 * mac7/win-icon: runs the installed app once as itself (not as Node, which this installer is) so it
 * can give the new shortcuts the taskbar's app ID, then quits without opening a window.
 */
function stampShortcuts(executable: string): Promise<void> {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => execFile(executable, [refreshShortcutsFlag],
    { env, windowsHide: true, timeout: 60000 }, (error) => (error ? reject(error) : resolve())));
}

async function main(): Promise<void> {
  if (process.platform !== "win32") return unixInstallMain(process.argv.slice(2), process.env); // bucket 22
  const command = process.argv[2] ?? "install";
  const env = process.env;
  const installRoot = flag("install-root") ?? defaultInstallRoot(env);
  const hive = flag("uninstall-hive") ?? defaultUninstallHive;
  if (command === "uninstall") {
    await removeUninstallEntry(hive);
    console.log("Branch Agent has been taken out of the Add or remove programs list.");
    return;
  }
  if (command !== "install") throw new Error("Usage: install-cli.js install --source <folder> | uninstall");
  const source = flag("source");
  if (!source) throw new Error("Tell the installer where the unpacked app is: --source <folder>");
  const appData = env.APPDATA ?? join(env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Roaming");
  const report = await performInstall({
    source, installRoot, executableName: "Branch Agent.exe", version: await version(source),
    startMenuDir: flag("start-menu") ?? join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
    desktopDir: process.argv.includes("--no-desktop-shortcut") ? null : (flag("desktop") ?? join(env.USERPROFILE ?? "", "Desktop")),
    uninstallHive: hive,
    userDataDir: flag("user-data") ?? join(appData, "Branch Agent"),
    legacyDataDirs: legacyDataDirs(env),
  }, { stampShortcuts });
  if (report.closedFirst) console.log("Branch Agent was open, so it was closed first. Open it again from the Start menu."); // mac7/real-update
  console.log(`Branch Agent is installed in ${report.installRoot}.`);
  console.log(`Shortcuts: ${report.shortcuts.join(", ")}`);
  if (report.previousKept) console.log(`The version that was there is kept in ${report.previousKept}.`);
  if (report.data.reason === "copied") console.log(`Your earlier conversations were brought over from ${report.data.from}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
