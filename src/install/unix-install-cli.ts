import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { shareableSections } from "../interop/agent-market.js";
import { databaseName } from "./layout.js";
import { manageCommand } from "./manage-cli.js";
import { performUnixInstall, unixLayout, type UnixLayout, type UnixPlatform } from "./unix-install.js";

/**
 * `install-cli.js` on macOS and Linux, run from inside the unpacked download by
 * `install-branch-agent.sh`:
 *
 *   install --source <app> [--quiet] [--no-menu-entry] [--repair] [--assistant <file>]
 *
 * `--assistant` makes a custom distribution: an assistant file made with `branch export-agent` is
 * brought in on a fresh install, so everyone who installs from that folder starts with the same
 * specialists, procedures and skills. It follows a market's rules: approval rules, model choices and
 * memory never come in this way, and new skills arrive switched off. It never replaces an assistant
 * that is already set up on this computer.
 *   uninstall [--delete-data]
 */
const flag = (args: string[], name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

async function versionOf(platform: UnixPlatform, source: string): Promise<string> {
  const manifest = platform === "darwin"
    ? join(source, "Contents", "Resources", "app", "package.json")
    : join(source, "resources", "app", "package.json");
  const parsed = JSON.parse(await readFile(manifest, "utf8")) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : "0.0.0";
}

/** Runs the installed `branch` command; tests hand in a stand-in. */
export type RunBranch = (launcher: string, args: string[]) => Promise<void>;
const runBranch: RunBranch = async (launcher, args) => { await promisify(execFile)("/bin/sh", [launcher, ...args], { maxBuffer: 1048576 }); };

async function bringAssistant(file: string, report: { dataDir: string; launcher: string }, run: RunBranch, print: (line: string) => void): Promise<void> {
  if (existsSync(join(report.dataDir, databaseName))) {
    print("An assistant is already set up on this computer, so the assistant file was not brought in.");
    return;
  }
  // The same rules as a market: only specialists, procedures and skills, and new skills switched off.
  await run(report.launcher, ["import-agent", resolve(file), "--sections", shareableSections.join(","), "--shareable-only"]);
  print(`The assistant in ${file} was brought in.`);
}

export async function unixInstall(args: string[], layout: UnixLayout, print: (line: string) => void, run: RunBranch = runBranch): Promise<void> {
  const source = flag(args, "source");
  if (!source) throw new Error("Tell the installer where the unpacked app is: --source <folder>");
  const assistant = flag(args, "assistant");
  if (assistant !== undefined && !existsSync(assistant)) throw new Error(`The assistant file ${assistant} was not found, so nothing was installed.`);
  const report = await performUnixInstall({
    layout, source, version: await versionOf(layout.platform, source),
    menuEntry: !args.includes("--no-menu-entry"), repair: args.includes("--repair"),
  });
  print(report.attached
    ? `Branch Agent ${report.version} was already installed in ${report.installRoot}; it is linked up again.`
    : `Branch Agent ${report.version} is installed in ${report.installRoot}.`);
  if (report.previousKept) print(`The version that was there is kept in ${report.previousKept}.`);
  print(`The \`branch\` command is ${report.launcher}.`);
  if (report.menuEntry) print(`It is in your applications menu (${report.menuEntry}).`);
  if (assistant !== undefined) await bringAssistant(assistant, report, run, print);
  print(`Your conversations and files are kept in ${report.dataDir}.`);
}

export async function unixInstallMain(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux") throw new Error("There is no installer for this kind of computer.");
  const quiet = args.includes("--quiet");
  const print = (line: string) => { if (!quiet) console.log(line); };
  const [command = "install", ...rest] = args;
  if (command === "install") return unixInstall(rest, unixLayout(platform, env), print);
  if (command !== "uninstall") throw new Error("Usage: install-cli.js install --source <app> | uninstall [--delete-data]");
  const layout = unixLayout(platform, env);
  const code = await manageCommand(["uninstall", ...rest], {
    env: { ...env, BRANCH_DATA_DIR: layout.dataDir }, platform, version: "", packageRoot: "", print,
  });
  process.exitCode = code ?? 1;
}
