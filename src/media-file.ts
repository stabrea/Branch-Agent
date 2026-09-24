import { extname } from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { WorkspaceFiles } from "./files.js";
import { maximumMediaBytes } from "./media.js";

/**
 * FQ-collaboration: the raw bytes of one video already in the workspace, so the owner's Files
 * browser can play it and the comments pinned to it (`media-comments.ts`) can reopen it at the same
 * position. Kept apart from `media.ts`'s own kinds map — that one also covers pictures and sounds a
 * model reads and marks `.webm` as audio — because only the kinds a browser's `<video>` element is
 * actually asked to play are let through here.
 */
const videoKinds: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
};

export class VideoFileError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** True for a path whose ending is one of the kinds a `<video>` element can be pointed at. */
export const isVideoPath = (path: string): boolean => Object.hasOwn(videoKinds, extname(path).toLowerCase());

/**
 * One workspace video's bytes and the content type to serve them as. `files.checked` holds this to
 * the same traversal and secret-name rules as any other workspace read; `guard`, when given, is the
 * same protected-areas check the code editor's own file read is held to (src/never-break/protected.ts).
 */
export async function readWorkspaceVideo(
  files: WorkspaceFiles,
  path: string,
  guard?: (path: string) => string | null,
): Promise<{ bytes: Buffer; contentType: string; name: string }> {
  const contentType = videoKinds[extname(path).toLowerCase()];
  if (!contentType) throw new VideoFileError(415, "Only a video file can be opened here.");
  const refusal = guard?.(path);
  if (refusal) throw new VideoFileError(403, refusal);
  let target: string;
  try {
    target = await files.checked(path);
  } catch (error) {
    throw new VideoFileError(404, error instanceof Error ? error.message : "That file could not be opened.");
  }
  const info = await stat(target).catch(() => null);
  if (!info || !info.isFile()) throw new VideoFileError(404, "There is no file with that name.");
  if (info.size > maximumMediaBytes)
    throw new VideoFileError(413, `This video is larger than ${maximumMediaBytes / (1024 * 1024)} MB, so it cannot be opened here.`);
  return { bytes: await readFile(target), contentType, name: path.slice(path.lastIndexOf("/") + 1) };
}
