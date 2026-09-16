/**
 * A small unified-diff reader and applier with no guessing: every context and removed line must be
 * exactly what the file holds at the line the patch names, or the patch is refused and says which
 * file and which part of it did not fit.
 */
export interface PatchLine { kind: " " | "-" | "+"; text: string }
export interface Hunk { index: number; oldStart: number; lines: PatchLine[]; endsWithoutNewline: boolean }
export interface PatchFile { path: string; created: boolean; hunks: Hunk[] }

const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(text: string): PatchFile[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
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
    if (to.includes("..")) throw new Error(`Patch refused: "${to}" is not a workspace path`);
    at += 2;
    const hunks: Hunk[] = [];
    while (at < lines.length && header.test(lines[at]!)) at = readHunk(lines, at, hunks);
    if (!hunks.length) throw new Error(`Patch refused: "${to}" has no changes in the patch`);
    files.push({ path: to, created: from === null, hunks });
  }
  if (!files.length) throw new Error("Patch refused: no file headers (\"--- \"/\"+++ \") were found");
  return files;
}

/** The workspace path a diff header names, or null for the "no such file" marker. */
function target(spec: string): string | null {
  const raw = spec.split("\t")[0]!.trim().replace(/^"|"$/g, "");
  if (raw === "/dev/null") return null;
  const stripped = raw.replace(/^[ab]\//, "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!stripped) throw new Error("Patch refused: a file header has no path");
  return stripped;
}

/** Reads one hunk using its declared line counts, so a body line starting with "-" is unambiguous. */
function readHunk(lines: string[], at: number, hunks: Hunk[]): number {
  const match = header.exec(lines[at]!)!;
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  const hunk: Hunk = { index: hunks.length + 1, oldStart: Number(match[1]), lines: [], endsWithoutNewline: false };
  let seenOld = 0, seenNew = 0, cursor = at + 1;
  while ((seenOld < oldCount || seenNew < newCount) && cursor < lines.length) {
    const body = lines[cursor++]!;
    if (body.startsWith("\\")) { hunk.endsWithoutNewline = true; continue; }
    const kind = (body === "" ? " " : body[0]!) as PatchLine["kind"];
    if (kind !== " " && kind !== "-" && kind !== "+")
      throw new Error(`Patch refused: unexpected line "${body.slice(0, 40)}" inside a change`);
    if (kind !== "+") seenOld++;
    if (kind !== "-") seenNew++;
    hunk.lines.push({ kind, text: body === "" ? "" : body.slice(1) });
  }
  if (seenOld !== oldCount || seenNew !== newCount)
    throw new Error(`Patch refused: part ${hunk.index} of the patch ends before its declared ${oldCount} and ${newCount} lines`);
  hunks.push(hunk);
  return cursor;
}

/** Applies every hunk at exactly the line it names, or throws naming the file and the hunk. */
export function applyHunks(file: PatchFile, before: string | null): string {
  const source = before ?? "";
  const ending = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.length ? source.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
  let endsWithNewline = source.length === 0 || source.endsWith("\n");
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of file.hunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    if (start < cursor || start > lines.length) refuse(file, hunk, start + 1);
    out.push(...lines.slice(cursor, start));
    cursor = start;
    for (const line of hunk.lines) {
      if (line.kind === "+") { out.push(line.text); continue; }
      if (lines[cursor] !== line.text) refuse(file, hunk, cursor + 1);
      if (line.kind === " ") out.push(line.text);
      cursor++;
    }
    if (hunk.endsWithoutNewline) endsWithNewline = cursor >= lines.length ? false : endsWithNewline;
  }
  out.push(...lines.slice(cursor));
  return out.length ? out.join(ending) + (endsWithNewline ? ending : "") : "";
}

function refuse(file: PatchFile, hunk: Hunk, line: number): never {
  throw new Error(
    `Patch refused: part ${hunk.index} of the patch for "${file.path}" does not match the file at line ${line}; nothing was changed`,
  );
}
