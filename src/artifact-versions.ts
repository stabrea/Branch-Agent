import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { KeptArtifacts, KeptVersion } from "./build-artifacts.js";
import type { WorkspaceFiles } from "./files.js";
import type { ToolRegistry } from "./registry.js";

/**
 * The rest of a versioned artifact store (A1183, after Google ADK's artifact service): besides
 * keeping a version and listing them (src/build-artifacts.ts), a kept version can be put back into
 * the workspace byte for byte, and one version can be let go. The checksum is checked on the way
 * out, so a version that changed on disk is never handed back as if it were the original.
 */
const artifactName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i, "Use letters, digits, dots, dashes and underscores");

async function versionOf(kept: KeptArtifacts, name: string, version: number): Promise<KeptVersion> {
  const entry = (await kept.list(name)).versions.find((each) => each.version === version);
  if (!entry) throw new Error("There is no kept version with that number.");
  return entry;
}

/** Writes a kept version into the workspace, refusing links and, unless asked, an existing file. */
export async function restoreVersion(kept: KeptArtifacts, files: WorkspaceFiles,
  input: { name: string; version: number; path: string; replace: boolean }): Promise<KeptVersion & { restoredTo: string }> {
  const entry = await versionOf(kept, input.name, input.version);
  const bytes = await kept.read(input.name, input.version);
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
    throw new Error("That kept version no longer matches its checksum, so it was not put back.");
  const target = await files.checkedForWrite(input.path);
  await mkdir(dirname(target), { recursive: true });
  await files.checked(input.path);
  const flags = constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (input.replace ? 0 : constants.O_EXCL);
  const handle = await open(target, flags, 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("A file already has that name; say replace to overwrite it.");
    throw error;
  });
  try {
    const info = await handle.stat();
    if (info.nlink > 1 || !info.isFile()) throw new Error("That path is not a plain file.");
    await handle.truncate(0);
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return { ...entry, restoredTo: input.path };
}

/** Lets one version go: its bytes are removed and it leaves the list. The other versions keep their numbers. */
export async function forgetVersion(kept: KeptArtifacts, name: string, version: number): Promise<{ name: string; version: number; left: number }> {
  const entry = await versionOf(kept, name, version);
  const remaining = (await kept.list(name)).versions.filter((each) => each.version !== version).reverse();
  const folder = join(kept.root, artifactName.parse(name));
  await writeFile(join(folder, "versions.json"), JSON.stringify(remaining, null, 1), { mode: 0o600 });
  await rm(join(folder, entry.file), { force: true });
  if (!remaining.length) await rm(folder, { recursive: true, force: true });
  return { name, version, left: remaining.length };
}

export function registerArtifactVersions(registry: ToolRegistry, kept: KeptArtifacts, files: WorkspaceFiles): void {
  registry.register({
    name: "artifacts.restore", permission: "files.write", group: "code",
    description: "Put a kept version of a file back into the workspace, byte for byte, after checking its checksum. An existing file is only replaced when you say replace.",
    parameters: z.object({
      name: artifactName,
      version: z.number().int().min(1),
      path: z.string().min(1).max(500),
      replace: z.boolean().default(false),
    }).strict(),
    execute: async (args) => restoreVersion(kept, files, args),
  });
  registry.register({
    name: "artifacts.forget", permission: "files.write", group: "code",
    description: "Let one kept version go. Its bytes are removed; the other versions keep their numbers.",
    parameters: z.object({ name: artifactName, version: z.number().int().min(1) }).strict(),
    execute: async (args) => forgetVersion(kept, args.name, args.version),
  });
}
