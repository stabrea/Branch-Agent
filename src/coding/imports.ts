import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isSecretEntry } from "../files.js";
import { ignoreMatcher, type IgnoreMatcher } from "../ignore.js";

/**
 * R17-035: `@path/to/file.md` inside an instruction file brings that file's text in, the way Claude
 * Code and Gemini CLI do (the processing order — skip code, follow nested imports, stop on a loop or
 * past a depth — follows Gemini CLI's `memoryImportProcessor.ts`, Apache-2.0; written for Branch).
 *
 * The instruction file's own text is handed in by the context-file loader (src/context-files.ts);
 * this only reads the files it names. Those must be Markdown or plain text inside the same folder
 * tree, not a key file, not reached through a link that leaves the folder, and not too large.
 */
export const maxImportDepth = 5;
export const maxImportBytes = 16_000;
const maxImportsPerFile = 20;
const importLine = /(^|\s)@((?:\.{1,2}\/)?[\w./-]+\.(?:md|markdown|txt))(?=$|[\s),;])/g;

export type ImportReader = (path: string) => string | null;

/** Reads a file inside `root` for an import, or null with nothing read when it is not allowed. */
export function importReader(root: string): ImportReader {
  const top = realpathSync.native(root);
  const ignore = branchIgnore(top);
  return (path) => {
    try {
      const real = realpathSync.native(path);
      const rel = relative(top, real);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
      const slashed = rel.split(sep).join("/");
      if (isSecretEntry(slashed) || hiddenBy(ignore, slashed)) return null;
      const info = lstatSync(real);
      if (!info.isFile() || info.size > maxImportBytes) return null;
      return readFileSync(real, "utf8");
    } catch {
      return null;
    }
  };
}

/** The folder's `.branchignore`, read once for this pass; what it hides is never imported. */
function branchIgnore(top: string): IgnoreMatcher | null {
  try {
    const file = resolve(top, ".branchignore");
    const info = lstatSync(file);
    return info.isFile() && info.size <= 65536 ? ignoreMatcher(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}
const hiddenBy = (ignore: IgnoreMatcher | null, path: string): boolean => {
  if (!ignore) return false;
  const parts = path.split("/");
  return parts.some((_, index) => ignore.ignores(parts.slice(0, index + 1).join("/"), index < parts.length - 1));
};

/** Code fences and inline code, which are never read as imports. */
function codeSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const match of text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g)) spans.push([match.index, match.index + match[0].length]);
  return spans;
}

/**
 * The text with each `@file` replaced by that file's text, marked where it starts and ends. `folder`
 * is where the importing file sits; a path is read relative to it and never with a leading `/`.
 */
export function expandImports(text: string, folder: string, read: ImportReader, seen: string[] = [], depth = 0): string {
  const spans = codeSpans(text);
  let used = 0, count = 0;
  return text.replace(importLine, (whole, lead: string, path: string, offset: number) => {
    if (spans.some(([from, to]) => offset >= from && offset < to)) return whole;
    const target = resolve(folder, path);
    const note = (why: string) => `${lead}@${path} (${why})`;
    if (++count > maxImportsPerFile) return note("not imported: too many imports in one file");
    if (depth >= maxImportDepth) return note("not imported: imports nested too deeply");
    if (seen.includes(target)) return note("not imported: it imports itself");
    const body = read(target);
    if (body === null) return note("not imported: not a readable text file in this folder");
    used += Buffer.byteLength(body, "utf8");
    if (used > maxImportBytes) return note("not imported: the imports are too long together");
    const inner = expandImports(body, dirname(target), read, [...seen, target], depth + 1);
    return `${lead}<!-- imported from ${path} -->\n${inner.trim()}\n<!-- end of ${path} -->`;
  });
}
