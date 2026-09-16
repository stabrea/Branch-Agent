import { lstat, mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import { constants } from "node:fs";
import { z } from "zod";
import type { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./contracts.js";
import { ignoreMatcher, type IgnoreMatcher } from "./ignore.js";

const pathSchema = z.string().min(1).max(500);
const secret =
  /(^\.env($|\.)|^\.ssh$|^\.aws$|^\.git$|^\.branch$|credentials|secrets?|^id_rsa|^id_ed25519|\.(pem|key|p12|pfx)$)/i;
export class WorkspaceFiles {
  /** A subfolder of the workspace that all paths resolve inside (the active project's folder), or "" for the whole workspace. */
  scope: () => string = () => "";
  constructor(readonly root: string) {}
  /** The folder paths currently resolve against: the workspace or the active project's folder inside it. */
  get base(): string {
    const folder = this.scope();
    return folder ? resolve(this.root, folder) : this.root;
  }
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
    const base = this.base, target = resolve(base, path),
      rel = relative(base, target);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Path outside workspace");
    if (
      rel &&
      (await this.hidden(relative(this.root, target), allowRoot))
    )
      throw new Error("Path hidden by .branchignore");
    await checkWorkspaceAncestors(this.root);
    if (base !== this.root) await mkdir(base, { recursive: true });
    let current = base;
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
    return target;
  }
  /**
   * The owner's `.branchignore` in the workspace root, re-read whenever the file changes. The
   * fixed secret patterns above are applied first, so a `!` line in this file cannot bring an
   * `.env` or a key back into view; it only ever hides more.
   */
  private ignore: { at: number; matcher: IgnoreMatcher } | undefined;
  private async matcher(): Promise<IgnoreMatcher | undefined> {
    try {
      const file = resolve(this.root, ".branchignore");
      const info = await stat(file);
      if (!info.isFile() || info.size > 65536) return undefined;
      if (this.ignore?.at !== info.mtimeMs)
        this.ignore = { at: info.mtimeMs, matcher: ignoreMatcher(await readFile(file, "utf8")) };
      return this.ignore.matcher;
    } catch {
      return undefined;
    }
  }
  /** True when `.branchignore` hides this path, written relative to the workspace root. */
  async hidden(path: string, isDirectory = false): Promise<boolean> {
    const matcher = await this.matcher();
    const relative = path.replace(/\\/g, "/").replace(/^\/+/, "");
    return !!relative && !!matcher && matcher.ignores(relative, isDirectory);
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
    const here = relative(this.root, target).replace(/\\/g, "/");
    const entries: { name: string; type: string }[] = [];
    for (const e of (await readdir(target, { withFileTypes: true })).slice(0, 400)) {
      if (entries.length >= 200) break;
      if (e.isSymbolicLink() || secret.test(e.name)) continue;
      if (await this.hidden(here ? `${here}/${e.name}` : e.name, e.isDirectory()))
        continue;
      entries.push({ name: e.name, type: e.isDirectory() ? "directory" : "file" });
    }
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
async function checkWorkspaceAncestors(root: string): Promise<void> {
  let current = resolve(root);
  while (true) {
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Workspace or ancestors contain a link");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
/** Lets workspace history keep a file's bytes before a write and record the change afterwards. */
export interface WriteObserver {
  before(path: string, context: ToolContext): Promise<unknown>;
  after(path: string, context: ToolContext, token: unknown): Promise<void>;
}
export function registerFiles(
  registry: ToolRegistry,
  files: WorkspaceFiles,
  observer?: WriteObserver,
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
    execute: async (a, c: ToolContext) => {
      const token = observer ? await observer.before(a.path, c) : undefined;
      const result = await files.write(a.path, a.content, c.signal);
      if (observer) await observer.after(a.path, c, token);
      return result;
    },
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
