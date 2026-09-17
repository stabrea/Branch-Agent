/**
 * Reading a page the way a person looks at it: is the button there, is the box ticked, does the
 * heading say the right thing. A web task is finished or not finished in the page itself, and an
 * answer that describes the page is not the page, so this compares the markup instead of the prose.
 *
 * It is a small reader on purpose. No library, no browser, and a deliberately tiny way of naming
 * an element — a tag, `#an-id`, `.a-class`, `[an-attribute]`, `[an-attribute=a value]`, several of
 * those stuck together for one element, and spaces between them for "somewhere inside". That is
 * enough for every check a saved page needs and it is small enough to be read in one sitting.
 * Anything richer is refused by name rather than half-understood.
 */

export interface HtmlNode {
  tag: string;
  attributes: Record<string, string>;
  children: HtmlNode[];
  /** Every word inside this element and everything under it, with runs of spaces collapsed. */
  text: string;
}

/** Tags that never have anything inside them, so a closing tag is never waited for. */
const empty = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Tags whose contents are text, not markup: a `<` inside them starts nothing. */
const raw = new Set(["script", "style"]);
const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!--?[^>]*>|<\/\s*([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const attributePattern = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/** The attributes written on one tag, names lower-cased, a bare name giving the empty string. */
function readAttributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of source.matchAll(attributePattern))
    out[match[1]!.toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? "");
  return out;
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (value: string): string =>
  value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code = Number(name.startsWith("#x") || name.startsWith("#X") ? `0x${name.slice(2)}` : name.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return entities[name.toLowerCase()] ?? whole;
  });

/** The page as a tree. Unclosed tags are closed by their parent, the way every browser does it. */
export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: "#document", attributes: {}, children: [], text: "" };
  const stack: HtmlNode[] = [root];
  const words: string[][] = [[]];
  let at = 0;
  const addText = (value: string): void => { const t = decode(value).trim(); if (t) words[words.length - 1]!.push(t); };
  for (const match of html.matchAll(tokens)) {
    // A tag inside a <script> or <style> is text, and `open` has already moved past it.
    if (match.index < at) continue;
    addText(html.slice(at, match.index));
    at = match.index + match[0].length;
    if (match[1]) at = close(stack, words, match[1].toLowerCase(), at);
    else if (match[2]) at = open(stack, words, match[2].toLowerCase(), match[3] ?? "", html, at);
  }
  addText(html.slice(at));
  while (stack.length > 1) close(stack, words, stack[stack.length - 1]!.tag, at);
  root.text = words[0]!.join(" ");
  return root;
}

/** Starts an element. A tag that holds text rather than markup swallows up to its closing tag. */
function open(stack: HtmlNode[], words: string[][], tag: string, attributes: string, html: string, at: number): number {
  const node: HtmlNode = { tag, attributes: readAttributes(attributes), children: [], text: "" };
  stack[stack.length - 1]!.children.push(node);
  if (empty.has(tag) || attributes.trimEnd().endsWith("/")) return at;
  if (raw.has(tag)) {
    const end = html.toLowerCase().indexOf(`</${tag}`, at);
    return end < 0 ? html.length : html.indexOf(">", end) + 1;
  }
  stack.push(node);
  words.push([]);
  return at;
}

/** Ends the nearest open element with this name, and gives its words to its parent. */
function close(stack: HtmlNode[], words: string[][], tag: string, at: number): number {
  const depth = stack.map((node) => node.tag).lastIndexOf(tag);
  if (depth < 1) return at;
  while (stack.length > depth) {
    const node = stack.pop()!, mine = words.pop()!;
    node.text = mine.join(" ");
    words[words.length - 1]!.push(node.text);
  }
  return at;
}

interface Simple { tag: string | null; id: string | null; classes: string[]; attributes: { name: string; value: string | null }[] }

/** One element's worth of selector, for example `input.tick[checked]`. */
function parseSimple(part: string): Simple {
  const simple: Simple = { tag: null, id: null, classes: [], attributes: [] };
  // A tag name here has no colon on purpose: it is what makes `li:first-child` refused by name
  // rather than read as a tag called "li:first-child" that matches nothing.
  const pattern = /\[([-\w:.]+)(?:\s*=\s*"?([^\]"]*)"?)?\]|#([-\w]+)|\.([-\w]+)|([a-zA-Z][\w-]*)|\*/g;
  let seen = 0;
  for (const match of part.matchAll(pattern)) {
    seen += match[0].length;
    if (match[1]) simple.attributes.push({ name: match[1].toLowerCase(), value: match[2] === undefined ? null : match[2] });
    else if (match[3]) simple.id = match[3];
    else if (match[4]) simple.classes.push(match[4]);
    else if (match[5]) simple.tag = match[5].toLowerCase();
  }
  if (seen !== part.length) throw new Error(`"${part}" is more than this reader understands. Use a tag, #id, .class, [attribute] or [attribute=value].`);
  return simple;
}

function matches(node: HtmlNode, simple: Simple): boolean {
  if (simple.tag && node.tag !== simple.tag) return false;
  if (simple.id && node.attributes.id !== simple.id) return false;
  const classes = (node.attributes.class ?? "").split(/\s+/);
  if (!simple.classes.every((name) => classes.includes(name))) return false;
  return simple.attributes.every(({ name, value }) =>
    name in node.attributes && (value === null || node.attributes[name] === value));
}

/** Every element in the page the selector names, in the order they appear. */
export function selectAll(html: string, selector: string): HtmlNode[] {
  const parts = selector.trim().split(/\s+/).filter(Boolean).map(parseSimple);
  if (!parts.length) throw new Error("A selector cannot be empty");
  let level: HtmlNode[] = [parseHtml(html)];
  for (const part of parts) level = descendants(level).filter((node) => matches(node, part));
  return level;
}

/** Everything under these nodes, each once, in document order. */
function descendants(nodes: readonly HtmlNode[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  const walk = (node: HtmlNode): void => { for (const child of node.children) { out.push(child); walk(child); } };
  for (const node of nodes) walk(node);
  return out;
}
