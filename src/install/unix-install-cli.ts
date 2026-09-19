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
 *           [--applications | --no-applications]
 *
 * `--assistant` makes a custom distribution: an assistant file made with `branch export-agent` is
 * brought in on a fresh install, so everyone who installs from that folder starts with the same
 * specialists, procedures and skills. It follows a market's rules: approval rules, model choices and
 * memory never come in this way, and new skills arrive switched off. It never replaces an assistant
 * that is already set up on this computer.
 *   uninstall [--delete-data]     removes Branch and everything it downloaded; conversations and
 *                                 files stay unless --delete-data is given
 */
/**
 * mac7/app-icon. macOS treats a program as properly installed when it is in the Applications folder,
 * and it marks anything that came from the internet until something takes the mark off — which is
 * why an app unpacked from a download is refused. Branch can do both, but it asks first.
 *
 * The question is only ever put to a person at a terminal. `--applications` and `--no-applications`
 * answer it in advance, and `--quiet` or a script with no terminal is never asked, so the installer
 * keeps its promise that it asks nothing of anything that is not a person.
 */
export const applicationsQuestion = [
  "",
  "macOS treats a program as properly installed once it is in the Applications folder, and it marks",
  "anything that came from the internet until something takes that mark off. Branch Agent can put",
  "itself in Applications and take the mark off its own copy, so it opens like any other app.",
  "",
  "Put Branch Agent in the Applications folder? [Y/n] ",
].join("\n");

/** An answer already given on the command line, or null when nobody has said. */
export function answeredApplications(args: string[]): boolean | null {
  if (args.includes("--no-applications")) return false;
  if (args.includes("--applications")) return true;
  return null;
}

export type Ask = (question: string) => Promise<string>;

/** Whether this install goes into the shared Applications folder. */
export async function wantsApplications(
  args: string[], platform: UnixPlatform, terminal: boolean, ask: Ask,
): Promise<boolean> {
  const answered = answeredApplications(args);
  if (answered !== null) return answered;
  if (platform !== "darwin" || args.includes("--quiet") || !terminal) return false;
  const reply = (await ask(applicationsQuestion)).trim().toLowerCase();
  return reply === "" || reply.startsWith("y");
}

const askOnTerminal: Ask = async (question) => {
  const { createInterface } = await import("node:readline/promises");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return await terminal.question(question); } finally { terminal.close(); }
};

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

export async function unixInstall(
  args: string[], layout: UnixLayout, print: (line: string) => void, run: RunBranch = runBranch, ask: Ask = askOnTerminal,
): Promise<void> {
  const source = flag(args, "source");
  if (!source) throw new Error("Tell the installer where the unpacked app is: --source <folder>");
  const assistant = flag(args, "assistant");
  if (assistant !== undefined && !existsSync(assistant)) throw new Error(`The assistant file ${assistant} was not found, so nothing was installed.`);
  const applications = await wantsApplications(args, layout.platform, Boolean(process.stdin.isTTY), ask);
  const report = await performUnixInstall({
    layout, source, version: await versionOf(layout.platform, source),
    // The one question covers both: yes moves the app and takes the mark off the copy it makes.
    menuEntry: !args.includes("--no-menu-entry"), repair: args.includes("--repair"), applications, clearMark: applications,
  });
  print(report.attached
    ? `Branch Agent ${report.version} was already installed in ${report.installRoot}; it is linked up again.`
    : `Branch Agent ${report.version} is installed in ${report.installRoot}.`);
  if (report.movedFrom) print(`The copy that was in ${report.movedFrom} has been taken away, so there is only one.`);
  if (report.previousKept) print(`The version that was there is kept in ${report.previousKept}.`);
  print(`The \`branch\` command is ${report.launcher}.`);
  if (report.menuEntry) print(`It is in your applications menu (${report.menuEntry}).`);
  if (report.icons.length) print(`Its icon is in your icon theme (${report.icons.length} sizes).`);
  for (const line of afterInstallNotes(report, layout, applications)) print(line);
  if (assistant !== undefined) await bringAssistant(assistant, report, run, print);
  print(`Your conversations and files are kept in ${report.dataDir}.`);
}

/** What macOS did, and what was not done, said once in plain words rather than done silently. */
export function afterInstallNotes(
  report: { quarantineCleared: boolean; attached: boolean; installRoot: string }, layout: UnixLayout, applications: boolean,
): string[] {
  if (report.quarantineCleared)
    return ["macOS marks anything that came from the internet, and it has been taken off this copy, so Branch Agent opens like any other app."];
  // Nobody said yes, so the mark was left on, and macOS may refuse the first open. Say so, and how.
  if (layout.platform !== "darwin" || applications || report.attached) return [];
  return [`macOS's internet mark was left on this copy, because nobody was asked. If macOS will not open it, run the installer again with --applications (it moves Branch Agent into Applications and takes the mark off), or allow it once under System Settings, Privacy & Security, Open Anyway.`];
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
