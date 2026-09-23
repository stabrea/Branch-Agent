import type { ReadStructure } from "./document-office.js";

/**
 * Emacs Org-mode outlines. Headline stars become Markdown-style headings so passages read the same
 * way a Word or OpenDocument heading does; property drawers, in-file settings (`#+KEYWORD:` lines)
 * and comment lines carry no words worth indexing and are dropped; `[[target][description]]` links
 * become their description, or the bare target when there is none. A `#+BEGIN_...`/`#+END_...`
 * block keeps its body as plain text — this never runs Org babel code, it only reads words — except
 * a `COMMENT` block, whose body is left out the same as a drawer's.
 */
const heading = (level: number, text: string): string => `${"#".repeat(Math.min(6, Math.max(1, level)))} ${text}`;
/** Known TODO-style keywords a headline may open with; anything else is left as part of the title. */
const todoKeywords = new Set(["TODO", "DOING", "NEXT", "IN-PROGRESS", "WAITING", "DONE", "CANCELLED", "CANCELED"]);

function headlineText(raw: string): string {
  const words = raw.trim().split(/\s+/);
  if (words[0] && todoKeywords.has(words[0])) words.shift();
  return words.join(" ")
    .replace(/^\[#[A-Za-z0-9]\]\s*/, "") // a priority cookie, such as [#A]
    .replace(/\s+:[\w@%#:]+:$/, "") // trailing :tag1:tag2: at the end of the line
    .trim();
}
/** `[[target][description]]` becomes its description; `[[target]]` becomes the bare target. */
function linkText(line: string): string {
  return line.replace(/\[\[([^\]]+)\](?:\[([^\]]*)\])?\]/g, (_whole, target: string, described?: string) =>
    (described ?? target).trim() || target);
}

export function readOrg(bytes: Buffer): ReadStructure {
  const lines = bytes.toString("utf8").split(/\r\n|\r|\n/);
  const out: string[] = [];
  let inDrawer = false;
  let block: { kind: string; skip: boolean } | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (block) {
      if (new RegExp(`^#\\+END_${block.kind}\\s*$`, "i").test(trimmed)) { block = null; continue; }
      if (!block.skip) out.push(line);
      continue;
    }
    if (inDrawer) { if (/^:END:\s*$/i.test(trimmed)) inDrawer = false; continue; }
    const beginBlock = /^#\+BEGIN_(\S+)/i.exec(trimmed);
    if (beginBlock) { block = { kind: beginBlock[1]!, skip: beginBlock[1]!.toUpperCase() === "COMMENT" }; continue; }
    if (/^:[A-Za-z][\w-]*:\s*$/.test(trimmed) && trimmed.toUpperCase() !== ":END:") { inDrawer = true; continue; }
    const title = /^#\+TITLE:\s*(.*)$/i.exec(trimmed);
    if (title) { out.push(heading(1, linkText(title[1] ?? ""))); continue; }
    if (/^#\+\S/.test(trimmed)) continue; // another in-file setting, such as #+AUTHOR: or #+OPTIONS:
    if (/^#(\s|$)/.test(trimmed)) continue; // an Org comment line
    const headline = /^(\*+)\s+(.*)$/.exec(line);
    if (headline) { out.push(heading(headline[1]!.length, linkText(headlineText(headline[2]!)))); continue; }
    out.push(linkText(line));
  }
  const text = out.join("\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("This Org file has no readable text in it");
  return { text, tables: [], limits: [] };
}
