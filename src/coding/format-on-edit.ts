import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import type { WorkspaceFiles } from "../files.js";
import type { Diagnostic } from "../language-server.js";
import { protectedTarget, type ProtectedAreas } from "../never-break/protected.js";
import { parsePatch } from "../patch.js";
import type { ToolRegistry } from "../registry.js";
import { checkedProgram } from "../stdio-rpc.js";
import type { Store } from "../store.js";
import { runWalled, type ProgramRunner } from "./runner.js";
import { codingOn, partSettings, requireCoding, savePartSettings } from "./settings.js";

/**
 * R17-033: after every change a task makes to a file, the file is tidied with the owner's own
 * formatter for that kind of file, and the mistakes their language server sees in it are added to
 * the answer, so the assistant fixes them in the next step instead of finding out later. This is
 * what OpenCode does in its write tool (MIT, `packages/opencode/src/tool/write.ts`,
 * `format/formatter.ts`, `lsp/diagnostic.ts`); written for Branch.
 *
 * Branch never installs a formatter: the owner names the programs they already have. Each runs from
 * its full address with an argument array and the clean environment, behind the wall around programs
 * when the task has one, and never on one of Branch's own files.
 */
const alias = z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/);
const argument = z.string().max(500).refine((value) => !value.includes("\0"), "NUL is not permitted");
export const FormatSettingsSchema = z.object({
  formatters: z.record(alias, z.object({
    /** The program's full address, such as /opt/homebrew/bin/prettier. */
    path: z.string().min(1).max(1000),
    /** Its arguments; `{file}` stands for the file to tidy. */
    args: z.array(argument).max(20).default(["{file}"]),
    /** The endings it tidies, such as [".ts", ".tsx"]. */
    extensions: z.array(z.string().regex(/^\.[A-Za-z0-9]{1,10}$/)).min(1).max(20),
  }).strict()).refine((value) => Object.keys(value).length <= 16, "At most 16 formatters").default({}),
  /** Ask the owner's language servers (Settings, Developer) about each changed file. */
  diagnostics: z.boolean().default(true),
  /** How long a language server is given to look at a changed file. */
  waitMs: z.number().int().min(0).max(10_000).default(1500),
  timeoutMs: z.number().int().min(1000).max(60_000).default(20_000),
}).strict();
export type FormatSettings = z.infer<typeof FormatSettingsSchema>;

export const editTools = ["files.write", "files.edit", "files.patch"] as const;
const maxFilesPerEdit = 10;

export interface DiagnosticsSource {
  diagnostics(input: { path: string; waitMs: number }, runId: string): Promise<{ diagnostics: Diagnostic[] }>;
  enabled(): boolean;
}
export interface FormatDeps {
  store: Store; owner: string; files: WorkspaceFiles; runner: ProgramRunner;
  areas: () => ProtectedAreas; servers: DiagnosticsSource;
}
export interface FileCheck { path: string; formatter: string | null; reformatted: boolean; note?: string; problems?: { line: number; severity: string; message: string }[] }

/** The workspace paths an edit tool changed, from its own arguments. */
export function editedPaths(tool: string, args: unknown): string[] {
  if (!(editTools as readonly string[]).includes(tool)) return [];
  const input = (args ?? {}) as { path?: unknown; patch?: unknown };
  if (typeof input.path === "string") return [input.path];
  if (typeof input.patch !== "string") return [];
  try { return [...new Set(parsePatch(input.patch).map((file) => file.path))].slice(0, maxFilesPerEdit); } catch { return []; }
}

const digest = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");

export class EditChecks {
  constructor(private readonly deps: FormatDeps) {}

  requireOn(): void { requireCoding(this.deps.store, this.deps.owner, "format-on-edit"); }

  settings(): FormatSettings { return partSettings(this.deps.store, this.deps.owner, "format-on-edit", FormatSettingsSchema); }

