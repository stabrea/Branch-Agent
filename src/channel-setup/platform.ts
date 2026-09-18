import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, posix } from "node:path";
import type { Recipe } from "./recipes.js";

/**
 * Getting a chat app onto this computer with the system's own official package manager: winget on
 * Windows, Homebrew casks on a Mac, Flatpak (Flathub, vendor-verified only) or Snap (verified
 * publishers only) on Linux. Every program is started with a list of arguments, never a shell line,
 * and every function takes the runner and the platform so tests hand in fakes and never install.
 */
export type Manager = "winget" | "brew" | "flatpak" | "snap";

export interface RunResult { code: number; stdout: string }
export interface Runner {
  /** `interactive` hands the terminal to the program, so it can ask its own questions. */
  run(command: string, args: string[], options?: { interactive?: boolean; timeoutMs?: number }): Promise<RunResult>;
}
export interface Probe {
  /** The full path of a program on PATH, or null. */
  which(name: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  home: string;
}

export type InstallPlan =
  | { kind: "package"; manager: Manager; command: string; args: string[]; sudo: boolean }
  | { kind: "download"; url: string; reason: string }
  | { kind: "nothing"; reason: string };

const managers: Partial<Record<NodeJS.Platform, Manager[]>> = { win32: ["winget"], darwin: ["brew"], linux: ["flatpak", "snap"] };
export const managersFor = (platform: NodeJS.Platform): Manager[] => managers[platform] ?? [];

/** The exact program and arguments for one package. Snap is the only one that needs sudo. */
export function installArgs(manager: Manager, id: string): { command: string; args: string[]; sudo: boolean } {
  if (manager === "winget") return { command: "winget", args: ["install", "--exact", "--id", id, "--source", "winget"], sudo: false };
  if (manager === "brew") return { command: "brew", args: ["install", "--cask", id], sudo: false };
  if (manager === "flatpak") return { command: "flatpak", args: ["install", "--user", "flathub", id], sudo: false };
  return { command: "sudo", args: ["snap", "install", id], sudo: true };
}

/** What would be installed here, and how. Nothing unofficial is ever offered: no package means the vendor's page. */
export async function planInstall(recipe: Recipe, platform: NodeJS.Platform, probe: Probe): Promise<InstallPlan> {
  const app = recipe.app;
  if (!app) return { kind: "nothing", reason: recipe.noApp ?? "There is nothing to install." };
  let missing: Manager | null = null;
  for (const manager of managersFor(platform)) {
    const id = app[manager];
    if (!id) continue;
    if (await probe.which(manager)) return { kind: "package", manager, ...installArgs(manager, id) };
    missing ??= manager;
  }
  const reason = missing
    ? `${managerName(missing)} is not on this computer, so the official download page opens instead.`
    : `${app.name} has no official package for this system, so its download page opens instead.`;
  return { kind: "download", url: app.download, reason };
}
export function managerName(manager: Manager): string {
  return { winget: "winget", brew: "Homebrew", flatpak: "Flatpak", snap: "Snap" }[manager];
}

/** The plan as one line the owner can read or copy. */
export function planLine(plan: InstallPlan): string {
  if (plan.kind !== "package") return plan.kind === "download" ? plan.url : "";
  return [plan.command, ...plan.args].join(" ");
}

/** Whether the app is already here: true, false, or null when this computer cannot tell. */
export async function isInstalled(recipe: Recipe, platform: NodeJS.Platform, probe: Probe, runner: Runner): Promise<boolean | null> {
  const app = recipe.app;
  if (!app) return null;
  // A Mac's folders are written the Mac's way even when the question is asked from Windows, where
  // the host's own join would turn /Applications into \Applications and find nothing.
  if (platform === "darwin" && app.macApp)
    return (await probe.exists(posix.join("/Applications", app.macApp))) || (await probe.exists(posix.join(probe.home, "Applications", app.macApp)));
  const asks: [Manager, string[]][] = platform === "win32" ? [["winget", ["list", "--exact", "--id", app.winget ?? ""]]]
    : platform === "linux" ? [["flatpak", ["info", app.flatpak ?? ""]], ["snap", ["list", app.snap ?? ""]]] : [];
  let known = false;
  for (const [manager, args] of asks) {
    if (!app[manager] || !(await probe.which(manager))) continue;
    known = true;
    const answer = await runner.run(manager, args, { timeoutMs: 30_000 }).catch(() => ({ code: 1, stdout: "" }));
    if (answer.code === 0 && (manager !== "winget" || answer.stdout.includes(app[manager]!))) return true;
  }
  return known ? false : null;
}

/** Only links from a recipe are ever opened, and only these kinds. */
const openable = /^(https:\/\/|tg:\/\/)[^\s"'<>`]+$/;
/** The program that opens a link in the app or browser the system prefers. */
export function openCommand(url: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (!openable.test(url)) throw new Error("Branch only opens official https and app links.");
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { command: "xdg-open", args: [url] };
}

/** The real runner: arguments only, no shell. */
export const systemRunner: Runner = {
  run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { shell: false, windowsHide: !options.interactive,
        stdio: options.interactive ? "inherit" : ["ignore", "pipe", "ignore"] });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < 200_000) stdout += chunk.toString("utf8"); });
      const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout }); });
    });
  },
};

/** The real probe: PATH is searched directly, so finding a program starts nothing. */
export function systemProbe(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Probe {
  const exists = async (path: string) => access(path, constants.F_OK).then(() => true, () => false);
  const endings = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  return {
    home: homedir(), exists,
    async which(name) {
      for (const folder of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean))
        for (const ending of endings) {
          const candidate = join(folder, name + ending);
          if (await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK).then(() => true, () => false)) return candidate;
        }
      return null;
    },
  };
}
