/**
 * Replacing a piece of text in a file the way a model means it, not only the way it typed it.
 *
 * Exact matching comes first and is all that runs when it succeeds. Only when the exact text is
 * nowhere in the file does a second pass compare whole lines ignoring trailing whitespace, and a
 * third ignoring indentation as well — the two slips models make most when they copy code back
 * (a tab read as spaces, a line re-indented in the reply). A tolerant match is used only when it
 * finds exactly the expected number of places; the replacement is re-indented to the file's own
 * indentation. A refusal says what to do next: how many times the text appears, or the closest line.
 */
export interface Replaced { after: string; found: number; tolerant: "trailing whitespace" | "indentation" | null }

type Compare = (a: string, b: string) => boolean;
const passes: { name: NonNullable<Replaced["tolerant"]>; same: Compare }[] = [
  { name: "trailing whitespace", same: (a, b) => a.trimEnd() === b.trimEnd() },
  { name: "indentation", same: (a, b) => a.trim() === b.trim() },
];
const indentOf = (line: string): string => /^[ \t]*/.exec(line)![0];

export function replaceText(
  before: string, find: string, replace: string,
  expected: number | "all", refusal: string,
): Replaced {
  const found = before.split(find).length - 1;
  if (found > 0 && (expected === "all" || found === expected))
    return { after: before.split(find).join(replace), found, tolerant: null };
  if (found > 0)
    throw new Error(`${refusal} contains that text ${found} time(s), but ${expected} was expected. `
      + `Include more of the surrounding lines so it matches only once, or set expectedOccurrences to ${found} to change them all.`);
  const tolerant = tolerantReplace(before, find, replace, expected);
  if (tolerant) return tolerant;
  throw new Error(`${refusal} contains that text 0 time(s), but ${expected === "all" ? "at least 1" : expected} was expected.${closest(before, find)}`);
}

function tolerantReplace(before: string, find: string, replace: string, expected: number | "all"): Replaced | null {
  const ending = before.includes("\r\n") ? "\r\n" : "\n";
  const lines = before.replace(/\r\n/g, "\n").split("\n");
  const wanted = find.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (!wanted.some((line) => line.trim())) return null;
  for (const { name, same } of passes) {
    const starts: number[] = [];
    for (let at = 0; at + wanted.length <= lines.length; at++) {
      if (wanted.every((text, i) => same(lines[at + i]!, text))) { starts.push(at); at += wanted.length - 1; }
    }
    if (!starts.length || (expected !== "all" && starts.length !== expected)) continue;
    const out: string[] = [];
    let cursor = 0;
    for (const at of starts) {
      out.push(...lines.slice(cursor, at));
      out.push(...reindent(replace, wanted, lines.slice(at, at + wanted.length), name === "indentation"));
      cursor = at + wanted.length;
    }
    out.push(...lines.slice(cursor));
    return { after: out.join(ending), found: starts.length, tolerant: name };
  }
  return null;
}

/** The replacement's lines, moved from the indentation the model used to the one the file uses. */
function reindent(replace: string, wanted: string[], actual: string[], shift: boolean): string[] {
  const body = replace.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const lines = body === "" ? [] : body.split("\n");
  if (!shift) return lines;
  // Each indentation the model used, paired with the one the file really has on the same line.
  const map = new Map<string, string>();
  wanted.forEach((line, i) => {
    if (line.trim() && !map.has(indentOf(line))) map.set(indentOf(line), indentOf(actual[i]!));
  });
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  return lines.map((line) => {
    const key = keys.find((indent) => line.startsWith(indent));
    return key === undefined ? line : map.get(key)! + line.slice(key.length);
  });
}

/** One line of help: the line in the file that looks most like the first line being looked for. */
function closest(before: string, find: string): string {
  const first = find.split("\n").map((line) => line.trim()).find(Boolean);
  if (!first) return "";
  const lines = before.split(/\r?\n/);
  let best = -1, score = 0;
  lines.forEach((line, i) => {
    const text = line.trim();
    let shared = 0;
    while (shared < text.length && shared < first.length && text[shared] === first[shared]) shared++;
    const value = text.includes(first) || first.includes(text) && text.length > 3 ? first.length : shared;
    if (value > score) { score = value; best = i; }
  });
  if (best < 0 || score < Math.min(6, first.length)) return " Read the file again and copy the text exactly.";
  return ` The closest line is ${best + 1}: ${JSON.stringify(lines[best]!.slice(0, 160))}. Read the file again and copy the text exactly.`;
}
