import { constants } from "node:fs";
import { copyFile, lstat, mkdtemp, open, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { discardFolder } from "./scratch.js";

/**
 * A read-only view of another assistant's home folder, whether it is still a folder on this
 * computer or has been handed over as a zip or tar file. Readers only ever see paths relative to
 * the top of it, written with forward slashes, and cannot reach anything outside it: a path with
 * `..` in it is refused, and a link inside the folder is never followed.
 */
export interface SourceEntry { name: string; kind: "file" | "dir"; size: number; modifiedMs: number }
export interface SourceTree {
  /** What to call it when talking to the owner: the folder, or the file it came from. */
  readonly label: string;
  list(dir: string): Promise<SourceEntry[]>;
  /** The file's text, or null when it is missing, is not a plain file, or is larger than `maxBytes`. */
  read(path: string, maxBytes?: number): Promise<string | null>;
  /**
   * A private copy of a file (and the files beside it that share its name, such as a database's
   * `-wal`), so a database can be opened without touching the original. `discard` removes it.
   */
  copyOut(path: string): Promise<{ path: string; discard(): Promise<void> } | null>;
}

export const defaultReadLimit = 8 * 1024 * 1024;
/** The most an archive may hold once unpacked, and how many entries, so a hostile file cannot fill memory. */
/** The largest database Branch copies aside to read, so a huge one cannot fill the disk. */
export const databaseCopyBytes = 2 * 1024 * 1024 * 1024;
export const archiveLimits = { fileBytes: 128 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, entries: 50_000 };

/** A relative path made safe: forward slashes, no empty or `.` parts, and never `..`. */
export function cleanRelative(path: string): string | null {
  const parts = path.replace(/\\/g, "/").split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === ".." || part.includes("\0") || /^[A-Za-z]:$/.test(part))) return null;
  return parts.join("/");
}

const within = (base: string, full: string): boolean => full === base || full.startsWith(base.endsWith(sep) ? base : base + sep);

/**
 * The full path for a relative one inside `top`, or null. The path must stay inside by its name, and
 * a folder inside that is really a link elsewhere is not followed: the real place must still be inside.
 */
async function insideFolder(top: string, only: string[] | undefined, path: string): Promise<string | null> {
  const relative = cleanRelative(path);
  if (relative === null) return null;
  if (only && relative !== "" && !only.includes(relative.split("/")[0] ?? "")) return null;
  const full = resolve(top, relative);
  if (!within(top, full)) return null;
  if (full === top) return full;
  const real = (where: string) => realpath(where).catch(() => null);
  const [realTop, realItself] = await Promise.all([real(top), real(full).then((found) => found ?? real(resolve(full, "..")))]);
  return realTop && realItself && within(realTop, realItself) ? full : null;
}

/** A plain file, opened without following a link, and no larger than `maxBytes`. */
async function plainFile(full: string, maxBytes: number): Promise<Buffer | null> {
  const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    return info.isFile() && info.size <= maxBytes ? await handle.readFile() : null;
  } finally { await handle.close(); }
}

/**
 * A folder on this computer. `only`, when given, limits it to those names at its top, so a single
 * file beside another assistant's folder (Claude Code's `~/.claude.json`) can be read without the
 * rest of the home folder it sits in.
 */
export function folderTree(root: string, only?: string[]): SourceTree {
  const top = resolve(root);
  const inside = (path: string) => insideFolder(top, only, path);
  return {
    label: top,
    async list(dir) {
      const full = await inside(dir);
      if (!full) return [];
      const names = (await readdir(full).catch(() => [] as string[]))
        .filter((name) => !only || full !== top || only.includes(name));
      const entries: SourceEntry[] = [];
      for (const name of names.sort()) {
        const info = await lstat(join(full, name)).catch(() => null);
        if (!info || info.isSymbolicLink()) continue;
        if (info.isFile() || info.isDirectory())
          entries.push({ name, kind: info.isFile() ? "file" : "dir", size: info.size, modifiedMs: info.mtimeMs });
      }
      return entries;
    },
    async read(path, maxBytes = defaultReadLimit) {
      const full = await inside(path);
      const data = full ? await plainFile(full, maxBytes).catch(() => null) : null;
      return data ? data.toString("utf8") : null;
    },
    async copyOut(path) {
      const full = await inside(path);
      return full ? copyDatabase(full) : null;
    },
  };
}

