import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";

/**
 * Wave mac5 (local models): the programs that run models, found and started — never installed.
 *
 * Branch only starts a runtime the owner already has. When one is missing it says where the
 * official installer is and stops there. Every program is started with an argument list, never
 * a shell line, through a runner and a spawner the tests replace, and each is told to listen on
 * this computer only. Branch stops only what it started itself.
 */
export type RuntimeId = "ollama" | "lm-studio" | "llama-cpp" | "mlx";
export const runtimeIds: readonly RuntimeId[] = ["ollama", "lm-studio", "llama-cpp", "mlx"];

export interface RuntimeInfo {
  id: RuntimeId;
  name: string;
  /** Where the runtime answers. */
  baseUrl: string;
  /** The official page to install it from; Branch opens nothing and downloads nothing itself. */
  installPage: string;
  /** One sentence about installing it, for the screen. */
  installNote: string;
}
export const runtimeInfo: Record<RuntimeId, RuntimeInfo> = {
  ollama: { id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434", installPage: "https://ollama.com/download",
    installNote: "Free. Install it from ollama.com, then come back here." },
  "lm-studio": { id: "lm-studio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234", installPage: "https://lmstudio.ai/download",
    installNote: "Free. Install it from lmstudio.ai and open it once, then come back here." },
  "llama-cpp": { id: "llama-cpp", name: "llama.cpp", baseUrl: "http://127.0.0.1:8080", installPage: "https://github.com/ggml-org/llama.cpp/blob/master/docs/install.md",
    installNote: "Free. Its install page lists a package for each system; Branch uses its llama-server program." },
  mlx: { id: "mlx", name: "MLX", baseUrl: "http://127.0.0.1:8081", installPage: "https://github.com/ml-explore/mlx-lm",
    installNote: "Free, for Macs with Apple silicon. Its page shows how to install mlx-lm." },
};

export interface LaunchEnv {
  platform: string;
  arch: string;
  home: string;
  env: Record<string, string | undefined>;
}
export const thisComputer = (): LaunchEnv => ({ platform: process.platform, arch: process.arch, home: homedir(), env: process.env });

/** Where each runtime's program usually lives, beside whatever the search path finds. */
export function candidatePaths(id: RuntimeId, at: LaunchEnv): string[] {
  const exe = at.platform === "win32" ? ".exe" : "";
  const join = at.platform === "win32" ? win32.join : posix.join;
  const onPath = (name: string) => (at.env.PATH ?? at.env.Path ?? "").split(at.platform === "win32" ? ";" : ":")
    .filter(Boolean).map((dir) => join(dir, name + exe));
  const local = at.env.LOCALAPPDATA ?? join(at.home, "AppData", "Local");
  switch (id) {
    case "ollama":
      if (at.platform === "win32") return [join(local, "Programs", "Ollama", "ollama.exe"), ...onPath("ollama")];
      if (at.platform === "darwin") return [...onPath("ollama"), "/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", "/Applications/Ollama.app/Contents/Resources/ollama"];
      return [...onPath("ollama"), "/usr/local/bin/ollama", "/usr/bin/ollama"];
    case "lm-studio":
      return [join(at.home, ".lmstudio", "bin", "lms" + exe), ...onPath("lms")];
    case "llama-cpp":
      if (at.platform === "darwin") return [...onPath("llama-server"), "/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server"];
      return onPath("llama-server");
    case "mlx":
      if (at.platform !== "darwin" || at.arch !== "arm64") return [];
      return [...onPath("mlx_lm.server"), "/opt/homebrew/bin/mlx_lm.server", join(at.home, ".local", "bin", "mlx_lm.server")];
  }
}

export type Exists = (path: string) => Promise<boolean>;
const realExists: Exists = (path) => access(path, constants.X_OK).then(() => true, () => false);

/** The first program that is really there, or null. */
export async function findRuntime(id: RuntimeId, at: LaunchEnv = thisComputer(), exists: Exists = realExists): Promise<string | null> {
  for (const path of candidatePaths(id, at)) if (await exists(path)) return path;
  return null;
}

export type Runner = (file: string, args: string[], options: { timeout: number; windowsHide: boolean }) => Promise<{ stdout: string }>;
export interface Started { pid: number | undefined; stop(): void }
export type Spawner = (file: string, args: string[]) => Started;
const realRunner: Runner = promisify(execFile);
const realSpawner: Spawner = (file, args) => {
  const child = spawn(file, args, { stdio: "ignore", windowsHide: true, detached: false, env: { ...process.env, OLLAMA_HOST: "127.0.0.1:11434" } });
  child.on("error", () => undefined);
  return { pid: child.pid, stop: () => { child.kill(); } };
};

export interface StartPlan {
  /** Programs to run and wait for, in order (LM Studio's command line). */
  commands: string[][];
  /** The one program to keep running (a server), or null. */
  serve: string[] | null;
  /** When Branch should not start it itself, the sentence saying what to do instead. */
  instead: string | null;
}

