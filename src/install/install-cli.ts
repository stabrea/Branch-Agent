#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultInstallRoot, defaultUninstallHive, performInstall, removeUninstallEntry } from "./installer.js";
import { legacyDataDirs } from "./layout.js";
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
  });
  console.log(`Branch Agent is installed in ${report.installRoot}.`);
  console.log(`Shortcuts: ${report.shortcuts.join(", ")}`);
  if (report.previousKept) console.log(`The version that was there is kept in ${report.previousKept}.`);
  if (report.data.reason === "copied") console.log(`Your earlier conversations were brought over from ${report.data.from}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
