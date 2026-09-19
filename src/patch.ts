import type { ToolTarget } from "./contracts.js";
import { endingOf, indentShift, joinLines, splitLines, type FileLine } from "./text-replace.js";
/**
 * A small unified-diff reader and applier. It is strict about *what* changes and forgiving about
 * *where*: every context and removed line must be in the file, but a hunk whose line number is off,
 * whose declared line counts are wrong, or whose header carries no numbers at all is still placed —
 * by searching for its lines, first exactly and then ignoring trailing and then leading whitespace.
 * That is what `git apply`/`patch` do with offsets and what models get wrong most often.
 *
 * It never guesses. When the lines fit in more than one place, a hunk goes where its line number
 * says if they fit there; otherwise only an exact match that is strictly nearest to that line is
 * taken. A hunk with no line number, or one that only fits loosely, must fit exactly one place.
 * Anything else is refused, naming the file and the part, and nothing is written. Each line keeps
 * its own ending, so a Windows (CRLF) file stays one, and new lines take the file's usual ending.
 *
 * Also reads the `*** Begin Patch` / `*** Update File:` form some models are trained to write,
 * including its `@@ line` anchors: the part's lines are looked for after that line.
 */
export interface PatchLine { kind: " " | "-" | "+"; text: string }
/**
 * `oldStart` is null when the hunk header gave no line number. `anchors` are the lines a header with
 * no numbers names (`@@ class Cart`), found in order before the part's own lines are looked for.
 */
export interface Hunk { index: number; oldStart: number | null; anchors?: string[]; lines: PatchLine[]; endsWithoutNewline: boolean }
export interface PatchFile {
  path: string; created: boolean; hunks: Hunk[];
  /** mac7/multi-target: the other path a header's "---" line names (a rename), or null. The rules judge it too. */
  oldPath: string | null;
}

const numbered = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const isHunkHeader = (line: string): boolean => line.startsWith("@@");

export function parsePatch(text: string): PatchFile[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.some((line) => line.trim() === "*** Begin Patch")) return parseEnvelope(lines);
  const files: PatchFile[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at]!;
    if (!line.startsWith("--- ")) { at++; continue; }
    const next = lines[at + 1];
    if (!next?.startsWith("+++ "))
      throw new Error("Patch refused: a file header is missing its \"+++\" line");
    const from = target(line.slice(4)), to = target(next.slice(4));
    if (to === null) throw new Error(`Patch refused: removing "${from ?? "a file"}" is not supported`);
    checkPath(to);
    at += 2;
    const hunks: Hunk[] = [];
    while (at < lines.length && isHunkHeader(lines[at]!)) at = readHunk(lines, at, hunks);
    if (!hunks.length) throw new Error(`Patch refused: "${to}" has no changes in the patch`);
    files.push({ path: to, created: from === null, hunks, oldPath: from !== null && from !== to ? from : null });
  }
  if (!files.length) throw new Error("Patch refused: no file headers (\"--- \"/\"+++ \") were found");
  return files;
}

/**
 * mac7/multi-target: every file a patch touches, read by `parsePatch` itself, so what the rules judge
 * is exactly what will be applied. A rename's old path is judged as a change too, because the patch
 * says that file moves. A dry run only reads. A patch that cannot be read throws, and is refused.
 */
export function patchTargets(text: string, dryRun = false): ToolTarget[] {
  const kind = dryRun ? "read" as const : "write" as const;
  return parsePatch(text).flatMap((file) => [
    { kind, path: file.path },
    ...(file.oldPath ? [{ kind, path: file.oldPath }] : []),
  ]);
}

/** "2 files: a, b": how a call touching several files is named on a question and in a standing answer. */
export const fileList = (paths: string[]): string =>
  `${paths.length} file${paths.length === 1 ? "" : "s"}: ${paths.slice(0, 7).join(", ")}${paths.length > 7 ? ", …" : ""}`;
/** mac7/multi-target: the files a patch names, as it will be applied; empty when it cannot be read (it is then refused). */
export function patchFileList(patch: string): string {
  try { return fileList([...new Set(patchTargets(patch).map((one) => one.path ?? ""))]); } catch { return ""; }
}