/** What starting a runtime means on this system. Pure, so every system can be tested anywhere. */
export function startPlan(id: RuntimeId, program: string, model: { file?: string; repo?: string; context?: number }, at: LaunchEnv, serviceKnown = false): StartPlan {
  const ctx = String(model.context ?? 8192);
  switch (id) {
    case "ollama":
      if (at.platform === "linux" && serviceKnown)
        return { commands: [], serve: null, instead: "Ollama is installed as a system service here. Start it with: sudo systemctl start ollama" };
      return { commands: [], serve: [program, "serve"], instead: null };
    case "lm-studio":
      return { commands: [[program, "daemon", "up"], [program, "server", "start", "--port", "1234"]], serve: null, instead: null };
    case "llama-cpp":
      if (!model.file) return { commands: [], serve: null, instead: "Choose a model first; llama.cpp starts with one model." };
      return { commands: [], serve: [program, "-m", model.file, "-c", ctx, "--host", "127.0.0.1", "--port", "8080", "--jinja"], instead: null };
    case "mlx":
      if (!model.repo) return { commands: [], serve: null, instead: "Choose a model first; MLX starts with one model." };
      return { commands: [], serve: [program, "--model", model.repo, "--host", "127.0.0.1", "--port", "8081"], instead: null };
  }
}

export interface LauncherDeps {
  at?: LaunchEnv;
  exists?: Exists;
  run?: Runner;
  spawn?: Spawner;
}

/** Starts and stops runtimes, remembering which ones it started. */
export class RuntimeLauncher {
  private readonly started = new Map<RuntimeId, Started>();
  readonly at: LaunchEnv;
  private readonly exists: Exists;
  private readonly run: Runner;
  private readonly spawner: Spawner;
  constructor(deps: LauncherDeps = {}) {
    this.at = deps.at ?? thisComputer();
    this.exists = deps.exists ?? realExists;
    this.run = deps.run ?? realRunner;
    this.spawner = deps.spawn ?? realSpawner;
  }
  find(id: RuntimeId): Promise<string | null> { return findRuntime(id, this.at, this.exists); }
  /** Which runtimes are installed here, and where. */
  async installed(): Promise<Record<RuntimeId, string | null>> {
    const found = await Promise.all(runtimeIds.map(async (id) => [id, await this.find(id)] as const));
    return Object.fromEntries(found) as Record<RuntimeId, string | null>;
  }
  /** Whether Linux knows an Ollama system service (installed by its own script). */
  private async linuxService(): Promise<boolean> {
    if (this.at.platform !== "linux") return false;
    const answer = await this.run("systemctl", ["is-enabled", "ollama"], { timeout: 3000, windowsHide: true })
      .then((out) => out.stdout.trim(), (error: { stdout?: string }) => String(error?.stdout ?? "").trim());
    return answer === "enabled" || answer === "disabled";
  }
  /**
   * Starts an installed runtime. Refuses in plain words when it is not installed; never installs.
   * Returns the sentence to show.
   */
  async start(id: RuntimeId, model: { file?: string; repo?: string; context?: number } = {}): Promise<{ started: boolean; message: string }> {
    const program = await this.find(id);
    const info = runtimeInfo[id];
    if (!program) return { started: false, message: `${info.name} is not installed on this computer. ${info.installNote}` };
    const plan = startPlan(id, program, model, this.at, id === "ollama" ? await this.linuxService() : false);
    if (plan.instead) return { started: false, message: plan.instead };
    for (const command of plan.commands) await this.run(command[0]!, command.slice(1), { timeout: 60000, windowsHide: true });
    if (plan.serve) {
      this.stop(id);
      this.started.set(id, this.spawner(plan.serve[0]!, plan.serve.slice(1)));
    }
    return { started: true, message: `${info.name} is starting on this computer.` };
  }
  /** Stops a runtime Branch started. LM Studio is asked to stop its server; others are ended. */
  async stopRuntime(id: RuntimeId): Promise<{ stopped: boolean }> {
    if (id === "lm-studio") {
      const program = await this.find(id);
      if (!program) return { stopped: false };
      await this.run(program, ["server", "stop"], { timeout: 30000, windowsHide: true });
      return { stopped: true };
    }
    return { stopped: this.stop(id) };
  }
  private stop(id: RuntimeId): boolean {
    const running = this.started.get(id);
    if (!running) return false;
    this.started.delete(id);
    try { running.stop(); } catch { /* already gone */ }
    return true;
  }
  /** Whether Branch itself started this runtime (so Stop can be offered). */
  owns(id: RuntimeId): boolean { return this.started.has(id); }
  /** Ends everything Branch started, when the app closes. */
  stopAll(): void { for (const id of [...this.started.keys()]) this.stop(id); }
}
