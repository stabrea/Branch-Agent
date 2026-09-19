import { replaceText } from "./text-replace.js";
import { codeRunSettings } from "./code-run.js";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { WorkspaceFiles } from "./files.js";
import { CodeEditor, type ChangeSummary, type PlannedChange } from "./code-edit.js";
import { fileList, patchFileList, patchTargets } from "./patch.js";
import { ShellProcess } from "./integrations/shell-process.js";
import { netlessEnvironment } from "./integrations/shell-config.js";
import { runAsNode } from "./child-env.js";
import { defaultJobObjects, jobWithin, type JobObjects } from "./integrations/job-object.js";
import { ApprovalRequiredError } from "./approvals.js";
import { projectTestsLabel, projectTestsQuestion, projectTestsTool, type TestsVerdict } from "./coding/project-tests.js";

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
  /** Empty means "add `replace` to the end", as in files.edit; the file must already exist here. */
  find: z.string().max(32768),
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
  /**
   * Where a way back to before a change set is kept, when the folder is a repository. Set by the
   * app; left alone, changes are written exactly as they were before this existed.
   */
  checkpoints: { before(folder: string, label: string, signal: AbortSignal): Promise<{ id: string } | null> } | undefined;
  /**
   * mac7/coding-next: whether this folder's own tests may run for this call — the person's answer to
   * "Let Branch run this project's tests?" (src/coding/project-tests.ts). Set by the app; left alone,
   * the tests run only with the script switch on, exactly as before.
   */
  testsPermission: ((context: ToolContext, folder: string) => TestsVerdict) | undefined;
  /** Applies a unified diff to the workspace, all of it or none of it. */
  async patch(input: z.infer<typeof PatchInputSchema>, context: ToolContext) {
    const planned = await this.editor.planPatch(input.patch);
    await this.refuseBinary(planned);
    const settled = await this.settle(planned, input.dryRun, context, true);
    // A patch going in is its own moment, apart from a file changing and a tool finishing, so a
    // hook can be set to fire on exactly that (issue #55, workflow-hooks).
    if (settled.applied) this.editor.notifyPatched(settled.files, context);
    return settled;
  }
  /** Applies several exact text replacements across files, all of them or none of them. */
  async changeSet(input: z.infer<typeof ChangeSetInputSchema>, context: ToolContext) {
    if (new Set(input.edits.map((edit) => edit.path)).size !== input.edits.length)
      throw new Error("Change refused: name each file once; put several replacements for one file in one patch instead.");
    // mac7/coding-next: "read it first" comes before "that text is not in the file", which it explains.
    if (!input.dryRun) await this.editor.mustHaveRead(input.edits.map((edit) => edit.path), context);
    const planned: PlannedChange[] = [];
    for (const edit of input.edits) planned.push(await this.planEdit(edit));
    await this.refuseBinary(planned);
    return { reason: input.reason, ...(await this.settle(planned, input.dryRun, context, true)) };
  }
  /**
   * A set of whole-file replacements that was worked out somewhere else — a language server's
   * rename, for instance — put through exactly the same gate as a change set the model wrote: the
   * files are checked, the person sees the change, it is written all at once or not at all, every
   * file keeps its previous bytes, and the project's check runs afterwards. hardening-3: and, with
   * the read-before-edit switch on, every existing file it changes must have been read first, as for
   * any other editing tool.
   */
  async applyPlanned(reason: string, planned: PlannedChange[], dryRun: boolean, context: ToolContext) {
    if (!planned.length) throw new Error("Change refused: there is nothing to change");
    for (const item of planned) await this.files.checked(item.path);
    await this.refuseBinary(planned);
    return { reason, ...(await this.settle(planned, dryRun, context, true)) };
  }
  private async planEdit(edit: z.infer<typeof editShape>): Promise<PlannedChange> {
    const absolute = await this.files.checked(edit.path);
    const before = await readFile(absolute, "utf8").catch(() => null);
    if (before === null) throw new Error(`Change refused: "${edit.path}" does not exist, so nothing was changed`);
    const { after } = replaceText(before, edit.find, edit.replace, edit.expectedOccurrences, `Change refused (nothing was changed): "${edit.path}"`);
    return { path: edit.path, before, after };
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
  private async settle(planned: PlannedChange[], dryRun: boolean, context: ToolContext, readFirst = false) {
    if (dryRun)
      return { applied: false, dryRun: true, files: this.editor.preview(planned),
        note: "Nothing was written. Send the same change again without dryRun to apply it." };
    // Batch 26 (wave 8): before anything is written, a way back. When the folder is kept in Git a
    // real commit is made of how it is right now, on a ref of Branch's own, and the inspector can
    // put it back. A folder that is not kept in Git simply has no mark, and is told so.
    const mark = await this.checkpoints?.before(this.workspace, fileList(planned.map((item) => item.path)), context.signal)
      .catch(() => null) ?? null;
    const files = await this.editor.writeAll(planned, context, { readFirst });
    const check = await this.runCheck(context);
    if (context.runId) this.store.event(context.runId, "code.changed", { files: files.map((f) => f.path), check: check.ran ? check.ok : null, undo: mark?.id ?? "" });
    return { applied: true, dryRun: false, files, check,
      undo: mark ? { id: mark.id, note: "Ask to undo this, and the files go back to how they were just before." }
        : { id: "", note: "This folder is not kept in Git, so there is no way back to before the change." } };
  }
  /**
   * Runs the project's own check and reports it; a check that fails is news, not a failure. With no
   * check set up, a Node project's own tests (`node --test`, with this app's Node) stand in — but
   * only when the model asks for the check itself (`code.check`, a code.execute tool) and the owner
   * has switched script running on, since that runs the project's code too. After a patch or a
   * change set (files.write tools) only the owner's own configured check runs: writing a file must
   * never become running it. The stand-in reaches the internet only when scripts may.
   */
  async runCheck(context: ToolContext, options: { projectTests?: boolean } = {}): Promise<CheckOutcome> {
    const setting = projectCheck(this.store, this.owner);
    const scripts = codeRunSettings(this.store, this.owner);
    const configured = setting.enabled && !!setting.command;
    const nodeTests = !configured && options.projectTests === true
      && await stat(join(this.workspace, "package.json")).then((info) => info.isFile(), () => false);
    if (!configured && !nodeTests) return { ran: false, ok: true, note: noCheckNote(scripts.enabled) };
    const refused = nodeTests && !scripts.enabled ? this.testsRefusal(context) : null;
    if (refused) return { ran: false, ok: true, note: refused };
    const command = configured
      ? { executable: setting.command, args: setting.args, timeoutMs: setting.timeoutMs, env: {} }
      : { executable: process.execPath, args: ["--test"], timeoutMs: 60000, env: {
        // Inside the desktop app this program is the app itself; this makes it run as plain Node.
        ...runAsNode(process.execPath),
        ...(scripts.network ? {} : netlessEnvironment()) } };
    const job = await jobWithin(this.jobs, { maxMemoryMb: 2048, maxCpuSeconds: 120 }, 1500);
    const result = await new ShellProcess({
      executable: command.executable, args: command.args, cwd: this.workspace,
      env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", TEMP: process.env.TEMP ?? "", ...command.env },
      signal: context.signal, timeoutMs: command.timeoutMs, maxOutputBytes: 8192,
      maxMemoryMb: 2048, maxCpuSeconds: 120, ...(job ? { job } : {}),
    }).run();
    const ok = result.status === "completed";
    const output = `${result.stdout}${result.stderr}`.slice(0, 4000);
    if (context.runId) this.store.event(context.runId, "code.check", { ok, status: result.status, exitCode: result.exitCode });
    const what = configured ? "The project's check" : "The project's tests (node --test)";
    return { ran: true, ok, exitCode: result.exitCode, output,
      note: ok ? `${what} passed.` : `${what} did not pass (${result.status}). Read the output and put it right.` };
  }
  /**
   * mac7/coding-next: with the script switch off, a folder's own tests run only once the person has
   * said yes. Not asked yet: the task stops on "Let Branch run this project's tests?" (thrown, so the
   * runtime puts it the way it puts every question). Refused: the sentence the model is told instead.
   */
  private testsRefusal(context: ToolContext): string | null {
    const verdict = this.testsPermission?.(context, this.workspace) ?? { refuse: noCheckNote(false) };
    if (verdict === "run") return null;
    // A tool run by hand ("Try a tool") has nowhere to put the question, so it is told as before.
    if (verdict === "ask" && !context.askable && !context.approvalKey) return noCheckNote(false);
    // "never": a plain yes with no choice made (the terminal's y, carrying a workflow on) is Once.
    if (verdict === "ask")
      throw new ApprovalRequiredError(projectTestsTool, this.workspace, projectTestsLabel, "never", undefined,
        { question: projectTestsQuestion(this.workspace), kind: "project-tests" });
    return verdict.refuse;
  }
}

