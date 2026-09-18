import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
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
  // Integration review: only whole folders; a relative entry (".", "bin") would be read from wherever Branch runs.
  const whole = at.platform === "win32" ? win32.isAbsolute : posix.isAbsolute;
  const onPath = (name: string) => (at.env.PATH ?? at.env.Path ?? "").split(at.platform === "win32" ? ";" : ":")
    .filter((dir) => dir && whole(dir) && (at.platform !== "win32" || /^([a-z]:\\|\\\\)/i.test(dir))).map((dir) => join(dir, name + exe));
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
/**
 * Integration review: a runtime gets Branch's variables minus anything secret or anything that
 * changes how a program loads (Branch's own settings, keys and tokens, NODE_OPTIONS, injected
 * libraries). What it needs to find its models and its graphics libraries stays.
 */
const secretName = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|COOKIE|AUTH)/i;
const loaderName = /^(BRANCH_|NODE_OPTIONS$|NODE_TEST_CONTEXT$|DYLD_|LD_PRELOAD$|LD_AUDIT$|ELECTRON_)/i;
export function runtimeChildEnv(env: Record<string, string | undefined>, extra: Record<string, string> = {}): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || secretName.test(name) || loaderName.test(name)) continue;
    clean[name] = value;
  }
  return { ...clean, ...extra };
}
const realRunner: Runner = (file, args, options) =>
  promisify(execFile)(file, args, { ...options, env: runtimeChildEnv(process.env) });
const realSpawner: Spawner = (file, args) => {
  const child = spawn(file, args, { stdio: "ignore", windowsHide: true, detached: false, env: runtimeChildEnv(process.env, { OLLAMA_HOST: "127.0.0.1:11434" }) });
  child.on("error", () => undefined);
  return { pid: child.pid, stop: () => { child.kill(); } };
};

export interface ModelToStart { file?: string; repo?: string; context?: number; port?: number }
/** A port nobody on this computer is using now, chosen by the system. */
export const freeLoopbackPort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("No free port on this computer"))));
  });
});
/** The runtimes Branch starts with one model, each on a fresh port (integration review). */
const ownPort = (id: RuntimeId): boolean => id === "llama-cpp" || id === "mlx";

export interface StartPlan {
  /** Programs to run and wait for, in order (LM Studio's command line). */
  commands: string[][];
  /** The one program to keep running (a server), or null. */
  serve: string[] | null;
  /** When Branch should not start it itself, the sentence saying what to do instead. */
  instead: string | null;
}

/**
 * Whether Linux has an Ollama system service, and whether it is already running. Ollama's own
 * installer puts one in place and starts it, so "active" is the ordinary state a moment after the
 * one-click install — and a service that is running is not something to start.
 */
export type LinuxService = "none" | "known" | "active";

/** What starting a runtime means on this system. Pure, so every system can be tested anywhere. */
export function startPlan(id: RuntimeId, program: string, model: ModelToStart, at: LaunchEnv, service: LinuxService = "none"): StartPlan {
  const ctx = String(model.context ?? 8192);
  const port = String(model.port ?? new URL(runtimeInfo[id].baseUrl).port);
  switch (id) {
    case "ollama":
      // It is already running: nothing to start, and starting a second copy would only fight it for
      // the port. Branch waits for it to answer instead.
      if (at.platform === "linux" && service === "active") return { commands: [], serve: null, instead: null };
      if (at.platform === "linux" && service === "known")
        return { commands: [], serve: null, instead: "Ollama is installed as a system service here. Start it with: sudo systemctl start ollama" };
      return { commands: [], serve: [program, "serve"], instead: null };
    case "lm-studio":
      return { commands: [[program, "daemon", "up"], [program, "server", "start", "--port", "1234"]], serve: null, instead: null };
    case "llama-cpp":
      if (!model.file) return { commands: [], serve: null, instead: "Choose a model first; llama.cpp starts with one model." };
      return { commands: [], serve: [program, "-m", model.file, "-c", ctx, "--host", "127.0.0.1", "--port", port, "--jinja"], instead: null };
    case "mlx":
      if (!model.repo) return { commands: [], serve: null, instead: "Choose a model first; MLX starts with one model." };
      return { commands: [], serve: [program, "--model", model.repo, "--host", "127.0.0.1", "--port", port], instead: null };
  }
}