/** A private copy of a database and the journal beside it: each a plain file, and together not too large. */
async function copyDatabase(full: string): Promise<{ path: string; discard(): Promise<void> } | null> {
  const parts: string[] = [];
  let bytes = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    const info = await lstat(full + suffix).catch(() => null);
    if (!info?.isFile()) { if (suffix === "") return null; continue; }
    bytes += info.size;
    parts.push(suffix);
  }
  if (bytes > databaseCopyBytes) throw new Error(`${basename(full)} is larger than Branch will copy to read`);
  const folder = await mkdtemp(join(tmpdir(), "branch-move-in-"));
  const target = join(folder, basename(full));
  try {
    for (const suffix of parts) await copyFile(full + suffix, target + suffix);
  } catch (error) { await discardFolder(folder); throw error; }
  return { path: target, discard: () => discardFolder(folder) };
}

/** One folder inside a tree, seen as a tree of its own (a Hermes profile inside its home folder). */
export function subTree(tree: SourceTree, prefix: string): SourceTree {
  const base = cleanRelative(prefix) ?? "";
  const under = (path: string): string => {
    const relative = cleanRelative(path);
    return relative === null ? "\0" : base && relative ? `${base}/${relative}` : base || relative;
  };
  return {
    label: base ? `${tree.label} (${base})` : tree.label,
    list: (dir) => tree.list(under(dir)),
    read: (path, maxBytes) => tree.read(under(path), maxBytes),
    copyOut: (path) => tree.copyOut(under(path)),
  };
}

/** An archive already unpacked into memory, by relative path. */
export function memoryTree(label: string, files: Map<string, { data: Buffer; modifiedMs: number }>): SourceTree {
  const dirs = new Set<string>([""]);
  for (const name of files.keys()) {
    const parts = name.split("/");
    for (let index = 1; index < parts.length; index++) dirs.add(parts.slice(0, index).join("/"));
  }
  return {
    label,
    async list(dir) {
      const base = cleanRelative(dir);
      if (base === null || !dirs.has(base)) return [];
      const prefix = base ? base + "/" : "", seen = new Map<string, SourceEntry>();
      for (const [name, file] of files) {
        if (!name.startsWith(prefix)) continue;
        const [head, ...rest] = name.slice(prefix.length).split("/");
        if (!head || seen.has(head)) continue;
        seen.set(head, rest.length
          ? { name: head, kind: "dir", size: 0, modifiedMs: 0 }
          : { name: head, kind: "file", size: file.data.length, modifiedMs: file.modifiedMs });
      }
      return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    async read(path, maxBytes = defaultReadLimit) {
      const name = cleanRelative(path);
      const file = name === null ? undefined : files.get(name);
      return file && file.data.length <= maxBytes ? file.data.toString("utf8") : null;
    },
    async copyOut(path) {
      const name = cleanRelative(path);
      const file = name === null ? undefined : files.get(name);
      if (!file || name === null) return null;
      const folder = await mkdtemp(join(tmpdir(), "branch-move-in-"));
      const target = join(folder, basename(name));
      await writeFile(target, file.data, { mode: 0o600 });
      for (const suffix of ["-wal"]) {
        const beside = files.get(name + suffix);
        if (beside) await writeFile(target + suffix, beside.data, { mode: 0o600 });
      }
      return { path: target, discard: () => discardFolder(folder) };
    },
  };
}

type Unpacked = Map<string, { data: Buffer; modifiedMs: number }>;

/** Adds one unpacked entry, keeping to the limits; entries with unsafe names are left out. */
function keep(files: Unpacked, name: string, data: Buffer, modifiedMs: number, total: { bytes: number }): void {
  const clean = cleanRelative(name);
  if (!clean) return;
  if (files.size >= archiveLimits.entries) throw new Error("The file holds more entries than Branch will open");
  total.bytes += data.length;
  if (total.bytes > archiveLimits.totalBytes) throw new Error("The file is larger than Branch will open once unpacked");
  files.set(clean, { data, modifiedMs });
}

/** Reads a zip into memory. Folders are implied by the file names inside it. */
export function unzip(bytes: Buffer): Unpacked {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("This file is not a zip file");
  const count = bytes.readUInt16LE(end + 10), files: Unpacked = new Map(), total = { bytes: 0 };
  if (count === 0xffff) throw new Error("This zip file is too large for Branch to open (zip64)");
  let position = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(position) !== 0x02014b50) throw new Error("The zip file's list of contents is damaged");
    const method = bytes.readUInt16LE(position + 10), stored = bytes.readUInt32LE(position + 20);
    const size = bytes.readUInt32LE(position + 24), nameLength = bytes.readUInt16LE(position + 28);
    const skip = nameLength + bytes.readUInt16LE(position + 30) + bytes.readUInt16LE(position + 32);
    const name = bytes.toString("utf8", position + 46, position + 46 + nameLength);
    const local = bytes.readUInt32LE(position + 42);
    position += 46 + skip;
    if (name.endsWith("/")) continue;
    if (size > archiveLimits.totalBytes) throw new Error("The file is larger than Branch will open once unpacked");
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + stored);
    const data = method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) })
      : method === 0 ? Buffer.from(raw) : null;
    if (!data || data.length !== size) throw new Error(`${name} inside the zip file could not be unpacked`);
    keep(files, name, data, 0, total);
  }
  return files;
}

