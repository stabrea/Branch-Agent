import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { daemonCommand, daemonLauncherName } from "./daemon.js";
import { headlessUpdate, type HeadlessUpdateDeps } from "./headless-update.js";
import { quitRunning, runningNow, type QuitDeps } from "./quit.js";
import { performUnixUninstall, unixLayout, type UnixLayout } from "./unix-install.js";
import type { RunTool } from "./windows.js";

/**
 * The commands a script uses to manage an installed Branch without clicking (bucket 22, issue #106):
 *
 *   branch --version --json      what is installed, where, and whether it is running
 *   branch quit                  close the running Branch and wait until it has gone
 *   branch update [--yes]        check for, and with --yes install, the newest release
 *   branch uninstall [--delete-data]   remove Branch; conversations and files stay unless asked
 *
 * Each answers with an exit code: 0 only when it did what it says.
 */
export interface ManageContext {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  version: string;
  /** The folder holding this copy's package.json (a Git checkout has `.git` beside it). */
  packageRoot: string;
  print: (line: string) => void;
  deps?: { quit?: QuitDeps; update?: HeadlessUpdateDeps; run?: RunTool; layout?: UnixLayout };
}

export interface VersionInfo { version: string; path: string; dataDir: string; running: boolean; installed: boolean }

const dataDirOf = (env: NodeJS.ProcessEnv): string => resolve(env.BRANCH_DATA_DIR ?? ".branch");

export async function versionInfo(context: ManageContext): Promise<VersionInfo> {
  const dataDir = dataDirOf(context.env);
  const installRoot = context.env.BRANCH_INSTALL_ROOT;
  return {
    version: context.version, path: installRoot || context.packageRoot, dataDir,
    running: (await runningNow(dataDir, context.deps?.quit?.alive)) !== null, installed: Boolean(installRoot),
  };
}

async function quit(context: ManageContext): Promise<number> {
  const report = await quitRunning(dataDirOf(context.env), context.deps?.quit);
  context.print(report.message);
  return report.stopped ? 0 : 1;
}

async function uninstall(context: ManageContext, args: string[]): Promise<number> {
  if (context.platform === "win32") {
    context.print("On Windows, remove Branch under Add or remove programs, or run `Uninstall Branch Agent.cmd /quiet` from its folder (add --delete-data to remove conversations and files too).");
    return 1;
  }
  if (context.platform !== "darwin" && context.platform !== "linux") { context.print("Removing Branch is not available on this kind of computer."); return 1; }
  const layout = context.deps?.layout ?? unixLayout(context.platform, context.env);
  const report = await performUnixUninstall({
    layout, deleteData: args.includes("--delete-data"),
    stop: async () => {
      const closed = await quitRunning(layout.dataDir, context.deps?.quit);
      if (!closed.stopped) throw new Error(closed.message);
    },
    removeService: async () => {
      await daemonCommand("uninstall", {
        executable: "", script: "", dataDir: layout.dataDir, workspace: layout.workspace, port: 0,
        launcherPath: join(layout.dataDir, daemonLauncherName), platform: context.platform,
        plistPath: layout.serviceFile, unitPath: layout.serviceFile,
      }, context.deps?.run ? { run: context.deps.run } : {});
    },
  });
  context.print(report.removed.length ? `Branch Agent has been removed (${report.removed.length} places).` : "Branch Agent was not installed here; nothing needed removing.");
  for (const copy of report.left) context.print(`${copy} was not put there by this installer, so it was left; remove it yourself if you want it gone.`);
  context.print(report.dataKept ? `Your conversations and files are kept in ${report.dataKept}.` : "Your conversations and files were removed too.");
  return 0;
}

/** Answers with an exit code, or null when the command is not one of these (or `update` belongs to a Git checkout). */
export async function manageCommand(args: string[], context: ManageContext): Promise<number | null> {
  const [command = "", ...rest] = args;
  if (command === "version" && rest.includes("--json")) {
    context.print(JSON.stringify(await versionInfo(context)));
    return 0;
  }
  if (command === "quit") return quit(context);
  if (command === "uninstall") return uninstall(context, rest);
  if (command !== "update") return null;
  const installRoot = context.env.BRANCH_INSTALL_ROOT;
  if (!installRoot || existsSync(join(context.packageRoot, ".git"))) return null;
  return headlessUpdate({
    installRoot, dataDir: dataDirOf(context.env), version: context.version, platform: context.platform,
    yes: rest.includes("--yes") || rest.includes("-y"), print: context.print, ...(context.deps?.update ? { deps: context.deps.update } : {}),
  });
}
