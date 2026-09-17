import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import { defaultShellFor, type ShellConfig } from "../integrations/shell-config.js";
import { findLeaks } from "../leak-guard.js";
import type { Store } from "../store.js";
import type { ProgramRunner } from "./runner.js";
import { codingOn, partSettings, requireCoding, savePartSettings } from "./settings.js";

/**
 * R17-034: the owner's own command-line setup. Branch starts its commands with a short, clean
 * environment, so a program the owner installed with Homebrew, pyenv or nvm was often "not found".
 * With this part on, the owner can take a snapshot: their login shell is started once, reads its own
 * start-up files, and prints its PATH, its aliases and its functions. Anything that looks like a key
 * or password is dropped before it is kept, and from then on commands use that PATH; the aliases and
 * functions are kept in a file a kept-open command line can read.
 *
 * The capture scripts (start-up files first, then `functions`/`declare -f`, `alias -L`/`alias -p`,
 * and `env -0`, split by NUL marks) follow Codex's shell snapshot (Apache-2.0,
 * `codex-rs/shell-command/src/shell_snapshot_capture.rs`, `startup.rs`); the filtering is Branch's.
 */
export const SnapshotSettingsSchema = z.object({
  /** The shell to read; the owner's own login shell when empty. */
  shell: z.string().max(500).refine((value) => value === "" || isAbsolute(value), "Give the shell's full address").default(""),
  snapshot: z.object({
    shell: z.string(), takenAt: z.string(), path: z.array(z.string()).max(200),
    env: z.record(z.string(), z.string()), aliases: z.string(), functions: z.string(), dropped: z.array(z.string()).max(400),
  }).strict().nullable().default(null),
}).strict();
export type ShellSnapshot = NonNullable<z.infer<typeof SnapshotSettingsSchema>["snapshot"]>;

const shells = /^(zsh|bash|sh|dash|ksh)$/;
const credentialName = /(KEY|TOKEN|SECRET|PASS(WORD|WD)?|CREDENTIAL|AUTH|SESSION|COOKIE|PRIVATE|SIGNATURE|CERT)/i;
/** Variables worth carrying besides PATH: where tools are installed, never anything that signs in. */
const keptName = /^(LANG|LC_[A-Z]+|[A-Z][A-Z0-9_]*_(HOME|ROOT|PREFIX|DIR)|GOPATH|GOBIN|PYTHONPATH|MANPATH|INFOPATH)$/;
const part = (name: string): string => `\u0000__BRANCH_${name}__\u0000`;

const startup: Record<string, string> = {
  zsh: 'if [[ -n "${ZDOTDIR-}" ]]; then rc="$ZDOTDIR/.zshrc"; elif [[ -n "${HOME-}" ]]; then rc="$HOME/.zshrc"; else rc=; fi\n[[ -r "$rc" ]] && . "$rc"\n',
  bash: 'if [ -n "${HOME-}" ] && [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\n',
};

/** The script the shell runs: its start-up files, then each part after a NUL mark. */
export function captureScript(shellName: string): string {
  const functions = shellName === "zsh" ? "functions" : shellName === "bash" ? "declare -f" : "typeset -f 2>/dev/null || true";
  const aliases = shellName === "zsh" ? "alias -L" : shellName === "bash" ? "alias -p" : "alias 2>/dev/null || true";
  const mark = (name: string) => `printf '\\0__BRANCH_${name}__\\0'`;
  return `${startup[shellName] ?? ""}${mark("functions")}\n${functions}\n${mark("aliases")}\n${aliases}\n${mark("env")}\nenv -0\n${mark("end")}\n`;
}

/** The shell a snapshot reads: the one named, else the owner's login shell if it is a known one, else the usual one. */
export function snapshotShell(named: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "win32") throw new Error("A shell snapshot is for macOS and Linux. Windows commands keep their own settings.");
  const chosen = named || env.SHELL || "";
  if (chosen && isAbsolute(chosen) && shells.test(basename(chosen))) return chosen;
  if (named) throw new Error("That is not a shell Branch can read (zsh, bash, sh, dash or ksh).");
  return defaultShellFor(platform, env).path;
}

function between(output: string, name: string, next: string): string {
  const start = output.indexOf(part(name)), end = output.indexOf(part(next));
  return start < 0 || end < start ? "" : output.slice(start + part(name).length, end);
}

const risky = (text: string): boolean =>
  credentialName.test(text.match(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)?.join(" ") ?? "") || findLeaks(text).length > 0;

/** Splits alias lines or function bodies into blocks and keeps only those that carry no secret. */
function safeBlocks(text: string, splitter: RegExp, dropped: string[], label: string): string {
  const blocks = text.split(splitter).map((block) => block.trim()).filter(Boolean);
  const kept = blocks.filter((block) => {
    if (!risky(block)) return true;
    dropped.push(`${label} ${block.replace(/^(alias|function)\s+/, "").split(/[\s=(]/)[0] || "?"}`);
    return false;
  });
  return kept.join("\n").slice(0, 65536);
}

