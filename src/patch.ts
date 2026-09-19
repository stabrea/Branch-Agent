/**
 * A small unified-diff reader and applier. It is strict about *what* changes and forgiving about
 * *where*: every context and removed line must be in the file, but a hunk whose line number is off,
 * whose declared line counts are wrong, or whose header carries no numbers at all is still placed —
 * by searching for its lines, nearest to where the patch said, first exactly and then ignoring
 * trailing and then leading whitespace. That is what `git apply`/`patch` do with offsets and what
 * models get wrong most often. When the lines are nowhere in the file the patch is refused, naming
 * the file and the part, and nothing is written.
 *
 * Also reads the `*** Begin Patch` / `*** Update File:` form some models are trained to write.
 */
export interface PatchLine { kind: " " | "-" | "+"; text: string }
/** `oldStart` is null when the hunk header gave no line number. */
export interface Hunk { index: number; oldStart: number | null; lines: PatchLine[]; endsWithoutNewline: boolean }
export interface PatchFile { path: string; created: boolean; hunks: Hunk[] }

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
    files.push({ path: to, created: from === null, hunks });
  }
  if (!files.length) throw new Error("Patch refused: no file headers (\"--- \"/\"+++ \") were found");
  return files;
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
  const hunk: Hunk = { index: hunks.length + 1, oldStart: match ? Number(match[1]) : null, lines: [], endsWithoutNewline: false };
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
    const path = target((update ?? add)![1]!)!;
    checkPath(path);
    at++;
    if (add) {
      const added: PatchLine[] = [];
      while (at < lines.length && !lines[at]!.startsWith("*** ")) {
        const text = lines[at++]!;
        if (text.startsWith("+")) added.push({ kind: "+", text: text.slice(1) });
      }
      files.push({ path, created: true, hunks: [{ index: 1, oldStart: 1, lines: added, endsWithoutNewline: false }] });
      continue;
    }
    const hunks: Hunk[] = [];
    // The first hunk of an Update may start without its own "@@".
    if (at < lines.length && !isHunkHeader(lines[at]!) && !lines[at]!.startsWith("*** ")) {
      lines.splice(at, 0, "@@");
    }
    while (at < lines.length && isHunkHeader(lines[at]!)) at = readHunk(lines, at, hunks);
    if (!hunks.length) throw new Error(`Patch refused: "${path}" has no changes in the patch`);
    files.push({ path, created: false, hunks });
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

/** Where the hunk's old lines sit: at the named line if they fit there, else nearest to it. */
function locate(lines: string[], old: string[], hint: number, cursor: number): { at: number; same: Compare } | null {
  for (const same of comparisons) {
    const fits = (at: number): boolean => old.every((text, i) => lines[at + i] !== undefined && same(lines[at + i]!, text));
    if (hint >= cursor && fits(hint)) return { at: hint, same };
    let best = -1;
    for (let at = cursor; at + old.length <= lines.length; at++)
      if (fits(at) && (best < 0 || Math.abs(at - hint) < Math.abs(best - hint))) best = at;
    if (best >= 0) return { at: best, same };
  }
  return null;
}

/** Applies every hunk, placing each where its lines are, or throws naming the file and the hunk. */
export function applyHunks(file: PatchFile, before: string | null): string {
  const source = before ?? "";
  const ending = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.length ? source.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
  let endsWithNewline = source.length === 0 || source.endsWith("\n");
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of file.hunks) {
    const old = hunk.lines.filter((line) => line.kind !== "+").map((line) => line.text);
    const hint = hunk.oldStart === null ? cursor : Math.max(0, hunk.oldStart - (old.length ? 1 : 0));
    let start: number;
    if (!old.length) {
      start = Math.min(Math.max(hint, cursor), lines.length);
    } else {
      const found = locate(lines, old, hint, cursor);
      if (!found) refuse(file, hunk, Math.min(Math.max(hint, cursor), lines.length) + 1, old[0]!);
      start = found.at;
    }
    out.push(...lines.slice(cursor, start));
    cursor = start;
    for (const line of hunk.lines) {
      if (line.kind === "+") { out.push(line.text); continue; }
      // Context keeps the file's own text, so a whitespace-tolerant match never rewrites it.
      if (line.kind === " ") out.push(lines[cursor]!);
      cursor++;
    }
    if (hunk.endsWithoutNewline) endsWithNewline = cursor >= lines.length ? false : endsWithNewline;
  }
  out.push(...lines.slice(cursor));
  return out.length ? out.join(ending) + (endsWithNewline ? ending : "") : "";
}

function refuse(file: PatchFile, hunk: Hunk, line: number, expected: string): never {
  throw new Error(
    `Patch refused: part ${hunk.index} of the patch for "${file.path}" does not match the file at line ${line}; nothing was changed. `
    + `Its lines were not found anywhere in the file (the first was ${JSON.stringify(expected.slice(0, 120))}). Read the file again and copy the lines exactly.`,
  );
}
