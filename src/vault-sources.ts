import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";
import { z } from "zod";
import { audit } from "./audit.js";
import type { Store } from "./store.js";
import { mapStrings, type ReferenceFiller, type SecretScrubber } from "./vault.js";
import type { CliOutcome, CliRunner } from "./credential-cli.js";

export type { CliOutcome, CliRunner };

/**
 * Where a saved password or key can come from, written down as one contract.
 *
 * Branch has grown several of these — its own locker, the environment a program is started with, a
 * file on disk, the owner's password manager, and now a command of their own. Until now each knew
 * about the others. This file says what they all have in common instead: a scheme (the part after
 * `secret://`), a plain-language label for the settings screen, and one method that turns a
 * reference into a value at the moment it is needed and nowhere earlier.
 *
 * Every source follows the same three rules, whatever it reads from:
 *   - nothing is looked up until the value is about to be handed over;
 *   - every look-up is remembered by the scrubber, so the value is taken back out of results,
 *     events, receipts and error messages;
 *   - every look-up is written into the record of what the assistant was allowed to do.
 */
export interface SecretProvider {
  /** The part after `secret://`: a project name for the locker, "cmd" for a command of the owner's. */
  readonly scheme: string;
  /** What to call it on the settings screen, in the owner's words. */
  readonly label: string;
  /** What it reads from, in one sentence. */
  readonly description: string;
  /** Whether the owner has switched this source on. A source that is off refuses, plainly. */
  available(): boolean;
  /** The value for one reference. Throws a plain sentence when it cannot hand one over. */
  read(reference: string, use: SecretUseNote): Promise<string>;
}
export interface SecretUseNote { runId?: string | undefined; purpose: string }

/** The sources Branch can read from, for the settings screen and the documentation. */
export function secretProviderContract(): { scheme: string; label: string; description: string }[] {
  return [
    { scheme: "<project>", label: "Branch's own locker", description: "A password or key you saved in Branch, kept encrypted on this computer." },
    { scheme: "cmd", label: "A command of yours", description: "A program you named in Settings that prints the password. Branch may run only the ones you listed." },
    { scheme: "bitwarden", label: "Bitwarden", description: "Read straight out of your Bitwarden vault through its own command line, when you have turned that on." },
    { scheme: "1password", label: "1Password", description: "Read straight out of your 1Password vault through its own command line, when you have turned that on." },
    { scheme: "env", label: "The program's own environment", description: "A value already in the environment a program is started with; Branch stores nothing." },
    { scheme: "file", label: "A file on this computer", description: "A value read out of a file you pointed at, for setups that already work that way." },
  ];
}

/* ----------------------------------------------- a command of the owner's own */

const commandName = z.string().trim().regex(/^[a-z][a-z0-9-]{0,39}$/, "A command's name is lower-case letters, digits and dashes");
export const SecretCommandSchema = z.object({
  /** The name used in a reference: `secret://cmd/<name>`. */
  name: commandName,
  /** The program to run. Never anything the model or a tool supplied; only what the owner typed. */
  command: z.string().trim().min(1).max(500),
  /** Fixed words after the program. These too are the owner's, and nothing is added to them. */
  args: z.array(z.string().max(200)).max(20).default([]),
  /** What it is for, so a list of these means something a year later. */
  note: z.string().trim().max(200).default(""),
}).strict();
export type SecretCommand = z.infer<typeof SecretCommandSchema>;

export const SecretCommandSettingsSchema = z.object({
  /** "Let Branch run my own command to fetch a password". Off until the owner turns it on. */
  enabled: z.boolean().default(false),
  commands: z.array(SecretCommandSchema).max(20).default([]),
  timeoutMs: z.number().int().min(500).max(30000).default(10000),
}).strict();
export type SecretCommandSettings = z.infer<typeof SecretCommandSettingsSchema>;
const settingsKey = "secret-commands";

export function readSecretCommandSettings(store: Store, owner: string): SecretCommandSettings {
  const saved = SecretCommandSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : SecretCommandSettingsSchema.parse({});
}
export function saveSecretCommandSettings(store: Store, owner: string, input: unknown): SecretCommandSettings {
  const next = SecretCommandSettingsSchema.parse({ ...readSecretCommandSettings(store, owner), ...(input as object ?? {}) });
  if (new Set(next.commands.map((one) => one.name)).size !== next.commands.length)
    throw new Error("Two of those commands have the same name");
  store.save("settings", owner, settingsKey, next);
  audit(store, owner, {
    action: "policy.changed", actor: owner, subject: "the commands that may fetch a password",
    reason: next.enabled ? `${next.commands.length} command(s) may be run` : "Turned off", outcome: "saved",
  });
  return next;
}

