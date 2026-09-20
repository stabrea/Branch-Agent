import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { ToolContext } from "../contracts.js";
import type { WorkspaceFiles } from "../files.js";

/**
 * mac7/speed: reading several files in one call.
 *
 * A model that asks for one file at a time spends a whole round trip on each — and a round trip is
 * 88–94% of a coding task's clock. This changes nothing about what may be read: every path goes
 * through the very same `files.read` as the one-at-a-time tool, so the workspace check, the refusal
 * of `..`, absolute paths, links and secret-looking names, the 32 KiB ceiling and the note the
 * read-before-edit guard keeps all happen per file, exactly as they would have one call at a time.
 *
 * A path that is refused is named with the reason, and the files that were read still come back.
 * Refusing the whole call over one bad path would teach the model nothing about which path was
 * wrong, and it would have to go round again to find out — the opposite of the point.
 */

const pathSchema = z.string().min(1).max(500);
/** At most this many paths in one call, so one reply cannot ask for the whole project. */
export const readManyLimit = 10;
/**
 * How much of the room a tool's answer is allowed this call may use. The rest of the room is left
 * for the wrapper the answer is put in and for the paths themselves, so the whole thing stays under
 * the ceiling and nothing has to be cut off.
 */
export const readManyShareOfRoom = 0.9;

export const ReadManySchema = z.object({
  paths: z.array(pathSchema).min(1).max(readManyLimit),
}).strict();

export interface ReadManyFile {
  path: string;
  content?: string;
  /** Why this one could not be read, in the same words the single-file tool would have used. */
  error?: string;
  /** Set when there was no room left in this answer for it; read it on its own. */
  skipped?: true;
}

export function registerReadMany(registry: ToolRegistry, files: WorkspaceFiles, room: () => number): void {
  registry.register({
    name: "files.read_many",
    permission: "files.read",
    group: "files",
    description:
      `Read several UTF-8 workspace files in one go — up to ${readManyLimit} of them, each at most 32 KiB. `
      + "Use this instead of reading one file at a time: it is the same reading, in one step rather than several. "
      + "A path that cannot be read is named with the reason and the rest still come back. "
      + "If the files together are more than one answer holds, the ones there was no room for come back marked "
      + "\"skipped\" — nothing of theirs is cut short; ask for those on their own.",
    parameters: ReadManySchema,
    // Integration (mac7/speed): the rules must see every path, not the call as a whole. Without
    // these two lines `policyTarget` found no `path` field and judged the call with an empty
    // target, so an owner's rule refusing `files.*` on a folder refused `files.read` of a file in
    // it and let `files.read_many` of the very same file straight through. `target` is what the
    // approval card and a remembered answer are keyed by; `targets` is what the rules judge one by
    // one, and the call goes ahead only when every path is allowed.
    //
    // **One refused path refuses the whole call, and that is on purpose — do not "fix" it back.**
    // Decided by the coordinator, 2026-09-20. It would be friendlier to read the allowed files and
    // hand the refused one back named beside them, the way a file that simply cannot be read comes
    // back (missing, a folder, outside the workspace, secret-looking — those still do). But a
    // partial answer under a *rule* quietly tells the model which refused paths exist, which is the
    // one thing the rule was there to prevent. The owner deciding on every path beats the
    // convenience, and the refusal names the path, so the model can ask again without it.
    target: (input) => (input.paths.length === 1 ? input.paths[0]! : `${input.paths.length} files: ${input.paths.join(", ")}`.slice(0, 300)),
    targets: (input) => input.paths.map((path) => ({ kind: "read" as const, path })),
    execute: async (input, context: ToolContext) => readMany(files, input.paths, context, room()),
  });
}

/**
 * The loop itself, kept out of the registration so it can be tested on its own.
 *
 * `room` is how many characters a tool's answer may be before the task clips it (the owner's
 * `toolAnswerChars`, 12,000 as it ships). Ten files of 32 KiB would be far over that and the end of
 * the answer would simply be cut off — worse than reading them one at a time, and silently. So the
 * files are read until the room runs out and the rest are handed back **named**, as `skipped`, with
 * a line telling the assistant to ask for them on their own. Nothing is ever quietly lost.
 */
export async function readMany(
  files: WorkspaceFiles, paths: readonly string[], context: ToolContext, room: number,
): Promise<{ files: ReadManyFile[]; read: number; refused: number; skipped: number; note?: string }> {
  const out: ReadManyFile[] = [];
  const budget = Math.max(1000, Math.floor(room * readManyShareOfRoom));
  let used = 0;
  for (const path of paths) {
    try {
      const file = await files.read(path);
      // No room left, and this file has not been counted as read: say so rather than cut it short.
      if (used && used + file.content.length > budget) { out.push({ path, skipped: true }); continue; }
      // The same note the one-at-a-time tool leaves, per file, so reading here counts as reading
      // for the read-before-edit guard exactly as it would have done separately.
      files.readFirst?.noteRead(context.runId, files.addressOf(path), file.content);
      used += file.content.length;
      out.push({ path, content: file.content });
    } catch (error) {
      out.push({ path, error: plainly(error, path) });
    }
  }
  const skipped = out.filter((one) => one.skipped).length;
  // Integration (mac7/speed): one file can be bigger than a whole answer on its own. It is always
  // handed back — coming away with nothing would be worse — but the end of it is then cut by the
  // same ceiling that cuts any long result, so the answer says so rather than letting "nothing was
  // cut short" stand when something was.
  const tooBigAlone = used > budget;
  return {
    files: out,
    read: out.filter((one) => one.content !== undefined).length,
    refused: out.filter((one) => one.error !== undefined).length,
    skipped,
    ...(note(skipped, tooBigAlone) ? { note: note(skipped, tooBigAlone) } : {}),
  };
}

/** What to say about the room, when there is anything to say. */
function note(skipped: number, tooBigAlone: boolean): string {
  const about = skipped
    ? `There was not room in one answer for ${skipped} of these. `
      + "Nothing of theirs was cut short — ask for those on their own, or a few at a time."
    : "";
  const big = tooBigAlone
    ? "One of these is longer than a single answer holds, so the end of it was left out. "
      + "Ask for that part of it another way if you need it."
    : "";
  return [about, big].filter(Boolean).join(" ");
}

/**
 * Why one file could not be read, in words a person could read. The refusals the workspace itself
 * gives are already plain sentences and are passed on as they are; a missing file is said plainly
 * rather than as the system's own message, which carries this computer's folders in it.
 */
function plainly(error: unknown, path: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ENOENT")) return `There is no file at ${path}.`;
  if (message.includes("EISDIR")) return `${path} is a folder, not a file.`;
  return message;
}
