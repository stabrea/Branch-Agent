import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";

// These files only ever exist on macOS or Linux, so their paths use forward slashes wherever they are composed.
const { dirname, join } = posix;
import type { DaemonAction, DaemonReport } from "./daemon.js";
import { runTool, type RunTool } from "./windows.js";

/**
 * Keeping Branch working with the window closed, on a Mac. A small file in the person's own
 * LaunchAgents folder asks macOS to start the engine when they sign in, with no window, and to start
 * it again only if it stops by accident. Nothing needs administrator rights.
 */
export const launchdLabel = "com.keepoak.branch-agent";
export const launchctl = "/bin/launchctl";

/** What the background engine runs, shared by the macOS and Linux sign-in entries. */
export interface ServiceProgram {
  executable: string;
  script: string;
  dataDir: string;
  workspace: string;
  port: number;
}
export interface ServiceTarget {
  /** Where the sign-in file is written; tests pass a temporary folder. */
  path: string;
  /** The signed-in person's user id (macOS only). */
  uid?: number;
}
export interface ServiceDeps { run?: RunTool; write?: (path: string, content: string) => Promise<void> }

export function serviceEnvironment(program: ServiceProgram): [string, string][] {
  return [
    ["ELECTRON_RUN_AS_NODE", "1"],
    ["BRANCH_DATA_DIR", program.dataDir],
    ["BRANCH_WORKSPACE", program.workspace],
    ["BRANCH_PORT", String(program.port)],
  ];
}
export const serviceLogFiles = (dataDir: string) => ({
  out: join(dataDir, "logs", "background.log"),
  err: join(dataDir, "logs", "background-errors.log"),
});

export function launchdPlistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${launchdLabel}.plist`);
}

const xml = (value: string) => value
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const string = (value: string) => `<string>${xml(value)}</string>`;

/** The sign-in file: starts at sign-in, restarts only after a crash, never opens a window. */
export function launchdPlist(program: ServiceProgram): string {
  const logs = serviceLogFiles(program.dataDir);
  const env = serviceEnvironment(program).map(([name, value]) => `    <key>${name}</key>${string(value)}`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', "<dict>",
    `  <key>Label</key>${string(launchdLabel)}`,
    "  <key>ProgramArguments</key>", "  <array>",
    ...[program.executable, program.script, "start"].map((arg) => `    ${string(arg)}`),
    "  </array>",
    "  <key>EnvironmentVariables</key>", "  <dict>", ...env, "  </dict>",
    `  <key>WorkingDirectory</key>${string(program.dataDir)}`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key>", "  <dict>", "    <key>SuccessfulExit</key><false/>", "  </dict>",
    "  <key>ProcessType</key><string>Background</string>",
    `  <key>StandardOutPath</key>${string(logs.out)}`,
    `  <key>StandardErrorPath</key>${string(logs.err)}`,
    "</dict>", "</plist>", "",
  ].join("\n");
}

export const launchdDomain = (uid: number) => `gui/${uid}`;
export const launchdBootstrapArgs = (uid: number, plist: string) => ["bootstrap", launchdDomain(uid), plist];
export const launchdBootoutArgs = (uid: number) => ["bootout", `${launchdDomain(uid)}/${launchdLabel}`];
export const launchdPrintArgs = (uid: number) => ["print", `${launchdDomain(uid)}/${launchdLabel}`];

const currentUid = (target: ServiceTarget): number => target.uid ?? process.getuid?.() ?? 501;

async function install(program: ServiceProgram, target: ServiceTarget, deps: ServiceDeps): Promise<DaemonReport> {
  const run = deps.run ?? runTool, uid = currentUid(target);
  const write = deps.write ?? ((path: string, content: string) => writeFile(path, content, "utf8"));
  // A copy that is already loaded is taken out first, so installing twice picks up the new file.
  await run(launchctl, launchdBootoutArgs(uid)).catch(() => undefined);
  await mkdir(dirname(target.path), { recursive: true });
  await mkdir(dirname(serviceLogFiles(program.dataDir).out), { recursive: true });
  await write(target.path, launchdPlist(program));
  await run(launchctl, launchdBootstrapArgs(uid, target.path));
  return {
    action: "install", taskName: launchdLabel, installed: true, command: `${program.executable} ${program.script} start`,
    message: "Branch now starts by itself when you sign in to your Mac, with no window. Timed jobs and chat replies keep working when the window is closed.",
  };
}

async function uninstall(target: ServiceTarget, deps: ServiceDeps): Promise<DaemonReport> {
  const run = deps.run ?? runTool;
  await run(launchctl, launchdBootoutArgs(currentUid(target))).catch(() => undefined);
  await rm(target.path, { force: true }).catch(() => undefined);
  return { action: "uninstall", taskName: launchdLabel, installed: false, message: "Branch will no longer start by itself. Open the app when you want it." };
}

async function status(target: ServiceTarget, deps: ServiceDeps): Promise<DaemonReport> {
  const run = deps.run ?? runTool;
  const installed = await run(launchctl, launchdPrintArgs(currentUid(target))).then(() => true, () => false);
  return {
    action: "status", taskName: launchdLabel, installed,
    message: installed
      ? "Branch starts by itself when you sign in to your Mac."
      : "Branch does not start by itself. Run `branch daemon install` to switch that on.",
  };
}

export async function launchdCommand(
  action: DaemonAction, program: ServiceProgram, target: ServiceTarget, deps: ServiceDeps = {},
): Promise<DaemonReport> {
  if (action === "install") return install(program, target, deps);
  if (action === "uninstall") return uninstall(target, deps);
  return status(target, deps);
}
