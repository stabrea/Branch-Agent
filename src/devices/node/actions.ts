import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WallDeps } from "../../sandbox-backends.js";
import { parseDeviceArgs } from "../args.js";
import { capabilities, mediaLimitBytes, offeredOn, textLimitBytes, type Capability } from "../capabilities.js";
import {
  cameraCommand, clipboardReadCommand, clipboardWriteCommand, listenCommand, locationCommand, needs, notifyCommand,
  openCommand, screenCommand, speakCommand, type NodeOs, type OsCommand,
} from "./commands.js";
import { walledCommand } from "./wall.js";

/**
 * mac7/nodes: a Branch node doing one switched-on thing. Every program goes through `runner`, so
 * tests hand in a fake and nothing on the machine running the tests is touched.
 */
export interface RunOptions { cwd?: string; timeoutMs: number; maxBytes: number }
export interface RunOutput { code: number | null; stdout: Buffer; stderr: string }
export type Runner = (command: OsCommand, options: RunOptions) => Promise<RunOutput>;
export interface ActionResult { value: unknown; media?: { mime: string; name: string; data: Buffer } }

export interface ActionDeps {
  os: NodeOs;
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
  /** Whether a program can be found; looks along PATH by default. */
  find?: (program: string) => Promise<boolean>;
  /** The node's own folder (its key), which a walled command can never read. */
  identityDir: string;
  wall?: WallDeps;
}

const mimeByExt: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".wav": "audio/wav", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".pdf": "application/pdf",
  ".csv": "text/csv", ".html": "text/html", ".mp4": "video/mp4" };
const mimeOf = (path: string): string => mimeByExt[extname(path).toLowerCase()] ?? "application/octet-stream";

/** Starts a program without a shell and collects at most `maxBytes` of what it prints. */
export const spawnRunner: Runner = (command, options) => new Promise((done, fail) => {
  const child = spawn(command.executable, command.args, { cwd: options.cwd, shell: false, windowsHide: true,
    env: { ...process.env, ...command.env }, stdio: ["pipe", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let size = 0, stderr = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= options.maxBytes) chunks.push(chunk); else child.kill("SIGKILL"); });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString("utf8"); });
  child.on("error", (error) => { clearTimeout(timer); fail(error); });
  child.on("close", (code) => { clearTimeout(timer); done({ code, stdout: Buffer.concat(chunks), stderr: stderr.slice(0, 4000) }); });
  child.stdin.end(command.input ?? "");
});

export async function onPath(program: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const candidates = isAbsolute(program) ? [program]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, program));
  for (const path of candidates) if (await access(path, constants.X_OK).then(() => true, () => false)) return true;
  return false;
}

export class NodeActions {
  private readonly runner: Runner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly find: (program: string) => Promise<boolean>;
  constructor(private readonly deps: ActionDeps) {
    this.runner = deps.runner ?? spawnRunner;
    this.env = deps.env ?? process.env;
    this.find = deps.find ?? ((program) => onPath(program, this.env));
  }

  /** What this machine could offer: the platform's list, less whatever lacks the program it needs. */
  async available(): Promise<Capability[]> {
    const found: Capability[] = [];
    for (const capability of offeredOn(this.deps.os)) {
      const wanted = needs[this.deps.os][capability] ?? [];
      let ok = true;
      for (const need of wanted) {
        const any = await Promise.all(need.split("|").map((program) => this.find(program)));
        if (!any.includes(true)) ok = false;
      }
      if (ok) found.push(capability);
    }
    return capabilities.filter((capability) => found.includes(capability));
  }

  /**
   * Called only when the owner switches a capability on for this device. Taking one throwaway
   * picture or sound is what makes the operating system show its own permission question, here on
   * the device and at the moment the owner chose, rather than in the middle of a task later.
   */
  async prepare(capability: Capability): Promise<void> {
    if (!["camera", "screen", "listen"].includes(capability)) return;
    await this.capture(capability, { seconds: 1, facing: "back" }).catch(() => undefined);
  }

  async perform(capability: Capability, raw: unknown, folder: string | null): Promise<ActionResult> {
    const args = parseDeviceArgs(capability, raw);
    const { os } = this.deps;
    switch (capability) {
      case "camera": case "screen": case "listen": return this.capture(capability, args);
      case "location": return this.location();
      case "notify": return this.simple(notifyCommand(os, String(args.title), String(args.body ?? "")), "shown");
      case "clipboard-read": return this.clipboard();
      case "clipboard-write": return this.simple(clipboardWriteCommand(os, String(args.text), this.env), "copied");
      case "open-url": return this.simple(openCommand(os, String(args.url)), "opened");
      case "speak": return this.simple(speakCommand(os, String(args.text)), "spoken");
      case "files": return this.files(needFolder(folder), String(args.action), String(args.path ?? ""));
      case "run": return this.run(needFolder(folder), args as { executable: string; args: string[]; timeoutSeconds: number });
      default: throw new Error("This device does not do that.");
    }
  }