/**
 * What the model is told when there is no check to run. "No check is set up" on its own was read by
 * a small model as "this task cannot be done" and it stopped (docs/agents/coding-bench.md); the
 * sentence now says what it can still do.
 */
export function noCheckNote(scriptsOn: boolean): string {
  return "No check is set up for this project, so its tests cannot be run with this tool. That does not block the task: "
    + "read the test files and the source with files.read, work out what the tests expect, and make the change"
    + (scriptsOn ? ", or run a test file yourself with code.run." : ".");
}


export function registerCodeChanges(registry: ToolRegistry, changes: CodeChanges): void {
  registry.register({
    name: "code.patch", permission: "files.write", group: "code",
    description: "Apply a unified diff (or *** Begin Patch block) across workspace files; parts are placed by their lines even when line numbers are off, and if any part's lines are missing nothing is written. Set dryRun to see the whole change first without writing it. Binary files and anything outside the workspace are refused, and each file changed can be put back from its history.",
    parameters: PatchInputSchema,
    target: (args) => (args.dryRun ? "" : patchFileList(args.patch)),
    // mac7/multi-target: every file the patch names, read the way it will be applied; a dry run reads them.
    targets: (args) => patchTargets(args.patch, args.dryRun),
    execute: (args, context) => changes.patch(args, context),
  });
  registry.register({
    name: "code.change_set", permission: "files.write", group: "code",
    description: "Change several files in one go: each entry replaces an exact piece of text in one file. The person is asked once, for the whole set, and sees which files it touches. All the files change or none of them do, and the project's check runs afterwards.",
    parameters: ChangeSetInputSchema,
    target: (args) => (args.dryRun ? "" : fileList(args.edits.map((edit) => edit.path))),
    // mac7/multi-target: every file in the set; a dry run only reads them.
    targets: (args) => args.edits.map((edit) => ({ kind: args.dryRun ? "read" as const : "write" as const, path: edit.path })),
    execute: (args, context) => changes.changeSet(args, context),
  });
  registry.register({
    name: "code.check", permission: "code.execute", group: "code",
    description: "Run the check the owner set up for this project (their tests or their linter) and report what it said. A check that does not pass comes back as something to read, not as a failure.",
    parameters: z.object({}).strict(),
    execute: (_args, context) => changes.runCheck(context, { projectTests: true }),
  });
}
