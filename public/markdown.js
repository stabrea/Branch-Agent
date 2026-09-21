import { t } from "./i18n.js";
/**
 * A small markdown renderer that builds DOM nodes, never HTML strings, so nothing a model or a
 * document contains can become markup. Headings, lists, tables, quotes, links, inline code and
 * fenced code blocks (with a copy button and the language written out) are all it knows; anything
 * else stays the plain text it was.
 */
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
/** Only links a browser can safely follow; everything else stays as text. */
const safeHref = (raw) => {
  const href = String(raw ?? "").trim();
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null;
};
/** Desktop opens links in the real browser through its allowlist; the web page uses a new tab. */
function linkNode(label, href) {
  const safe = safeHref(href);
  if (!safe) return document.createTextNode(label);
  const node = el("a", label);
  node.href = safe;
  node.rel = "noreferrer noopener";
  node.target = "_blank";
  node.addEventListener("click", (event) => {
    if (!globalThis.branchDesktop?.openExternal) return;
    event.preventDefault();
    globalThis.branchDesktop.openExternal(safe).catch(() => {});
  });
  return node;
}
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>)]+)/;
/** Bold, italic, inline code, [label](link) and bare links inside one line of prose. */
export function inlineNodes(text) {
  const out = [];
  let rest = String(text ?? "");
  for (let guard = 0; guard < 500 && rest; guard += 1) {
    const hit = INLINE.exec(rest);
    if (!hit) break;
    if (hit.index) out.push(document.createTextNode(rest.slice(0, hit.index)));
    const piece = hit[0];
    if (piece.startsWith("`")) out.push(el("code", piece.slice(1, -1)));
    else if (piece.startsWith("**")) out.push(el("strong", piece.slice(2, -2)));
    else if (piece.startsWith("[")) {
      const split = piece.indexOf("](");
      out.push(linkNode(piece.slice(1, split), piece.slice(split + 2, -1)));
    } else if (piece.startsWith("http")) out.push(linkNode(piece, piece));
    else out.push(el("em", piece.slice(1, -1)));
    rest = rest.slice(hit.index + piece.length);
  }
  if (rest) out.push(document.createTextNode(rest));
  return out.length ? out : [document.createTextNode("")];
}
function paragraph(tag, text, className) {
  const node = el(tag, undefined, className);
  node.append(...inlineNodes(text));
  return node;
}
/**
 * Wave 8: some fenced blocks are worth showing rather than reading — a page, a drawing, a chart,
 * a script the owner may want to run. `public/artifacts.js` registers itself here and is asked
 * first; when it says it does not handle this language, the plain code block is what comes back.
 * Keeping the hook here means this file still knows nothing about frames or charts.
 */
let artifactRenderer = null;
export function setArtifactRenderer(render) { artifactRenderer = render; }

/** A fenced block: the language written out, a copy button, and the code exactly as it came. */
export function codeBlock(code, language) {
  const artifact = artifactRenderer?.(code, String(language ?? "").toLowerCase());
  if (artifact) return artifact;
  return plainCodeBlock(code, language);
}
/** The code exactly as it came, with its language and a copy button. Never anything more. */
export function plainCodeBlock(code, language) {
  const box = el("div", undefined, "code-block");
  const head = el("div", undefined, "code-head");
  head.append(el("span", language || "text", "code-language"));
  const copy = el("button", "Copy", "code-copy");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = t("markdown.status.copyFailed");
    }
    setTimeout(() => { copy.textContent = "Copy"; }, 2000);
  });
  head.append(copy);
  const pre = el("pre", undefined, "code-body");
  pre.append(el("code", code));
  box.append(head, pre);
  return box;
}
/** One table, from the pipe rows that make it up. */
function tableNode(lines) {
  const cells = (line) => line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const table = el("table", undefined, "md-table");
  const head = el("thead"), headRow = el("tr");
  for (const cell of cells(lines[0])) headRow.append(paragraph("th", cell));
  head.append(headRow);
  const body = el("tbody");
  for (const line of lines.slice(2)) {
    const row = el("tr");
    for (const cell of cells(line)) row.append(paragraph("td", cell));
    body.append(row);
  }
  table.append(head, body);
  const scroll = el("div", undefined, "md-table-scroll");
  scroll.append(table);
  return scroll;
}
const isTableHead = (lines, index) =>
  lines[index]?.includes("|") && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1] ?? "");
/** Collects the run of lines that belong to one block starting at `from`. */
function runOf(lines, from, keep) {
  let to = from;
  while (to < lines.length && keep(lines[to])) to += 1;
  return to;
}
function listNode(lines, ordered) {
  const list = el(ordered ? "ol" : "ul", undefined, "md-list");
  for (const line of lines)
    list.append(paragraph("li", line.replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, "")));
  return list;
}
/** The fenced-code, heading, table, list, quote and rule blocks, in the order they appear. */
function block(lines, index, fragment) {
  const line = lines[index];
  const fence = /^\s*```(\S*)\s*$/.exec(line);
  if (fence) {
    const end = runOf(lines, index + 1, (l) => !/^\s*```\s*$/.test(l));
    fragment.append(codeBlock(lines.slice(index + 1, end).join("\n"), fence[1]));
    return end + 1;
  }
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    fragment.append(paragraph("h" + heading[1].length, heading[2], "md-heading"));
    return index + 1;
  }
  if (isTableHead(lines, index)) {
    const end = runOf(lines, index, (l) => l.includes("|"));
    fragment.append(tableNode(lines.slice(index, end)));
    return end;
  }
  for (const [pattern, ordered] of [[/^\s*[-*+]\s+/, false], [/^\s*\d+[.)]\s+/, true]]) {
    if (!pattern.test(line)) continue;
    const end = runOf(lines, index, (l) => pattern.test(l));
    fragment.append(listNode(lines.slice(index, end), ordered));
    return end;
  }
  if (/^\s*>\s?/.test(line)) {
    const end = runOf(lines, index, (l) => /^\s*>\s?/.test(l));
    fragment.append(paragraph("blockquote", lines.slice(index, end).map((l) => l.replace(/^\s*>\s?/, "")).join(" "), "md-quote"));
    return end;
  }
  if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
    fragment.append(el("hr", undefined, "md-rule"));
    return index + 1;
  }
  return -1;
}
/**
 * Turns markdown into a fragment of real nodes. Raw HTML in the source is never parsed: it arrives
 * as text, so `<script>` shows up as characters on the page and nothing runs.
 */
export function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) { index += 1; continue; }
    const after = block(lines, index, fragment);
    if (after > index) { index = after; continue; }
    const end = runOf(lines, index, (l) => l.trim() && !/^\s*(```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(l) && !l.includes("|"));
    const stop = Math.max(end, index + 1);
    fragment.append(paragraph("p", lines.slice(index, stop).join(" "), "md-para"));
    index = stop;
  }
  return fragment;
}
/** Replaces a node's children with the rendered markdown; the single way the app uses this file. */
export function fillMarkdown(target, source) {
  target.replaceChildren(renderMarkdown(source));
  target.classList.add("markdown");
  return target;
}