  private async simple(command: OsCommand, done: string): Promise<ActionResult> {
    const out = await this.runner(command, { timeoutMs: 30_000, maxBytes: 4096 });
    if (out.code !== 0) throw new Error(`The device could not do it: ${out.stderr.trim().slice(0, 300) || `exit ${out.code}`}`);
    return { value: { done } };
  }

  private async capture(capability: Capability, args: Record<string, unknown>): Promise<ActionResult> {
    const dir = await mkdtemp(join(tmpdir(), "branch-node-"));
    try {
      const ext = capability === "listen" ? ".wav" : capability === "camera" ? ".jpg" : ".png";
      const out = join(dir, `capture${ext}`);
      const command = capability === "screen" ? screenCommand(this.deps.os, out, this.env)
        : capability === "camera" ? cameraCommand(this.deps.os, out) : listenCommand(this.deps.os, out, Number(args.seconds ?? 5));
      if (!command) throw new Error("This device cannot do that.");
      const ran = await this.runner(command, { timeoutMs: 45_000, maxBytes: 4096 });
      if (ran.code !== 0) throw new Error(`The device could not do it: ${ran.stderr.trim().slice(0, 300) || `exit ${ran.code}`}`);
      const size = (await stat(out)).size;
      if (size > mediaLimitBytes) throw new Error("The picture or sound was larger than Branch accepts.");
      return { value: { captured: capability }, media: { mime: mimeOf(out), name: `${capability}${ext}`, data: await readFile(out) } };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async location(): Promise<ActionResult> {
    const command = locationCommand(this.deps.os);
    if (!command) throw new Error("This device cannot say where it is.");
    const out = await this.runner(command, { timeoutMs: 20_000, maxBytes: 16_384 });
    const parsed = parseWhereAmI(out.stdout.toString("utf8"));
    if (out.code !== 0 || !parsed) throw new Error("The device could not find where it is.");
    return { value: parsed };
  }

  private async clipboard(): Promise<ActionResult> {
    const out = await this.runner(clipboardReadCommand(this.deps.os, this.env), { timeoutMs: 10_000, maxBytes: textLimitBytes });
    if (out.code !== 0) throw new Error("The device could not read what was copied.");
    return { value: { text: out.stdout.toString("utf8").slice(0, textLimitBytes) } };
  }

  private async files(folder: string, action: string, path: string): Promise<ActionResult> {
    const target = await inside(folder, path);
    if (action === "list") {
      const entries = await readdir(target, { withFileTypes: true });
      return { value: { entries: entries.slice(0, 200).map((entry) => ({ name: entry.name, folder: entry.isDirectory() })) } };
    }
    const info = await stat(target);
    if (!info.isFile()) throw new Error("That is not a file.");
    if (info.size > mediaLimitBytes) throw new Error("That file is larger than Branch accepts.");
    return { value: { read: path }, media: { mime: mimeOf(target), name: path.split(/[\\/]/).pop() || "file", data: await readFile(target) } };
  }

  private async run(folder: string, args: { executable: string; args: string[]; timeoutSeconds: number }): Promise<ActionResult> {
    const opened = await walledCommand(this.deps.os, folder, args,
      { hidden: [this.deps.identityDir], env: this.env, ...(this.deps.wall ? { deps: this.deps.wall } : {}) });
    try {
      const out = await this.runner({ executable: opened.start.executable, args: opened.start.args, env: stringEnv(opened.start.env) },
        { cwd: folder, timeoutMs: args.timeoutSeconds * 1000, maxBytes: textLimitBytes });
      const note = await opened.finish({ exitCode: out.code ?? -1, stdout: out.stdout.toString("utf8"), stderr: out.stderr });
      return { value: { exitCode: out.code, stdout: out.stdout.toString("utf8"), stderr: out.stderr, ...(note ? { wall: note } : {}) } };
    } finally {
      await opened.close();
    }
  }
}

const stringEnv = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

function needFolder(folder: string | null): string {
  if (!folder) throw new Error("No folder has been chosen for this device. The owner chooses one in Customize, Channels, Devices.");
  return folder;
}

/** The real place `path` names, refused unless it is inside `folder` (links included). */
export async function inside(folder: string, path: string): Promise<string> {
  const root = await realpath(folder);
  const target = await realpath(resolve(root, path || "."));
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("That place is outside the chosen folder.");
  return target;
}

/** GeoClue's demo prints "Latitude: 48.85°" style lines. */
export function parseWhereAmI(text: string): { latitude: number; longitude: number; accuracyMeters: number | null } | null {
  const number = (label: string): number | null => {
    const match = new RegExp(`${label}:\\s*(-?[0-9.]+)`, "i").exec(text);
    return match ? Number(match[1]) : null;
  };
  const latitude = number("Latitude"), longitude = number("Longitude");
  if (latitude === null || longitude === null || Number.isNaN(latitude) || Number.isNaN(longitude)) return null;
  return { latitude, longitude, accuracyMeters: number("Accuracy") };
}
