import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { stagedEngine } from "../never-break/canary.js";
import { defaultInstallRoot, defaultUninstallHive, performInstall, removeUninstallEntry, type InstallDeps } from "./installer.js";
import { legacyDataDirs } from "./layout.js";
import { refreshShortcutsFlag } from "./windows-identity.js";

/**
 * `install-cli.js` on Windows, run from inside the unpacked download:
 *
 *   install --source <app> [--distribution <file>] [--install-root <dir>] [--start-menu <dir>]
 *           [--desktop <dir> | --no-desktop-shortcut] [--user-data <dir>] [--uninstall-hive <key>]
 *   uninstall [--uninstall-hive <key>]
 *
 * `--distribution` is a plain JSON file (docs/features.json, operations.distribution;
 * src/distribution.ts) naming the assistant's branding and preset model connections. Presets arrive
 * without a key — the owner still pastes their own — and it is brought in once, on a fresh install
 * only, never replacing anything already set up on this computer: the Windows counterpart of
 * unix-install-cli.ts's `--distribution` on macOS and Linux. Windows has no `--assistant` yet
 * (pre-existing gap, not this feature's job to close).
 */
const flag = (args: string[], name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
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
  return new Promise((resolveP, reject) => execFile(executable, [refreshShortcutsFlag],
    { env, windowsHide: true, timeout: 60000 }, (error) => (error ? reject(error) : resolveP())));
}

/**
 * Runs the just-installed app's own `dist/cli.js` as plain Node: Windows has no `branch` command on
 * PATH the way macOS and Linux do (unix-install-cli.ts's `runBranch`), so `apply-distribution` is run
 * straight against the installed engine instead.
 */
export type RunDistribution = (executable: string, args: string[]) => Promise<void>;
export const runDistribution: RunDistribution = async (executable, args) => {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  await promisify(execFile)(executable, args, { env, windowsHide: true, timeout: 30000, maxBuffer: 1048576 });
};

/**
 * `--distribution`'s Windows counterpart to unix-install-cli.ts's `bringDistribution`: brings in a
 * custom distribution's branding and preset model connections (src/distribution.ts) the same way, on
 * a fresh install only.
 */
export async function bringDistribution(
  file: string, installRoot: string, executableName: string, fresh: boolean, run: RunDistribution, print: (line: string) => void,
): Promise<void> {
  if (!fresh) {
    print("Branch Agent is already set up on this computer, so the distribution file was not brought in.");
    return;
  }
  const { executable, script } = stagedEngine(installRoot, "win32", executableName);
  await run(executable, [script, "apply-distribution", resolve(file)]);
  print(`The distribution in ${file} was brought in.`);
}

/** The `install` command's own logic; separated from `windowsInstallMain` so tests can hand in stand-ins for everything Windows-specific. */
export async function windowsInstall(
  args: string[], env: NodeJS.ProcessEnv, print: (line: string) => void,
  installDeps: InstallDeps = {}, runDist: RunDistribution = runDistribution,
): Promise<void> {
  const installRoot = flag(args, "install-root") ?? defaultInstallRoot(env);
  const source = flag(args, "source");
  if (!source) throw new Error("Tell the installer where the unpacked app is: --source <folder>");
  const distribution = flag(args, "distribution");
  if (distribution !== undefined && !existsSync(distribution)) throw new Error(`The distribution file ${distribution} was not found, so nothing was installed.`);
  const appData = env.APPDATA ?? join(env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Roaming");
  const executableName = "Branch Agent.exe";
  const report = await performInstall({
    source, installRoot, executableName, version: await version(source),
    startMenuDir: flag(args, "start-menu") ?? join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
    desktopDir: args.includes("--no-desktop-shortcut") ? null : (flag(args, "desktop") ?? join(env.USERPROFILE ?? "", "Desktop")),
    uninstallHive: flag(args, "uninstall-hive") ?? defaultUninstallHive,
    userDataDir: flag(args, "user-data") ?? join(appData, "Branch Agent"),
    legacyDataDirs: legacyDataDirs(env),
  }, { stampShortcuts, ...installDeps });
  if (report.closedFirst) print("Branch Agent was open, so it was closed first. Open it again from the Start menu."); // mac7/real-update
  print(`Branch Agent is installed in ${report.installRoot}.`);
  print(`Shortcuts: ${report.shortcuts.join(", ")}`);
  if (report.previousKept) print(`The version that was there is kept in ${report.previousKept}.`);
  if (report.data.reason === "copied") print(`Your earlier conversations were brought over from ${report.data.from}.`);
  // Worked out from the same migration step performInstall already ran: a database already at the
  // target data folder means this computer was already set up, so the distribution is never replayed.
  if (distribution !== undefined)
    await bringDistribution(distribution, report.installRoot, executableName, report.data.reason !== "already-set-up", runDist, print);
}

/** `install-cli.js`'s own entrypoint on Windows: `install --source <app> ... | uninstall`. */
export async function windowsInstallMain(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const command = args[0] ?? "install";
  const hive = flag(args, "uninstall-hive") ?? defaultUninstallHive;
  if (command === "uninstall") {
    await removeUninstallEntry(hive);
    console.log("Branch Agent has been taken out of the Add or remove programs list.");
    return;
  }
  if (command !== "install") throw new Error("Usage: install-cli.js install --source <folder> | uninstall");
  await windowsInstall(args.slice(1), env, (line) => console.log(line));
}
