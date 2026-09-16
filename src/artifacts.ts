import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Files a task produced that are too big to travel inside a tool result: a screenshot, a saved
 * page. They live beside the private database, never in the person's workspace, so nothing a tool
 * wrote can collide with their own files. The tool result carries the path, the size and a
 * checksum, and the ordinary tool receipt signs that.
 */
export interface Artifact {
  path: string;
  bytes: number;
  sha256: string;
  mediaType: string;
}
const safeName = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/** Eight megabytes: room for a full-page screenshot, small enough to keep the folder tidy. */
export const maxArtifactBytes = 8 * 1024 * 1024;

export class RunArtifacts {
  constructor(readonly root: string) {}
  async write(runId: string, name: string, mediaType: string, bytes: Buffer): Promise<Artifact> {
    if (!safeName.test(runId) || !safeName.test(name))
      throw new Error("Artifact names use letters, digits, dots, dashes and underscores");
    if (bytes.byteLength > maxArtifactBytes) throw new Error("That file is larger than 8 MB, so it was not kept");
    const folder = join(this.root, runId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, name);
    await writeFile(path, bytes, { mode: 0o600 });
    return { path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), mediaType };
  }
  /**
   * A tool result that is a picture, or null. Only the shape `RunArtifacts.write` returns counts,
   * so nothing a website says can talk the runtime into reading a file of its choosing.
   */
  static imageIn(value: unknown): Artifact | null {
    const outcome = value as { ok?: boolean; result?: Record<string, unknown> } | null;
    const result = outcome?.ok ? outcome.result : undefined;
    if (!result || typeof result.path !== "string" || typeof result.sha256 !== "string") return null;
    if (typeof result.mediaType !== "string" || !result.mediaType.startsWith("image/")) return null;
    if (typeof result.bytes !== "number") return null;
    return { path: result.path, sha256: result.sha256, mediaType: result.mediaType, bytes: result.bytes };
  }
  /** Reads one back for the model layer; any path outside the artifacts folder is refused. */
  async read(path: string): Promise<Buffer> {
    const target = resolve(path), rel = relative(resolve(this.root), target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("That file is not a run artifact");
    return readFile(target);
  }
}