function checkPath(path: string): void {
  if (path.includes("..")) throw new Error(`Patch refused: "${path}" is not a workspace path`);
}

/** The workspace path a diff header names, or null for the "no such file" marker. */
function target(spec: string): string | null {
  const raw = spec.split("\t")[0]!.trim().replace(/^"|"$/g, "");
  if (raw === "/dev/null") return null;
  const stripped = raw.replace(/^[ab]\//, "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!stripped) throw new Error("Patch refused: a file header has no path");
  return stripped;
}

/** A `*** Update File:` path is written as it is: no `a/`/`b/` prefix to strip, so a folder named `b` stays. */
function envelopePath(spec: string): string {
  const path = spec.trim().replace(/^"|"$/g, "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path) throw new Error("Patch refused: a file header has no path");
  checkPath(path);
  return path;
}

/** Where a hunk's body stops when its declared counts cannot be trusted. */
const endsBody = (lines: string[], at: number): boolean => {
  const line = lines[at]!;
  return isHunkHeader(line) || line.startsWith("diff --git ") || line.startsWith("*** ")
    || (line.startsWith("--- ") && (lines[at + 1] ?? "").startsWith("+++ "));
};

/**
 * Reads one hunk. Its declared counts are used when they describe the body correctly, so a removed
 * line that itself starts with "--" stays unambiguous; when they do not (the commonest slip a model
 * makes), the body runs to the next header instead of the patch being refused.
 */
function readHunk(lines: string[], at: number, hunks: Hunk[]): number {
  const match = numbered.exec(lines[at]!);
  const anchors: string[] = [];
  // Unnumbered headers stack (`@@ class Cart` then `@@ def total`): each narrows where to look.
  while (!match && isHunkHeader(lines[at]!)) {
    const anchor = lines[at]!.replace(/^@@\s?/, "").replace(/\s*@@\s*$/, "");
    if (anchor.trim()) anchors.push(anchor);
    if (!isHunkHeader(lines[at + 1] ?? "") || numbered.test(lines[at + 1]!)) break;
    at++;
  }
  const hunk: Hunk = {
    index: hunks.length + 1, oldStart: match ? Number(match[1]) : null, ...(anchors.length ? { anchors } : {}), lines: [], endsWithoutNewline: false,
  };
  if (match) {
    const byCount = readCounted(lines, at + 1, match[2] === undefined ? 1 : Number(match[2]), match[4] === undefined ? 1 : Number(match[4]));
    if (byCount && (byCount.next >= lines.length || lines.slice(byCount.next).every((l) => l === "") || endsBody(lines, byCount.next))) {
      Object.assign(hunk, { lines: byCount.body, endsWithoutNewline: byCount.noNewline });
      hunks.push(hunk);
      return byCount.next;
    }
  }
  let cursor = at + 1;
  while (cursor < lines.length && !endsBody(lines, cursor)) {
    const body = lines[cursor++]!;
    if (body.startsWith("\\")) { hunk.endsWithoutNewline = true; continue; }
    hunk.lines.push(bodyLine(body));
  }
  // A blank line at the very end of the text is the patch's own final newline, not a context line.
  while (hunk.lines.length && cursor >= lines.length && hunk.lines.at(-1)!.kind === " " && hunk.lines.at(-1)!.text === "") hunk.lines.pop();
  if (!hunk.lines.some((line) => line.kind !== " "))
    throw new Error(`Patch refused: part ${hunk.index} of the patch changes nothing`);
  hunks.push(hunk);
  return cursor;
}

function readCounted(lines: string[], from: number, oldCount: number, newCount: number):
  { body: PatchLine[]; next: number; noNewline: boolean } | null {
  const body: PatchLine[] = [];
  let seenOld = 0, seenNew = 0, cursor = from, noNewline = false;
  while ((seenOld < oldCount || seenNew < newCount) && cursor < lines.length) {
    const text = lines[cursor]!;
    if (text.startsWith("\\")) { noNewline = true; cursor++; continue; }
    if (text !== "" && !" -+".includes(text[0]!)) return null;
    const line = bodyLine(text);
    if (line.kind !== "+") seenOld++;
    if (line.kind !== "-") seenNew++;
    body.push(line);
    cursor++;
  }
  if (cursor < lines.length && lines[cursor]!.startsWith("\\")) { noNewline = true; cursor++; }
  return seenOld === oldCount && seenNew === newCount ? { body, next: cursor, noNewline } : null;
}

function bodyLine(body: string): PatchLine {
  if (body === "") return { kind: " ", text: "" };
  const kind = body[0]!;
  if (kind !== " " && kind !== "-" && kind !== "+")
    throw new Error(`Patch refused: unexpected line "${body.slice(0, 40)}" inside a change`);
  return { kind, text: body.slice(1) };
}

/** The `*** Begin Patch` form: Update File (hunks without line numbers) and Add File. */
function parseEnvelope(lines: string[]): PatchFile[] {
  const files: PatchFile[] = [];
  let at = lines.findIndex((line) => line.trim() === "*** Begin Patch") + 1;
  while (at < lines.length) {
    const line = lines[at]!;
    const update = /^\*\*\* Update File: (.+)$/.exec(line), add = /^\*\*\* Add File: (.+)$/.exec(line);
    if (/^\*\*\* Delete File: /.test(line)) throw new Error("Patch refused: removing a file is not supported");
    if (/^\*\*\* Move to: /.test(line)) throw new Error("Patch refused: moving a file is not supported");
    if (!update && !add) { at++; continue; }
    const path = envelopePath((update ?? add)![1]!);
    at++;
    if (add) {
      const added: PatchLine[] = [];
      while (at < lines.length && !lines[at]!.startsWith("*** ")) {
        const text = lines[at++]!;
        if (text.startsWith("+")) added.push({ kind: "+", text: text.slice(1) });
      }
      files.push({ path, created: true, hunks: [{ index: 1, oldStart: 0, lines: added, endsWithoutNewline: false }], oldPath: null });
      continue;
    }
    const hunks: Hunk[] = [];
    // The first hunk of an Update may start without its own "@@".
    if (at < lines.length && !isHunkHeader(lines[at]!) && !lines[at]!.startsWith("*** ")) {
      lines.splice(at, 0, "@@");
    }
    while (at < lines.length && isHunkHeader(lines[at]!)) at = readHunk(lines, at, hunks);
    if (!hunks.length) throw new Error(`Patch refused: "${path}" has no changes in the patch`);
    files.push({ path, created: false, hunks, oldPath: null });
  }
  if (!files.length) throw new Error("Patch refused: no \"*** Update File:\" or \"*** Add File:\" sections were found");
  return files;
}

type Compare = (a: string, b: string) => boolean;
const comparisons: Compare[] = [
  (a, b) => a === b,
  (a, b) => a.trimEnd() === b.trimEnd(),
  (a, b) => a.trim() === b.trim(),
];
/** How closely a hunk's lines matched the file: 0 exactly, 1 ignoring trailing, 2 ignoring all indentation. */
interface Placed { at: number; tier: number }

/** Every place at or after `from` where `old` fits, at the strictest comparison that finds any. */
function candidates(lines: readonly string[], old: readonly string[], from: number): { at: number[]; tier: number } | null {
  for (let tier = 0; tier < comparisons.length; tier++) {
    const same = comparisons[tier]!;
    const found: number[] = [];
    for (let at = from; at + old.length <= lines.length; at++)
      if (old.every((text, i) => same(lines[at + i]!, text))) found.push(at);
    if (found.length) return { at: found, tier };
  }
  return null;
}

/** Where a hunk with old lines goes, or a refusal: nowhere, or more than one equally good place. */
function place(file: PatchFile, hunk: Hunk, lines: readonly string[], old: readonly string[], from: number): Placed {
  const found = candidates(lines, old, from);
  if (!found) refuse(file, hunk, Math.min(from, lines.length) + 1, old[0]!);
  if (found.at.length === 1) return { at: found.at[0]!, tier: found.tier };
  const hint = hunk.oldStart === null ? null : Math.max(0, hunk.oldStart - 1);
  if (hint !== null && found.at.includes(hint)) return { at: hint, tier: found.tier };
  if (hint !== null && found.tier === 0) {
    const [first, second] = [...found.at].sort((a, b) => Math.abs(a - hint) - Math.abs(b - hint));
    if (Math.abs(first! - hint) < Math.abs(second! - hint)) return { at: first!, tier: 0 };
  }
  throw new Error(
    `Patch refused: part ${hunk.index} of the patch for "${file.path}" fits the file in ${found.at.length} places `
    + `(lines ${found.at.slice(0, 5).map((at) => at + 1).join(", ")}${found.at.length > 5 ? ", …" : ""}), so which one is meant is not clear; nothing was changed. `
    + "Include more unchanged lines around the change, or the right line numbers, so it fits only one place.",
  );
}

/** The line after a hunk's anchors (`@@ class Cart`), each looked for after the one before. */
function afterAnchors(file: PatchFile, hunk: Hunk, lines: readonly string[], from: number): number {
  let at = from;
  for (const anchor of hunk.anchors ?? []) {
    const found = candidates(lines, [anchor], at);
    if (!found)
      throw new Error(`Patch refused: part ${hunk.index} of the patch for "${file.path}" names the line ${JSON.stringify(anchor.slice(0, 120))}, which is not in the file; nothing was changed.`);
    at = found.at[0]! + 1;
  }
  return at;
}

/** Where a hunk that only adds lines goes: after the line it names, or at the end when it names none. */
function placeAddition(file: PatchFile, hunk: Hunk, lines: readonly string[], cursor: number): number {
  if (hunk.anchors?.length)
    throw new Error(`Patch refused: part ${hunk.index} of the patch for "${file.path}" only adds lines, so where they go is not clear; nothing was changed. Include an unchanged line before or after them.`);
  if (hunk.oldStart === null) return Math.max(cursor, lines.length);
  if (hunk.oldStart < cursor || hunk.oldStart > lines.length)
    throw new Error(`Patch refused: part ${hunk.index} of the patch for "${file.path}" adds lines after line ${hunk.oldStart}, but that is not a place in the file it can go (it has ${lines.length} lines); nothing was changed.`);
  return hunk.oldStart;
}

/** Applies every hunk, placing each where its lines are, or throws naming the file and the hunk. */
export function applyHunks(file: PatchFile, before: string | null): string {
  const source = before ?? "";
  const ending = endingOf(source);
  const lines = splitLines(source);
  const texts = lines.map((line) => line.text);
  let endsWithNewline = source.length === 0 || source.endsWith("\n");
  const out: FileLine[] = [];
  let cursor = 0;
  for (const hunk of file.hunks) {
    const old = hunk.lines.filter((line) => line.kind !== "+").map((line) => line.text);
    const placed: Placed = old.length ? place(file, hunk, texts, old, afterAnchors(file, hunk, texts, cursor))
      : { at: placeAddition(file, hunk, texts, cursor), tier: 0 };
    out.push(...lines.slice(cursor, placed.at));
    cursor = placed.at;
    // Matched ignoring indentation: new lines move to the file's own indentation, as the context did.
    const shift = placed.tier === 2 ? indentShift(old, texts.slice(placed.at, placed.at + old.length)) : (text: string) => text;
    for (const line of hunk.lines) {
      if (line.kind === "+") { out.push({ text: shift(line.text), eol: ending }); continue; }
      // Context keeps the file's own text and ending, so a whitespace-tolerant match never rewrites it.
      if (line.kind === " ") out.push(lines[cursor]!);
      cursor++;
    }
    if (hunk.endsWithoutNewline) endsWithNewline = cursor >= lines.length ? false : endsWithNewline;
  }
  out.push(...lines.slice(cursor));
  if (!out.length) return "";
  out[out.length - 1] = { ...out.at(-1)!, eol: endsWithNewline ? out.at(-1)!.eol || ending : "" };
  return joinLines(out, ending);
}

function refuse(file: PatchFile, hunk: Hunk, line: number, expected: string): never {
  throw new Error(
    `Patch refused: part ${hunk.index} of the patch for "${file.path}" does not match the file at line ${line}; nothing was changed. `
    + `Its lines were not found anywhere in the file (the first was ${JSON.stringify(expected.slice(0, 120))}). Read the file again and copy the lines exactly.`,
  );
}