export interface LauncherDeps {
  at?: LaunchEnv;
  exists?: Exists;
  run?: Runner;
  spawn?: Spawner;
  freePort?: () => Promise<number>;
}

/** Starts and stops runtimes, remembering which ones it started. */
export class RuntimeLauncher {
  private readonly started = new Map<RuntimeId, Started & { port?: number }>();
  readonly at: LaunchEnv;
  private readonly exists: Exists;
  private readonly run: Runner;
  private readonly spawner: Spawner;
  private readonly freePort: () => Promise<number>;
  constructor(deps: LauncherDeps = {}) {
    this.at = deps.at ?? thisComputer();
    this.exists = deps.exists ?? realExists;
    this.run = deps.run ?? realRunner;
    this.spawner = deps.spawn ?? realSpawner;
    this.freePort = deps.freePort ?? freeLoopbackPort;
  }
  /**
   * Where a runtime answers now: Ollama and LM Studio at their own fixed address, llama.cpp and MLX
   * only at the port Branch started them on, and nowhere (null) when Branch has not started them.
   */
  baseUrl(id: RuntimeId): string | null {
    if (!ownPort(id)) return runtimeInfo[id].baseUrl;
    const port = this.started.get(id)?.port;
    return port ? `http://127.0.0.1:${port}` : null;
  }
  find(id: RuntimeId): Promise<string | null> { return findRuntime(id, this.at, this.exists); }
  /**
   * mac7/one-click: the same runner and the same "is it really there" check the launcher itself
   * uses, so installing a program (src/local-install.ts) goes through one place a test replaces.
   */
  get program(): Runner { return this.run; }
  get fileExists(): Exists { return this.exists; }
  /** Which runtimes are installed here, and where. */
  async installed(): Promise<Record<RuntimeId, string | null>> {
    const found = await Promise.all(runtimeIds.map(async (id) => [id, await this.find(id)] as const));
    return Object.fromEntries(found) as Record<RuntimeId, string | null>;
  }
  /** Whether Linux knows an Ollama system service (installed by its own script), and whether it runs. */
  private async linuxService(): Promise<LinuxService> {
    if (this.at.platform !== "linux") return "none";
    const ask = (verb: string) => this.run("systemctl", [verb, "ollama"], { timeout: 3000, windowsHide: true })
      .then((out) => out.stdout.trim(), (error: { stdout?: string }) => String(error?.stdout ?? "").trim());
    if (await ask("is-active") === "active") return "active";
    const answer = await ask("is-enabled");
    return answer === "enabled" || answer === "disabled" ? "known" : "none";
  }
  /**
   * Starts an installed runtime. Refuses in plain words when it is not installed; never installs.
   * Returns the sentence to show.
   */
  async start(id: RuntimeId, model: ModelToStart = {}): Promise<{ started: boolean; message: string }> {
    const program = await this.find(id);
    const info = runtimeInfo[id];
    if (!program) return { started: false, message: `${info.name} is not installed on this computer. ${info.installNote}` };
    const port = ownPort(id) ? await this.freePort() : undefined;
    const plan = startPlan(id, program, { ...model, ...(port ? { port } : {}) }, this.at, id === "ollama" ? await this.linuxService() : "none");
    if (plan.instead) return { started: false, message: plan.instead };
    for (const command of plan.commands) await this.run(command[0]!, command.slice(1), { timeout: 60000, windowsHide: true });
    if (plan.serve) {
      this.stop(id);
      this.started.set(id, Object.assign(this.spawner(plan.serve[0]!, plan.serve.slice(1)), port ? { port } : {}));
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
