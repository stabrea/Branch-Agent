import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { WorkspaceFiles } from "./files.js";

/**
 * Things a task produced that are not text: a picture, a zip, a program that was just built. They
 * are kept beside the run artifacts, outside the person's workspace, under a name the owner chose,
 * and every time the same name is kept again it becomes the next version rather than overwriting
 * the last one. Each version records how big it is and its checksum, so "is this the same build I
 * had yesterday?" is a question with an answer.
 */
export interface KeptVersion {
  name: string;
  version: number;
  file: string;
  bytes: number;
  sha256: string;
  /** Where in the workspace it came from, and what it was for. */
  source: string;
  note: string;
  createdAt: string;
}
const artifactName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i, "Use letters, digits, dots, dashes and underscores");
/** The most one kept file may weigh, and the most versions of one name to hold on to. */
export const keptLimits = { fileBytes: 32 * 1024 * 1024, versions: 20, names: 200 };

export class KeptArtifacts {
  constructor(readonly root: string) {}
  private folder(name: string): string { return join(this.root, artifactName.parse(name)); }
  private indexPath(name: string): string { return join(this.folder(name), "versions.json"); }

  private async index(name: string): Promise<KeptVersion[]> {
    const text = await readFile(this.indexPath(name), "utf8").catch(() => "");
    if (!text) return [];
    const parsed = z.array(z.object({
      name: z.string(), version: z.number().int(), file: z.string(), bytes: z.number().int(),
      sha256: z.string(), source: z.string(), note: z.string(), createdAt: z.string(),
    })).safeParse(JSON.parse(text) as unknown);
    return parsed.success ? parsed.data : [];
  }

  /** Keeps one workspace file as the next version of a name. */
  async keep(input: { files: WorkspaceFiles; path: string; name: string; note: string }): Promise<KeptVersion> {
    const absolute = await input.files.checked(input.path);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) throw new Error("There is no file at that path in your workspace.");
    if (info.size > keptLimits.fileBytes) throw new Error(`That file is larger than ${keptLimits.fileBytes / 1048576} MB, so it was not kept.`);
    const bytes = await readFile(absolute);
    const existing = await this.index(input.name);
    if (!existing.length && (await this.names()).length >= keptLimits.names)
      throw new Error(`There are already ${keptLimits.names} kept names; remove some before adding another.`);
    const version = (existing.at(-1)?.version ?? 0) + 1;
    const file = `v${version}${extname(input.path).toLowerCase().slice(0, 12)}`;
    await mkdir(this.folder(input.name), { recursive: true, mode: 0o700 });
    await writeFile(join(this.folder(input.name), file), bytes, { mode: 0o600 });
    const entry: KeptVersion = {
      name: input.name, version, file, bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      source: input.path, note: input.note, createdAt: new Date().toISOString(),
    };
    await writeFile(this.indexPath(input.name), JSON.stringify([...existing, entry].slice(-keptLimits.versions), null, 1), { mode: 0o600 });
    return entry;
  }

  /** Every name kept so far. */
  async names(): Promise<string[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().slice(0, keptLimits.names);
  }
  /** The versions of one name, or the newest version of every name. */
  async list(name?: string): Promise<{ versions: KeptVersion[] }> {
    if (name) return { versions: (await this.index(name)).slice().reverse() };
    const versions: KeptVersion[] = [];
    for (const each of await this.names()) {
      const newest = (await this.index(each)).at(-1);
      if (newest) versions.push(newest);
    }
    return { versions: versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }
  /** The bytes of one kept version, for putting a build back or comparing it. */
  async read(name: string, version: number): Promise<Buffer> {
    const entry = (await this.index(name)).find((each) => each.version === version);
    if (!entry) throw new Error("There is no kept version with that number.");
    return readFile(join(this.folder(name), entry.file));
  }
}

export function registerKeptArtifacts(registry: ToolRegistry, kept: KeptArtifacts, files: WorkspaceFiles): void {
  registry.register({
    // Keeping a file writes one: it belongs with the changing permissions, not the looking ones.
    name: "artifacts.keep", permission: "files.write", group: "code",
    description: "Keep a file the task produced — a picture, a zip, a built program — under a name of your choosing. Keeping the same name again makes the next version rather than replacing the last one. Each version records its size and its checksum.",
    parameters: z.object({
      path: z.string().min(1).max(500),
      name: artifactName,
      note: z.string().trim().max(200).default(""),
    }).strict(),
    execute: async (args, context: ToolContext) => {
      const entry = await kept.keep({ files, path: args.path, name: args.name, note: args.note });
      return { ...entry, dryRun: context.dryRun ?? false };
    },
  });
  registry.register({
    name: "artifacts.list", permission: "files.read", group: "code",
    description: "What has been kept: every name with its newest version, or every version of one name, each with its size, its checksum and where it came from.",
    parameters: z.object({ name: artifactName.optional() }).strict(),
    execute: async (args) => kept.list(args.name),
  });
}
