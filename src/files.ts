import { lstat, realpath, mkdir, open, readdir } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import { constants } from "node:fs";
import { z } from "zod";
import type { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./contracts.js";

const pathSchema = z.string().min(1).max(500);
const secret =
  /(^\.env($|\.)|^\.ssh$|^\.aws$|^\.git$|^\.branch$|credentials|secrets?|^id_rsa|^id_ed25519|\.(pem|key|p12|pfx)$)/i;
export class WorkspaceFiles {
  constructor(readonly root: string) {}
  async checked(path: string, allowRoot = false): Promise<string> {
    if (
      path.includes("\\") ||
      path.includes(":") ||
      isAbsolute(path) ||
      path
        .split("/")
        .some(
          (p) =>
            p === ".." ||
            p === "" ||
            (p !== "." && p.endsWith(".")) ||
            p.endsWith(" ") ||
            secret.test(p),
        )
    )
      throw new Error("Path denied: traversal or secret filename");
    if (path === "." && !allowRoot) throw new Error("File path required");
    const target = resolve(this.root, path),
      rel = relative(this.root, target);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Path outside workspace");
    const rootStat = await lstat(this.root);
    if (rootStat.isSymbolicLink()) throw new Error("Workspace link denied");
    let current = this.root;
    for (const part of rel.split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error("Symbolic link or junction path denied");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
        throw e;
      }
    }
    const canonical = await realpath(this.root);
    if (canonical.toLowerCase() !== resolve(this.root).toLowerCase())
      throw new Error("Workspace ancestors contain a link");
    return target;
  }
  async read(path: string): Promise<{ path: string; content: string }> {
    const target = await this.checked(path);
    const handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (stat.nlink > 1) throw new Error("Hardlink path denied");
      if (!stat.isFile() || stat.size > 32768)
        throw new Error("File exceeds 32 KiB or is not regular");
      return { path, content: await handle.readFile("utf8") };
    } finally {
      await handle.close();
    }
  }
  async write(
    path: string,
    content: string,
    signal: AbortSignal,
  ): Promise<{ path: string; bytes: number }> {
    if (Buffer.byteLength(content) > 32768)
      throw new Error("File exceeds 32 KiB");
    const target = await this.checked(path);
    await mkdir(dirname(target), { recursive: true });
    await this.checked(path);
    signal.throwIfAborted();
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const stat = await handle.stat();
      if (stat.nlink > 1) throw new Error("Hardlink path denied");
      if (!stat.isFile()) throw new Error("Not a regular file");
      await handle.truncate(0);
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    return { path, bytes: Buffer.byteLength(content) };
  }
  async list(
    path = ".",
  ): Promise<{ entries: { name: string; type: string }[] }> {
    const target = await this.checked(path, true);
    const entries = (await readdir(target, { withFileTypes: true }))
      .filter((e) => !e.isSymbolicLink() && !secret.test(e.name))
      .slice(0, 200)
      .map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "directory" : "file",
      }));
    return { entries };
  }
  async search(
    query: string,
    path = ".",
  ): Promise<{ matches: { path: string; line: number; text: string }[] }> {
    const matches: { path: string; line: number; text: string }[] = [];
    const queue = [path];
    let scanned = 0;
    while (queue.length && scanned < 200 && matches.length < 50) {
      const directory = queue.shift()!;
      for (const entry of (await this.list(directory)).entries) {
        if (++scanned > 200 || matches.length >= 50) break;
        const child =
          directory === "." ? entry.name : `${directory}/${entry.name}`;
        if (entry.type === "directory") {
          if (child.split("/").length < 6) queue.push(child);
          continue;
        }
        try {
          const file = await this.read(child);
          file.content.split("\n").forEach((text, i) => {
            if (matches.length < 50 && text.includes(query))
              matches.push({
                path: child,
                line: i + 1,
                text: text.slice(0, 500),
              });
          });
        } catch {
          /* Unreadable files are excluded. */
        }
      }
    }
    return { matches };
  }
}
export function registerFiles(
  registry: ToolRegistry,
  files: WorkspaceFiles,
): void {
  registry.register({
    name: "files.read",
    description: "Read a UTF-8 workspace file, maximum 32 KiB.",
    permission: "files.read",
    parameters: z.object({ path: pathSchema }).strict(),
    execute: async (a) => files.read(a.path),
  });
  registry.register({
    name: "files.list",
    description: "List up to 200 non-secret workspace entries.",
    permission: "files.read",
    parameters: z.object({ path: pathSchema.default(".") }).strict(),
    execute: async (a) => files.list(a.path),
  });
  registry.register({
    name: "files.search",
    description:
      "Literal content search, bounded to 200 entries and 50 matches.",
    permission: "files.read",
    parameters: z
      .object({
        query: z.string().min(1).max(200),
        path: pathSchema.default("."),
      })
      .strict(),
    execute: async (a) => files.search(a.query, a.path),
  });
  registry.register({
    name: "files.write",
    description: "Write a UTF-8 workspace file, maximum 32 KiB.",
    permission: "files.write",
    parameters: z
      .object({ path: pathSchema, content: z.string().max(32768) })
      .strict(),
    execute: async (a, c: ToolContext) =>
      files.write(a.path, a.content, c.signal),
  });
  registerVerification(registry, files);
}
function registerVerification(
  registry: ToolRegistry,
  files: WorkspaceFiles,
): void {
  registry.register({
    name: "files.verify",
    description: "Compare actual file content to an exact expected string.",
    permission: "files.read",
    parameters: z
      .object({ path: pathSchema, expected: z.string().max(32768) })
      .strict(),
    execute: async (a) => ({
      path: a.path,
      verified: (await files.read(a.path)).content === a.expected,
    }),
  });
}
