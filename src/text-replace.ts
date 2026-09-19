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

/** One line of a file with the ending it really has ("" for a last line with none), so untouched lines keep theirs. */
export interface FileLine { text: string; eol: string }
export function splitLines(source: string): FileLine[] {
  const parts = source.split("\n");
  const lines = parts.map((part, i): FileLine => i === parts.length - 1 ? { text: part, eol: "" }
    : part.endsWith("\r") ? { text: part.slice(0, -1), eol: "\r\n" } : { text: part, eol: "\n" });
  if (lines.at(-1)?.text === "") lines.pop();
  return lines;
}
/** Lines back into text: a line that was last and now is not gets the file's usual ending. */
export function joinLines(lines: readonly FileLine[], ending: string): string {
  return lines.map((line, i) => line.text + (i < lines.length - 1 ? line.eol || ending : line.eol)).join("");
}
/** The file's usual line ending. */
export const endingOf = (source: string): string => source.includes("\r\n") ? "\r\n" : "\n";
/** A file whose every line ends in CRLF: text the model sends with plain newlines is fitted to it. */
const allCrlf = (source: string): boolean => source.includes("\r\n") && !/(^|[^\r])\n/.test(source);

export function replaceText(
  before: string, rawFind: string, rawReplace: string,
  expected: number | "all", refusal: string,
): Replaced {
  const fit = (text: string): string => allCrlf(before) ? text.replace(/\r?\n/g, "\r\n") : text;
  const find = fit(rawFind), replace = fit(rawReplace);
  // An empty `find` means "add this": it goes on the end of the file.
  if (find === "") return { after: before + (before && !before.endsWith("\n") ? endingOf(before) : "") + replace, found: 1, tolerant: null };
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
  const ending = endingOf(before);
  const lines = splitLines(before);
  const wanted = find.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (!wanted.some((line) => line.trim())) return null;
  const body = replace.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const added = body === "" ? [] : body.split("\n");
  for (const { name, same } of passes) {
    const starts: number[] = [];
    for (let at = 0; at + wanted.length <= lines.length; at++) {
      if (wanted.every((text, i) => same(lines[at + i]!.text, text))) { starts.push(at); at += wanted.length - 1; }
    }
    if (!starts.length || (expected !== "all" && starts.length !== expected)) continue;
    const out: FileLine[] = [];
    let cursor = 0;
    for (const at of starts) {
      out.push(...lines.slice(cursor, at));
      const matched = lines.slice(at, at + wanted.length);
      const shift = name === "indentation" ? indentShift(wanted, matched.map((line) => line.text)) : (text: string) => text;
      // The new lines take the file's ending; the last keeps the ending the replaced block had.
      out.push(...added.map((text, i): FileLine => ({ text: shift(text), eol: i === added.length - 1 ? matched.at(-1)!.eol : ending })));
      cursor = at + wanted.length;
    }
    out.push(...lines.slice(cursor));
    return { after: joinLines(out, ending), found: starts.length, tolerant: name };
  }
  return null;
}

/**
 * Moves a line from the indentation the model used to the one the file uses, given the model's
 * lines and the file's lines they were matched against, pair by pair.
 */
export function indentShift(wanted: readonly string[], actual: readonly string[]): (line: string) => string {
  const map = new Map<string, string>();
  wanted.forEach((line, i) => {
    if (line.trim() && !map.has(indentOf(line))) map.set(indentOf(line), indentOf(actual[i] ?? ""));
  });
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  return (line) => {
    const key = keys.find((indent) => line.startsWith(indent));
    return key === undefined ? line : map.get(key)! + line.slice(key.length);
  };
}

/**
 * Help for a refused edit: the file's own text where the model was most likely aiming, so it can copy
 * it exactly. A one-line hint was not enough — on the coding bench qwen3:14b sent the same invented
 * text four times over after being shown only the closest line; it had never read the file.
 */
function closest(before: string, find: string): string {
  const first = find.split("\n").map((line) => line.trim()).find(Boolean);
  const lines = before.split(/\r?\n/);
  let best = -1, score = 0;
  if (first) lines.forEach((line, i) => {
    const text = line.trim();
    let shared = 0;
    while (shared < text.length && shared < first.length && text[shared] === first[shared]) shared++;
    const value = text.includes(first) || first.includes(text) && text.length > 3 ? first.length : shared;
    if (value > score) { score = value; best = i; }
  });
  const found = best >= 0 && score >= Math.min(6, first?.length ?? 0);
  const span = find.split("\n").length;
  const from = found ? Math.max(0, best - 3) : 0;
  const to = found ? Math.min(lines.length, best + span + 3) : Math.min(lines.length, 20);
  let excerpt = lines.slice(from, to).join("\n");
  if (excerpt.length > 1500) excerpt = `${excerpt.slice(0, 1500)}…`;
  const where = found ? `The closest line is ${best + 1}: ${JSON.stringify(lines[best]!.slice(0, 160))}. ` : "";
  return ` ${where}The file's lines ${from + 1}-${to} read exactly:\n${excerpt}\nCopy \`find\` from this text.`;
}
