import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceFiles } from "../files.js";

/**
 * R17-D: the small markdown files a project keeps for Branch under `.agents/` (rules, schedules,
 * review checks): listing them safely, and reading their `---` header. The header reader knows only
 * what these files use — `key: value`, `key: [a, b]` and a `- item` list under a key — and never
 * runs anything. Splitting the header from the body follows Cline's cron spec parser (Apache-2.0,
 * `cron/specs/cron-spec-parser.ts`).
 */
export interface MarkdownFile { name: string; path: string; header: Record<string, string | string[]>; body: string }
export const maxFiles = 50;
export const maxFileBytes = 16_384;

export function splitHeader(raw: string): { header: Record<string, string | string[]>; body: string } {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { header: {}, body: text };
  const close = text.indexOf("\n---", 3);
  if (close < 0) return { header: {}, body: text };
  const header: Record<string, string | string[]> = {};
  let listKey = "";
  for (const line of text.slice(4, close).split("\n")) {
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (item && listKey) { (header[listKey] as string[]).push(unquote(item[1]!)); continue; }
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, value] = pair as unknown as [string, string, string];
    listKey = "";
    if (!value.trim()) { header[key] = []; listKey = key; continue; }
    const inline = /^\[(.*)\]$/.exec(value.trim());
    header[key] = inline ? inline[1]!.split(",").map(unquote).filter(Boolean) : unquote(value);
  }
  return { header, body: text.slice(close + 4).replace(/^[^\n]*\n/, "") };
}
const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, "$2");

export const headerText = (header: Record<string, string | string[]>, key: string): string | undefined => {
  const value = header[key];
  return typeof value === "string" ? value : undefined;
};
export const headerList = (header: Record<string, string | string[]>, key: string): string[] | undefined => {
  const value = header[key];
  return Array.isArray(value) ? value : typeof value === "string" && value ? [value] : undefined;
};

/**
 * The `.md` files directly inside a workspace folder, each read through the workspace's own checks
 * (no way out of the workspace, no key files, nothing `.branchignore` hides). Links are skipped.
 */
export async function markdownFiles(files: WorkspaceFiles, folder: string): Promise<MarkdownFile[]> {
  let base: string;
  try { base = await files.checked(folder); } catch { return []; }
  const names = (await readdir(base).catch(() => [])).filter((name) => /^[\w.-]+\.md$/.test(name)).sort().slice(0, maxFiles);
  const found: MarkdownFile[] = [];
  for (const name of names) {
    const path = `${folder}/${name}`;
    try {
      const checked = await files.checked(path);
      const info = await lstat(checked);
      if (!info.isFile() || info.size > maxFileBytes) continue;
      found.push({ name, path, ...splitHeader(await readFile(join(base, name), "utf8")) });
    } catch { /* a file the workspace refuses is simply not one of these */ }
  }
  return found;
}

/** A glob (`src/**`, `*.ts`, `docs/?.md`) as a test on a workspace path with forward slashes. */
export function globTest(pattern: string): (path: string) => boolean {
  let source = "";
  const text = pattern.trim().replace(/^\.\//, "");
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "*" && text[index + 1] === "*") {
      index++;
      if (text[index + 1] === "/") { index++; source += "(?:.*/)?"; } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const whole = new RegExp(`^${source}$`);
  const named = text.includes("/") ? null : new RegExp(`(?:^|/)${source}$`);
  return (path) => whole.test(path) || (named?.test(path) ?? false);
}
