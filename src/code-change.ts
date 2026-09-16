import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { WorkspaceFiles } from "./files.js";
import { CodeEditor, type ChangeSummary, type PlannedChange } from "./code-edit.js";
import { ShellProcess } from "./integrations/shell-process.js";
import { defaultJobObjects, jobWithin, type JobObjects } from "./integrations/job-object.js";

/**
 * Changing several files at once, safely. A patch or a change set is worked out in full first, so
 * the owner can look at it before anything is written; then every file is written or none is, and
 * each one is kept in the file history so a single change can be put back. Afterwards the app can
 * run the check the owner set up for this project (their tests or their linter) and hand the result
 * straight back to the assistant, so it sees what its own change broke in the very next step.
 */
export const ProjectCheckSchema = z.object({
  /** Run the check after a patch or a change set has been written. */
  enabled: z.boolean().default(false),
  /** The program to run, given in full. A .cmd or .bat wrapper is refused; name the real program. */
  command: z.string().max(1000).default(""),
  args: z.array(z.string().max(500).refine((value) => !value.includes("\0"), "NUL is not permitted")).max(20).default([]),
  timeoutMs: z.number().int().min(1000).max(120000).default(60000),
}).strict();
export type ProjectCheck = z.infer<typeof ProjectCheckSchema>;
export interface CheckOutcome { ran: boolean; ok: boolean; note: string; exitCode?: number | null; output?: string }

export function projectCheck(store: Store, owner: string): ProjectCheck {
  const parsed = ProjectCheckSchema.safeParse(store.get("settings", owner, "code-check")?.data ?? {});
  return parsed.success ? parsed.data : ProjectCheckSchema.parse({});
}
/** Saves the check, refusing a program that is not there or is a wrapper script. */
export async function saveProjectCheck(store: Store, owner: string, input: unknown): Promise<ProjectCheck> {
  const value = ProjectCheckSchema.parse(input ?? {});
  if (value.enabled) {
    if (!value.command || !isAbsolute(value.command)) throw new Error("Give the check program in full, starting from the drive.");
    if (/\.(cmd|bat)$/i.test(value.command)) throw new Error("Name the real program, not a .cmd or .bat wrapper.");
    if (!(await stat(value.command).catch(() => null))?.isFile()) throw new Error("There is no program at that address.");
  }
  store.save("settings", owner, "code-check", { ...value });
  return value;
}

/** The first bytes of a file say whether it is text; a NUL byte means it is not. */
async function looksBinary(absolute: string): Promise<boolean> {
  const handle = await readFile(absolute).catch(() => null);
  return handle === null ? false : handle.subarray(0, 8000).includes(0);
}

export const PatchInputSchema = z.object({
  patch: z.string().min(1).max(131072),
  /** Work out the change and show it without writing anything. */
  dryRun: z.boolean().default(false),
}).strict();
const editShape = z.object({
  path: z.string().min(1).max(500),
  find: z.string().min(1).max(32768),
  replace: z.string().max(32768),
  expectedOccurrences: z.number().int().min(1).max(100).default(1),
}).strict();
export const ChangeSetInputSchema = z.object({
  /** One line saying what the whole set of changes is for; the person sees it when they are asked. */
  reason: z.string().trim().min(1).max(200),
  edits: z.array(editShape).min(1).max(20),
  dryRun: z.boolean().default(false),
}).strict();