const field = (block: Buffer, start: number, length: number): string =>
  block.toString("utf8", start, start + length).replace(/\0[\s\S]*$/, "");

/** The `path=` line of a pax extended header, which replaces the name of the entry after it. */
function paxPath(data: Buffer): string | undefined {
  for (const line of data.toString("utf8").split("\n")) {
    const match = /^\d+ path=(.*)$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/** Reads a tar (plain or gzip-compressed) into memory: files, pax and GNU long names; links are skipped. */
export function untar(input: Buffer): Unpacked {
  const bytes = input[0] === 0x1f && input[1] === 0x8b
    ? gunzipSync(input, { maxOutputLength: archiveLimits.totalBytes + 1024 * 1024 }) : input;
  const files: Unpacked = new Map(), total = { bytes: 0 };
  let position = 0, longName: string | undefined;
  while (position + 512 <= bytes.length) {
    const header = bytes.subarray(position, position + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(field(header, 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("The tar file is damaged");
    const type = String.fromCharCode(header[156] ?? 0), prefix = field(header, 345, 155);
    const data = bytes.subarray(position + 512, position + 512 + size);
    const modifiedMs = parseInt(field(header, 136, 12).trim() || "0", 8) * 1000 || 0;
    position += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") { longName = paxPath(data) ?? longName; continue; }
    if (type === "L") { longName = data.toString("utf8").replace(/\0[\s\S]*$/, ""); continue; }
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = undefined;
    if (type === "0" || type === "\0") keep(files, name, Buffer.from(data), modifiedMs, total);
  }
  return files;
}

/** When everything in an archive sits inside one top folder (`.claude/…`), that folder is the top. */
export function dropSharedTop(files: Unpacked): Unpacked {
  const tops = new Set([...files.keys()].map((name) => name.split("/")[0]));
  const [only] = tops;
  if (tops.size !== 1 || !only || [...files.keys()].some((name) => !name.includes("/"))) return files;
  return new Map([...files].map(([name, file]) => [name.slice(only.length + 1), file]));
}

/** Opens what the owner pointed at: a folder, or a `.zip`, `.tar`, `.tar.gz` or `.tgz` file. */
export async function openSource(path: string): Promise<SourceTree> {
  const full = resolve(path);
  const info = await lstat(full).catch(() => null);
  if (!info) throw new Error("There is nothing at that place on this computer");
  if (info.isDirectory()) return folderTree(full);
  if (!info.isFile()) throw new Error("Choose a folder, or a .zip, .tar or .tar.gz file");
  if (info.size > archiveLimits.fileBytes) throw new Error("That file is larger than Branch will open");
  return archiveTree(basename(full), await readFile(full));
}

/** An archive handed over as bytes (an upload, or a file already read). */
export function archiveTree(name: string, bytes: Buffer): SourceTree {
  if (bytes.length > archiveLimits.fileBytes) throw new Error("That file is larger than Branch will open");
  const lower = name.toLowerCase();
  const zip = lower.endsWith(".zip") || (bytes[0] === 0x50 && bytes[1] === 0x4b);
  if (!zip && !/\.(tar|tar\.gz|tgz)$/.test(lower) && !(bytes[0] === 0x1f && bytes[1] === 0x8b))
    throw new Error("Choose a folder, or a .zip, .tar or .tar.gz file");
  return memoryTree(name, dropSharedTop(zip ? unzip(bytes) : untar(bytes)));
}