const referenceText = "secret://cmd/([a-z][a-z0-9-]{0,39})";
const anyCommandReference = new RegExp(referenceText, "g");
const wholeCommandReference = new RegExp(`^${referenceText}$`);
/** The reference text for one named command, for settings screens and documentation. */
export const commandReference = (name: string): string => `secret://cmd/${name}`;
export function parseCommandReference(value: unknown): string | null {
  const match = typeof value === "string" ? wholeCommandReference.exec(value) : null;
  return match ? match[1]! : null;
}
/** Every `secret://cmd/...` reference inside a value, so the runtime knows what to run. */
export function collectCommandReferences(value: unknown): string[] {
  const found = new Set<string>();
  mapStrings(value, (text) => {
    for (const match of text.matchAll(anyCommandReference)) found.add(match[1]!);
    return text;
  });
  return [...found];
}

/** Only what a program needs to find itself; nothing else of the owner's is passed on. */
const passedThrough = ["PATH", "PATHEXT", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "TEMP", "TMP"];
function strippedEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of passedThrough) if (process.env[name]) result[name] = process.env[name];
  return result;
}
/** Where a bare command name lives on this computer, so nothing is ever run through a shell. */
export function locateSecretCommand(name: string): string {
  if (name.includes(sep) || name.includes("/") || isAbsolute(name)) return name;
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const folder of (process.env.PATH ?? "").split(delimiter).filter(Boolean))
    for (const extension of extensions) {
      const candidate = join(folder, name + extension);
      try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
    }
  return name;
}
/** Runs one of the owner's commands directly: no shell, no window, and a hard time limit. */
export const spawnSecretCommand: CliRunner = (executable, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(locateSecretCommand(executable), args,
      { timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 65536, env: strippedEnvironment() },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const missing = failure?.code === "ENOENT";
        const code = typeof failure?.code === "number" ? failure.code : failure ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr), missing });
      });
  });

/** Why a run of one of the owner's commands handed back nothing, in one plain sentence. */
export function secretCommandRefusal(entry: SecretCommand, outcome: CliOutcome): string | null {
  if (outcome.missing)
    return `"${entry.command}" is not on this computer, so Branch cannot run it. Correct the command under Settings, or keep the password in Branch's own locker instead.`;
  if (outcome.code !== 0)
    return `"${entry.command}" did not finish properly, so Branch has nothing to hand over. Run it yourself to see why.`;
  if (!outcome.stdout.trim()) return `"${entry.command}" printed nothing, so there is no password to hand over.`;
  return null;
}

/**
 * Reading a password out of a program the owner already has — a company helper, a hardware key's
 * own tool, a script of theirs. The command itself is never free text: a reference names one of the
 * entries they wrote down in Settings, and anything else is refused before a process is started.
 */
export class CommandSecrets implements SecretProvider, ReferenceFiller {
  readonly scheme = "cmd";
  readonly label = "A command of yours";
  readonly description = "A program you named in Settings that prints the password.";
  /** Set by the session lock: it throws a plain reason when secrets may not be used yet. */
  gate: () => void = () => undefined;
  constructor(
    private readonly store: Store, private readonly owner: string,
    private readonly scrubber: SecretScrubber, private readonly run: CliRunner = spawnSecretCommand,
  ) {}
  settings(): SecretCommandSettings { return readSecretCommandSettings(this.store, this.owner); }
  available(): boolean { return this.settings().enabled; }

  /** Replaces every `secret://cmd/...` reference with what that command printed. */
  async fill<T>(value: T, use: SecretUseNote): Promise<T> {
    const names = collectCommandReferences(value);
    if (!names.length) return value;
    const values = new Map<string, string>();
    for (const name of names) values.set(name, await this.read(commandReference(name), use));
    return mapStrings(value, (text) =>
      text.replace(anyCommandReference, (whole, name: string) => values.get(name) ?? whole));
  }

  /** One password, printed by one of the owner's own commands. */
  async read(reference: string, use: SecretUseNote): Promise<string> {
    this.gate();
    const name = parseCommandReference(reference) ?? reference;
    const settings = this.settings();
    if (!settings.enabled)
      throw new Error("Branch is not set up to run a command of yours to fetch a password. Turn that on in Settings first.");
    const entry = settings.commands.find((one) => one.name === name);
    if (!entry)
      throw new Error(`There is no command called "${name}" in your list. Add it under Settings before using ${commandReference(name)}.`);
    const outcome = await this.run(entry.command, entry.args, settings.timeoutMs);
    const refusal = secretCommandRefusal(entry, outcome);
    if (refusal) { this.record(name, use, "refused"); throw new Error(refusal); }
    const value = outcome.stdout.replace(/\r?\n$/, "");
    this.scrubber.remember(`cmd:${name}`, value);
    this.record(name, use, "handed over");
    return value;
  }

  /** The name of the command only; what it printed never reaches this record. */
  private record(name: string, use: SecretUseNote, outcome: string): void {
    audit(this.store, this.owner, {
      action: "secret.used", actor: "a command of yours", subject: commandReference(name),
      reason: use.purpose.slice(0, 120), runId: use.runId ?? null, outcome,
    });
  }
}