export class CodeChanges {
  constructor(
    private readonly store: Store,
    private readonly owner: string,
    private readonly files: WorkspaceFiles,
    private readonly editor: CodeEditor,
    private readonly workspace: string,
    private readonly jobs: JobObjects = defaultJobObjects(),
  ) {}
  /** Applies a unified diff to the workspace, all of it or none of it. */
  async patch(input: z.infer<typeof PatchInputSchema>, context: ToolContext) {
    const planned = await this.editor.planPatch(input.patch);
    await this.refuseBinary(planned);
    return this.settle(planned, input.dryRun, context);
  }
  /** Applies several exact text replacements across files, all of them or none of them. */
  async changeSet(input: z.infer<typeof ChangeSetInputSchema>, context: ToolContext) {
    if (new Set(input.edits.map((edit) => edit.path)).size !== input.edits.length)
      throw new Error("Change refused: name each file once; put several replacements for one file in one patch instead.");
    const planned: PlannedChange[] = [];
    for (const edit of input.edits) planned.push(await this.planEdit(edit));
    await this.refuseBinary(planned);
    return { reason: input.reason, ...(await this.settle(planned, input.dryRun, context)) };
  }
  private async planEdit(edit: z.infer<typeof editShape>): Promise<PlannedChange> {
    const absolute = await this.files.checked(edit.path);
    const before = await readFile(absolute, "utf8").catch(() => null);
    if (before === null) throw new Error(`Change refused: "${edit.path}" does not exist, so nothing was changed`);
    const found = before.split(edit.find).length - 1;
    if (found !== edit.expectedOccurrences)
      throw new Error(`Change refused: "${edit.path}" contains that text ${found} time(s), but ${edit.expectedOccurrences} was expected; nothing was changed`);
    return { path: edit.path, before, after: before.split(edit.find).join(edit.replace) };
  }
  private async refuseBinary(planned: PlannedChange[]): Promise<void> {
    for (const item of planned) {
      if (item.before === null) continue;
      const absolute = await this.files.checked(item.path);
      if (await looksBinary(absolute))
        throw new Error(`Change refused: "${item.path}" is not a text file; nothing was changed`);
    }
  }
  /** Shows the change, or writes it and runs the owner's check afterwards. */
  private async settle(planned: PlannedChange[], dryRun: boolean, context: ToolContext) {
    if (dryRun)
      return { applied: false, dryRun: true, files: this.editor.preview(planned),
        note: "Nothing was written. Send the same change again without dryRun to apply it." };
    const files = await this.editor.writeAll(planned, context);
    const check = await this.runCheck(context);
    if (context.runId) this.store.event(context.runId, "code.changed", { files: files.map((f) => f.path), check: check.ran ? check.ok : null });
    return { applied: true, dryRun: false, files, check };
  }
  /** Runs the project's own check and reports it; a check that fails is news, not a failure. */
  async runCheck(context: ToolContext): Promise<CheckOutcome> {
    const setting = projectCheck(this.store, this.owner);
    if (!setting.enabled || !setting.command) return { ran: false, ok: true, note: "No check is set up for this project." };
    const job = await jobWithin(this.jobs, { maxMemoryMb: 2048, maxCpuSeconds: 120 }, 1500);
    const result = await new ShellProcess({
      executable: setting.command, args: setting.args, cwd: this.workspace,
      env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", TEMP: process.env.TEMP ?? "" },
      signal: context.signal, timeoutMs: setting.timeoutMs, maxOutputBytes: 8192,
      maxMemoryMb: 2048, maxCpuSeconds: 120, ...(job ? { job } : {}),
    }).run();
    const ok = result.status === "completed";
    const output = `${result.stdout}${result.stderr}`.slice(0, 4000);
    if (context.runId) this.store.event(context.runId, "code.check", { ok, status: result.status, exitCode: result.exitCode });
    return { ran: true, ok, exitCode: result.exitCode, output,
      note: ok ? "The project's check passed after the change." : `The project's check did not pass after the change (${result.status}). Read the output and put it right.` };
  }
}

const fileList = (paths: string[]): string =>
  `${paths.length} file${paths.length === 1 ? "" : "s"}: ${paths.slice(0, 7).join(", ")}${paths.length > 7 ? ", …" : ""}`;

export function registerCodeChanges(registry: ToolRegistry, changes: CodeChanges): void {
  registry.register({
    name: "code.patch", permission: "files.write", group: "code",
    description: "Apply a unified diff across workspace files. Every part must fit exactly; if one does not, nothing at all is written. Set dryRun to see the whole change first without writing it. Binary files and anything outside the workspace are refused, and each file changed can be put back from its history.",
    parameters: PatchInputSchema,
    target: (args) => {
      const paths = [...String(args.patch).matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)].map((m) => m[1]!);
      return args.dryRun ? "" : fileList(paths);
    },
    execute: (args, context) => changes.patch(args, context),
  });
  registry.register({
    name: "code.change_set", permission: "files.write", group: "code",
    description: "Change several files in one go: each entry replaces an exact piece of text in one file. The person is asked once, for the whole set, and sees which files it touches. All the files change or none of them do, and the project's check runs afterwards.",
    parameters: ChangeSetInputSchema,
    target: (args) => (args.dryRun ? "" : fileList(args.edits.map((edit) => edit.path))),
    execute: (args, context) => changes.changeSet(args, context),
  });
  registry.register({
    name: "code.check", permission: "code.execute", group: "code",
    description: "Run the check the owner set up for this project (their tests or their linter) and report what it said. A check that does not pass comes back as something to read, not as a failure.",
    parameters: z.object({}).strict(),
    execute: (_args, context) => changes.runCheck(context),
  });
}
