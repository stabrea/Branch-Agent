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
 * The most text one call may hand back, across all its files. Each file is already held to 32 KiB
 * by `files.read`; this stops ten of them filling the conversation in one go.
 */
export const readManyTotalBytes = 96 * 1024;

export const ReadManySchema = z.object({
  paths: z.array(pathSchema).min(1).max(readManyLimit),
}).strict();

export interface ReadManyFile {
  path: string;
  content?: string;
  /** Why this one could not be read, in the same words the single-file tool would have used. */
  error?: string;
  /** Set when the call's total size was reached before this file; read it on its own. */
  skipped?: true;
}

export function registerReadMany(registry: ToolRegistry, files: WorkspaceFiles): void {
  registry.register({
    name: "files.read_many",
    permission: "files.read",
    group: "files",
    description:
      `Read several UTF-8 workspace files in one go — up to ${readManyLimit} of them, each at most 32 KiB. `
      + "Use this instead of reading one file at a time: it is the same reading, in one step rather than several. "
      + "A path that cannot be read is named with the reason and the rest still come back.",
    parameters: ReadManySchema,
    execute: async (input, context: ToolContext) => readMany(files, input.paths, context),
  });
}

/** The loop itself, kept out of the registration so it can be tested on its own. */
export async function readMany(
  files: WorkspaceFiles, paths: readonly string[], context: ToolContext,
): Promise<{ files: ReadManyFile[]; read: number; refused: number }> {
  const out: ReadManyFile[] = [];
  let bytes = 0;
  for (const path of paths) {
    if (bytes >= readManyTotalBytes) { out.push({ path, skipped: true }); continue; }
    try {
      const file = await files.read(path);
      // The same note the one-at-a-time tool leaves, per file, so reading here counts as reading
      // for the read-before-edit guard exactly as it would have done separately.
      files.readFirst?.noteRead(context.runId, files.addressOf(path), file.content);
      bytes += file.content.length;
      out.push({ path, content: file.content });
    } catch (error) {
      out.push({ path, error: plainly(error, path) });
    }
  }
  return { files: out, read: out.filter((one) => one.content !== undefined).length,
    refused: out.filter((one) => one.error !== undefined).length };
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