  async save(input: unknown): Promise<FormatSettings> {
    const value = FormatSettingsSchema.parse(input ?? {});
    for (const [name, formatter] of Object.entries(value.formatters)) {
      await checkedProgram(formatter.path).catch((error: Error) => { throw new Error(`${name}: ${error.message}`); });
      if (this.inWorkspace(formatter.path)) throw new Error(`${name}: a formatter inside the workspace could be changed by a task, so name one installed elsewhere.`);
    }
    return savePartSettings(this.deps.store, this.deps.owner, "format-on-edit", FormatSettingsSchema, value);
  }

  /** The registry's after-call look (src/registry.ts): an edit's answer gains what the checks found. */
  async after(tool: string, args: unknown, result: unknown, context: ToolContext): Promise<unknown> {
    if (context.dryRun || !codingOn(this.deps.store, this.deps.owner, "format-on-edit")) return result;
    const paths = editedPaths(tool, args);
    if (!paths.length) return result;
    const checks: FileCheck[] = [];
    for (const path of paths) checks.push(await this.check(path, context).catch((error: Error) => ({ path, formatter: null, reformatted: false, note: error.message.slice(0, 300) })));
    const afterEdit = { files: checks };
    return result && typeof result === "object" && !Array.isArray(result) ? { ...result, afterEdit } : { result, afterEdit };
  }

  /** Tidies one file and asks about it. Never throws for a formatter or server problem; it says so. */
  async check(path: string, context: ToolContext): Promise<FileCheck> {
    const absolute = await this.deps.files.checked(path);
    const refused = protectedTarget({ tool: "files.write", readOnly: false, args: { path }, target: path, workspace: this.deps.files.base }, this.deps.areas());
    if (refused) return { path, formatter: null, reformatted: false, note: "Not tidied: it is one of Branch's own files." };
    const settings = this.settings();
    const found = Object.entries(settings.formatters).find(([, formatter]) => formatter.extensions.includes(extname(path).toLowerCase()));
    const check: FileCheck = { path, formatter: found?.[0] ?? null, reformatted: false };
    if (found) await this.format(found[1], absolute, settings.timeoutMs, context, check);
    if (settings.diagnostics && this.deps.servers.enabled()) {
      const seen = await this.deps.servers.diagnostics({ path, waitMs: settings.waitMs }, context.runId).catch(() => null);
      if (seen) check.problems = seen.diagnostics.filter((d) => d.severity === "error" || d.severity === "warning").slice(0, 20)
        .map((d) => ({ line: d.line, severity: d.severity, message: d.message.slice(0, 300) }));
    }
    return check;
  }

  /** A program a task could rewrite is never started by itself after an edit. */
  private inWorkspace(program: string): boolean {
    const real = (path: string) => { try { return realpathSync.native(path); } catch { return resolve(path); } };
    const rel = relative(real(this.deps.files.root), real(program));
    return !rel.startsWith("..") && !isAbsolute(rel);
  }

  private async format(formatter: FormatSettings["formatters"][string], absolute: string, timeoutMs: number, context: ToolContext, check: FileCheck): Promise<void> {
    if (this.inWorkspace(formatter.path)) { check.note = "Not tidied: the formatter sits inside the workspace."; return; }
    const before = await digest(absolute);
    const result = await runWalled(this.deps.runner, {
      executable: formatter.path, args: formatter.args.map((arg) => arg.replaceAll("{file}", absolute)),
      cwd: this.deps.files.base, timeoutMs, maxOutputBytes: 65_536, signal: context.signal,
    }, context.osSandbox, context.workspace);
    if (result.timedOut) check.note = "The formatter took too long and was stopped.";
    else if (result.exitCode !== 0) check.note = `The formatter said: ${(result.stderr || result.stdout).trim().slice(0, 300) || `exit code ${result.exitCode}`}`;
    check.reformatted = (await digest(absolute)) !== before;
  }
}

export function registerFormat(registry: ToolRegistry, checks: EditChecks): void {
  registry.register({
    name: "code.format", permission: "files.write", group: "code",
    description: "Tidy a file with the owner's formatter for its kind and report the mistakes their language server sees in it. The same happens by itself after every edit while this is on.",
    parameters: z.object({ path: z.string().min(1).max(500) }).strict(),
    execute: async ({ path }, context) => {
      checks.requireOn();
      return checks.check(path, context);
    },
  });
}
