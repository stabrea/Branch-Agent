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
      + "\"skipped\" — nothing is cut short; ask for those on their own.",
    parameters: ReadManySchema,
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
  return {
    files: out,
    read: out.filter((one) => one.content !== undefined).length,
    refused: out.filter((one) => one.error !== undefined).length,
    skipped,
    ...(skipped ? { note: `There was not room in one answer for ${skipped} of these. `
      + "Nothing was cut short — ask for those on their own, or a few at a time." } : {}),
  };
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