/** What the shell printed, filtered: PATH and install folders kept, anything key-like dropped. */
export function parseCapture(output: string, shell: string, now: Date): ShellSnapshot {
  const dropped: string[] = [];
  const env: Record<string, string> = {};
  let path: string[] = [];
  for (const entry of between(output, "env", "end").replace(/^\n/, "").split("\u0000")) {
    const at = entry.indexOf("=");
    if (at <= 0) continue;
    const name = entry.slice(0, at), value = entry.slice(at + 1);
    if (name === "PATH") { path = [...new Set(value.split(":").filter((dir) => isAbsolute(dir)))].slice(0, 200); continue; }
    if (!keptName.test(name)) continue;
    if (credentialName.test(name) || findLeaks(value).length > 0 || /[\n\0]/.test(value)) { dropped.push(`variable ${name}`); continue; }
    env[name] = value;
  }
  const aliases = safeBlocks(between(output, "aliases", "env"), /\n(?=\S)/, dropped, "alias");
  const functions = safeBlocks(between(output, "functions", "aliases"), /\n(?=[A-Za-z_][\w:-]*\s*\(\)|function\s)/, dropped, "function");
  return { shell, takenAt: now.toISOString(), path, env, aliases, functions, dropped };
}

export interface SnapshotDeps { runner: ProgramRunner; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string; now?: () => Date }

export class ShellSnapshots {
  constructor(private readonly store: Store, private readonly owner: string, private readonly deps: SnapshotDeps) {}

  settings() { return partSettings(this.store, this.owner, "shell-snapshot", SnapshotSettingsSchema); }

  chooseShell(input: unknown) {
    const { shell } = z.object({ shell: z.string().max(500) }).strict().parse(input);
    snapshotShell(shell, this.deps.env, this.deps.platform);
    return savePartSettings(this.store, this.owner, "shell-snapshot", SnapshotSettingsSchema, { ...this.settings(), shell });
  }

  /** Starts the login shell once and keeps what it printed, filtered. */
  async take(): Promise<ShellSnapshot> {
    requireCoding(this.store, this.owner, "shell-snapshot");
    const shell = snapshotShell(this.settings().shell, this.deps.env, this.deps.platform);
    const name = basename(shell);
    const result = await this.deps.runner({ executable: shell, args: ["-l", "-c", captureScript(name)], cwd: this.deps.home,
      timeoutMs: 15_000, env: { HOME: this.deps.home, SHELL: shell, TERM: "dumb" }, maxOutputBytes: 2_000_000 });
    if (result.timedOut) throw new Error("Your shell took longer than 15 seconds to start, so no snapshot was taken.");
    if (!result.stdout.includes(part("end"))) throw new Error("Your shell did not finish reading its start-up files, so no snapshot was taken.");
    const snapshot = parseCapture(result.stdout, shell, (this.deps.now ?? (() => new Date()))());
    savePartSettings(this.store, this.owner, "shell-snapshot", SnapshotSettingsSchema, { ...this.settings(), snapshot });
    this.writeReplay(snapshot);
    return snapshot;
  }

  forget(): void {
    savePartSettings(this.store, this.owner, "shell-snapshot", SnapshotSettingsSchema, { ...this.settings(), snapshot: null });
  }

  /** The file a kept-open command line can read: aliases cleared, the functions, the aliases, the PATH. */
  replayFile(): string { return join(this.store.folder, "shell-snapshot", "replay.sh"); }
  private writeReplay(snapshot: ShellSnapshot): void {
    const folder = join(this.store.folder, "shell-snapshot");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const quoted = snapshot.path.map((dir) => dir.replace(/'/g, `'\\''`)).join(":");
    writeFileSync(this.replayFile(), `# Taken ${snapshot.takenAt} from ${snapshot.shell}; secrets were left out.\nunalias -a 2>/dev/null || true\n${snapshot.functions}\n${snapshot.aliases}\nexport PATH='${quoted}'\n`, { mode: 0o600 });
    chmodSync(this.replayFile(), 0o600);
  }
}

/**
 * The shell settings commands start with: the snapshot's PATH, unless the part is off, there is no
 * snapshot, or the owner already wrote a PATH of their own into the shell settings.
 */
export function withLoginPath(config: ShellConfig, store: Pick<Store, "get">, owner: string): ShellConfig {
  if (!codingOn(store, owner, "shell-snapshot") || config.env.PATH !== undefined) return config;
  const snapshot = partSettings(store, owner, "shell-snapshot", SnapshotSettingsSchema).snapshot;
  if (!snapshot?.path.length) return config;
  return { ...config, env: { ...config.env, PATH: snapshot.path.join(":") } };
}
