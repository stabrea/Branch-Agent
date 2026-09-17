/**
 * Reading a source file the way a repository map needs it (A0334, A0537): which names the file
 * defines, where, inside what, and which names it uses.
 *
 * Aider does this with tree-sitter grammars. Branch keeps its no-extra-program rule and does it with
 * a small tokenizer instead: comments and strings are blanked first (so a name in a comment or a
 * string never counts, and a declaration spread over lines keeps its line number), then each line of
 * what is left is matched against a handful of declaration shapes per language, and every remaining
 * word is counted as a use. Aider itself counts uses this way (by lexer tokens) whenever a grammar's
 * query names no references, so the graph built from this is the same kind of graph.
 *
 * What it still cannot do: understand a declaration whose name is computed, or tell two things with
 * the same name apart. The map is for finding your way around, not for deciding what code means.
 */
export interface CodeTag {
  name: string;
  kind: string;
  /** 1-based line of the declaration. */
  line: number;
  /** The declaration's own line, as written (trimmed on the right, at most 100 characters). */
  text: string;
  /** Index (in the same list) of the declaration this one sits inside, or -1. */
  parent: number;
}
export interface TagScan { defs: CodeTag[]; refs: Map<string, number> }

type Family = "brace" | "hash" | "markup";
interface LanguageRules { family: Family; shapes: Shape[]; nested: "braces" | "indent"; lifetimes?: boolean }
/** One declaration shape: the pattern, the capture holding the name, and the kind it stands for. */
interface Shape { pattern: RegExp; name: number; kind: string | ((m: RegExpExecArray) => string); topOnly?: boolean; inside?: string[] }

const maxDefs = 400, maxRefNames = 3000, maxLineChars = 100;

const scriptKind = (word: string): string =>
  word.startsWith("function") ? "function" : ["const", "let", "var"].includes(word) ? "value" : word;
const modifiers = "(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial|override|virtual|async|readonly|open|inline|export|default|declare|unsafe|extern|const)\\s+)*";

const script: LanguageRules = {
  family: "brace", nested: "braces", shapes: [
    { pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/, name: 2, kind: (m) => scriptKind(m[1]!) },
    { pattern: /^\s*(?:export\s+)?(?:declare\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)/, name: 2, kind: "value", topOnly: true },
    { pattern: /^\s*(?:(?:public|private|protected|static|async|readonly|abstract|override|get|set|declare)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/, name: 1, kind: "method", inside: ["class"] },
  ],
};
const python: LanguageRules = {
  family: "hash", nested: "indent", shapes: [
    { pattern: /^\s*(class|def|async\s+def)\s+([A-Za-z_]\w*)/, name: 2, kind: (m) => (m[1] === "class" ? "class" : "function") },
  ],
};
const ruby: LanguageRules = {
  family: "hash", nested: "indent", shapes: [
    { pattern: /^\s*(class|module|def)\s+(?:self\.)?([A-Za-z_][\w]*[?!=]?)/, name: 2, kind: (m) => (m[1] === "def" ? "function" : m[1]!) },
  ],
};
const go: LanguageRules = {
  family: "brace", nested: "braces", shapes: [
    { pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, name: 1, kind: "function" },
    { pattern: /^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface|\w)/, name: 1, kind: (m) => (m[2] === "struct" || m[2] === "interface" ? m[2] : "type") },
  ],
};
const rust: LanguageRules = {
  family: "brace", nested: "braces", lifetimes: true, shapes: [
    { pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|const|unsafe|extern)\s+)*(fn|struct|enum|trait|mod|type|union)\s+([A-Za-z_]\w*)/, name: 2, kind: (m) => (m[1] === "fn" ? "function" : m[1]!) },
    { pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(const|static)\s+([A-Za-z_]\w*)\s*:/, name: 2, kind: "value", topOnly: true },
    { pattern: /^\s*(?:unsafe\s+)?impl(?:<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?([A-Za-z_]\w*)/, name: 1, kind: "impl" },
  ],
};
/** Java, C#, Kotlin, Swift, Scala and PHP share the "modifiers, keyword, name" shape. */
const typeWords = "class|interface|enum|record|struct|trait|object|protocol|extension|module";
const statementWords = new Set(["if", "for", "foreach", "while", "switch", "catch", "return", "new", "throw", "else", "using", "lock", "await", "yield", "do", "when", "sizeof", "typeof", "nameof", "super", "this", "base"]);
const javaLike = (functionWord: string): LanguageRules => ({
  family: "brace", nested: "braces", shapes: [
    { pattern: new RegExp(`^\\s*(?:@\\w+\\s+)*${modifiers}(?:data\\s+|case\\s+|enum\\s+)?(${typeWords})\\s+([A-Za-z_]\\w*)`), name: 2, kind: (m) => m[1]! },
    ...(functionWord ? [{ pattern: new RegExp(`^\\s*${modifiers}${functionWord}\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?([A-Za-z_]\\w*)`), name: 1, kind: "function" }] : []),
    { pattern: new RegExp(`^\\s*${modifiers}(?:<[^>]*>\\s*)?([\\w.<>\\[\\],?]+)\\s+([A-Za-z_]\\w*)\\s*\\([^)=;]*\\)?[^=;{]*(?:\\{.*)?$`), name: 2, kind: "method", inside: ["class", "interface", "enum", "record", "struct", "object", "trait"] },
  ],
});
const cLike: LanguageRules = {
  family: "brace", nested: "braces", shapes: [
    { pattern: /^\s*(?:typedef\s+)?(struct|class|enum|union|namespace)\s+([A-Za-z_]\w*)\s*(?:[:{]|$)/, name: 2, kind: (m) => m[1]! },
    { pattern: /^\s*#\s*define\s+([A-Za-z_]\w*)/, name: 1, kind: "macro" },
    { pattern: /^[A-Za-z_][\w\s\*&:<>,]*?[\s\*&]([A-Za-z_][\w]*(?:::~?[A-Za-z_]\w*)*)\s*\([^;]*$/, name: 1, kind: "function", topOnly: true },
  ],
};
const markdown: LanguageRules = {
  family: "markup", nested: "indent", shapes: [
    { pattern: /^(#{1,3})\s+(.{1,120})$/, name: 2, kind: (m) => `heading${m[1]!.length}` },
  ],
};

const rulesByExtension: Record<string, LanguageRules> = {
  ".ts": script, ".mts": script, ".cts": script, ".tsx": script, ".js": script, ".mjs": script, ".cjs": script, ".jsx": script,
  ".py": python, ".pyi": python, ".rb": ruby, ".go": go, ".rs": rust,
  ".java": javaLike(""), ".cs": javaLike(""), ".kt": javaLike("fun"), ".kts": javaLike("fun"), ".swift": javaLike("func"),
  ".scala": javaLike("def"), ".php": javaLike("function"),
  ".c": cLike, ".h": cLike, ".cc": cLike, ".cpp": cLike, ".cxx": cLike, ".hpp": cLike, ".hh": cLike,
  ".md": markdown, ".markdown": markdown,
};
const languageNames: Record<string, string> = {
  ".rb": "Ruby", ".kt": "Kotlin", ".kts": "Kotlin", ".swift": "Swift", ".scala": "Scala", ".php": "PHP",
  ".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".cxx": "C++", ".hpp": "C++", ".hh": "C++",
};
const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") ? path.slice(dot).toLowerCase() : "";
};
/** The name of a language this file reads beyond the older scanners' list, or undefined. */
export function extraLanguageOf(path: string): string | undefined { return languageNames[extensionOf(path)]; }
export function hasTagRules(path: string): boolean { return extensionOf(path) in rulesByExtension; }
/** How comments and strings look in this file, for a check that must skip them; undefined for prose or unknown files. */
export function noiseStyleOf(path: string): { family: Family; lifetimes: boolean } | undefined {
  const rules = rulesByExtension[extensionOf(path)];
  return rules && rules.family !== "markup" ? { family: rules.family, lifetimes: Boolean(rules.lifetimes) } : undefined;
}

/**
 * The same text with every comment and string replaced by spaces, newlines kept, so positions and
 * line numbers still match the file. Template literals and triple-quoted strings are blanked whole.
 */
export function blankNoise(text: string, family: Family, lifetimes = false): string {
  if (family === "markup") return blankFences(text);
  const out: string[] = [];
  let index = 0;
  const keep = (from: number, to: number, blank: boolean) =>
    out.push(blank ? text.slice(from, to).replace(/[^\n]/g, " ") : text.slice(from, to));
  while (index < text.length) {
    const end = noiseEnd(text, index, family, lifetimes);
    if (end > index) { keep(index, end, true); index = end; continue; }
    let next = index + 1;
    while (next < text.length && !startsNoise(text, next, family)) next++;
    keep(index, next, false);
    index = next;
  }
  return out.join("");
}
const startsNoise = (text: string, at: number, family: Family): boolean => {
  const c = text[at]!;
  if (c === '"' || c === "`") return true;
  if (c === "'") return true;
  if (family === "hash") return c === "#";
  return c === "/" && (text[at + 1] === "/" || text[at + 1] === "*");
};
/** Where the comment or string starting at `at` ends, or `at` when nothing starts there. */
function noiseEnd(text: string, at: number, family: Family, lifetimes: boolean): number {
  const c = text[at]!, two = text.slice(at, at + 2), three = text.slice(at, at + 3);
  const lineEnd = () => { const n = text.indexOf("\n", at); return n < 0 ? text.length : n; };
  if (family === "brace" && two === "//") return lineEnd();
  if (family === "brace" && two === "/*") { const n = text.indexOf("*/", at + 2); return n < 0 ? text.length : n + 2; }
  if (family === "hash" && c === "#") return lineEnd();
  if (family === "hash" && (three === '"""' || three === "'''")) { const n = text.indexOf(three, at + 3); return n < 0 ? text.length : n + 3; }
  if (c === "`") return quotedEnd(text, at, "`", true);
  if (c === '"') return quotedEnd(text, at, '"', false);
  if (c === "'") {
    // In Rust, 'a is a lifetime and only a closed one-character run such as 'x' or '\n' is a string.
    if (lifetimes && /^'[A-Za-z_]\w*[^'\w]/.test(text.slice(at, at + 40))) return at + 1;
    return quotedEnd(text, at, "'", false);
  }
  return at;
}
function quotedEnd(text: string, at: number, quote: string, multiline: boolean): number {
  let index = at + 1;
  while (index < text.length) {
    const c = text[index]!;
    if (c === "\\") { index += 2; continue; }
    if (c === quote) return index + 1;
    if (c === "\n" && !multiline) return index;
    index++;
  }
  return text.length;
}
/** In Markdown only fenced code is noise: a heading inside a code sample is not a heading. */
function blankFences(text: string): string {
  let inside = false;
  return text.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inside = !inside; return ""; }
    return inside ? "" : line;
  }).join("\n");
}

const keywords = new Set([
  ...statementWords, "function", "class", "interface", "type", "enum", "const", "let", "var", "import", "export", "from",
  "default", "extends", "implements", "public", "private", "protected", "static", "async", "true", "false", "null",
  "undefined", "void", "def", "self", "None", "True", "False", "and", "or", "not", "in", "is", "pass", "lambda", "elif",
  "with", "as", "try", "except", "finally", "raise", "break", "continue", "func", "package", "struct", "fn", "pub",
  "impl", "mut", "use", "mod", "match", "string", "int", "bool", "end", "then", "case", "of", "readonly", "delete",
  "instanceof", "keyof", "any", "number", "boolean", "unknown", "never", "object", "final", "override", "val", "fun",
]);

/** Every declaration and every used name in one file. */
export function tagSource(path: string, text: string): TagScan {
  const rules = rulesByExtension[extensionOf(path)];
  if (!rules) return { defs: [], refs: new Map() };
  const clean = blankNoise(text, rules.family, rules.lifetimes);
  const cleanLines = clean.split("\n");
  const rawLines = text.split("\n");
  const defs = rules.nested === "braces" ? braceDefs(rules, cleanLines, rawLines) : indentDefs(rules, cleanLines, rawLines);
  return { defs, refs: rules.family === "markup" ? new Map() : countNames(clean) };
}

function countNames(clean: string): Map<string, number> {
  const refs = new Map<string, number>();
  for (const match of clean.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = match[0];
    if (name.length < 2 || keywords.has(name)) continue;
    if (!refs.has(name) && refs.size >= maxRefNames) continue;
    refs.set(name, (refs.get(name) ?? 0) + 1);
  }
  return refs;
}

/** Tries each shape on one cleaned line, given the kind of the declaration it sits inside. */
function matchLine(rules: LanguageRules, line: string, top: boolean, parentKind: string | undefined): { name: string; kind: string } | null {
  if (line.length > 400 || !line.trim()) return null;
  for (const shape of rules.shapes) {
    if (shape.topOnly && !top) continue;
    if (shape.inside && !shape.inside.includes(parentKind ?? "")) continue;
    const match = shape.pattern.exec(line);
    const name = match?.[shape.name];
    if (!match || !name || statementWords.has(name) || (keywords.has(name) && shape.kind !== "method")) continue;
    if (shape.inside && keywords.has(name)) continue;
    return { name: name.slice(0, 120), kind: typeof shape.kind === "string" ? shape.kind : shape.kind(match) };
  }
  return null;
}
const lineText = (raw: string | undefined): string => (raw ?? "").replace(/\s+$/, "").slice(0, maxLineChars);

/** Declarations in a language whose blocks are braces: a stack of open blocks gives each one its parent. */
function braceDefs(rules: LanguageRules, clean: string[], raw: string[]): CodeTag[] {
  const defs: CodeTag[] = [];
  const open: Opened[] = [];
  const state = { depth: 0 };
  for (let index = 0; index < clean.length && defs.length < maxDefs; index++) {
    const line = clean[index]!;
    const parent = [...open].reverse().find((entry) => entry.opened)?.def ?? -1;
    const found = matchLine(rules, line, state.depth === 0, parent >= 0 ? defs[parent]!.kind : undefined);
    if (found) {
      // A declaration that never opened a block (a value, a signature) ends where the next one starts.
      while (open.length && !open[open.length - 1]!.opened) open.pop();
      defs.push({ ...found, line: index + 1, text: lineText(raw[index]), parent });
      open.push({ def: defs.length - 1, depth: state.depth, opened: false });
    }
    followBraces(line, open, state);
    const top = open[open.length - 1];
    if (top && !top.opened && /;\s*$/.test(line)) open.pop();
  }
  return defs;
}
interface Opened { def: number; depth: number; opened: boolean }
/** Moves the depth through one line, opening the newest declaration's block and closing finished ones. */
function followBraces(line: string, open: Opened[], state: { depth: number }): void {
  for (const c of line) {
    if (c === "{") {
      const top = open[open.length - 1];
      if (top && !top.opened && top.depth === state.depth) top.opened = true;
      state.depth++;
    } else if (c === "}") {
      state.depth = Math.max(0, state.depth - 1);
      while (open.length && open[open.length - 1]!.depth >= state.depth) open.pop();
    }
  }
}

/** Declarations in a language whose blocks are indented: a line at or left of a declaration ends it. */
function indentDefs(rules: LanguageRules, clean: string[], raw: string[]): CodeTag[] {
  const defs: CodeTag[] = [];
  const open: { def: number; indent: number }[] = [];
  const markup = rules.family === "markup";
  for (let index = 0; index < clean.length && defs.length < maxDefs; index++) {
    const line = clean[index]!;
    if (!line.trim()) continue;
    const indent = markup ? headingLevel(line) : /^\s*/.exec(line)![0].length;
    if (markup && indent === 0) continue;
    while (open.length && indent <= open[open.length - 1]!.indent) open.pop();
    const parent = open.length ? open[open.length - 1]!.def : -1;
    const found = matchLine(rules, line, indent === 0, parent >= 0 ? defs[parent]!.kind : undefined);
    if (!found) continue;
    defs.push({ ...found, line: index + 1, text: lineText(raw[index]), parent });
    open.push({ def: defs.length - 1, indent });
  }
  return defs;
}
const headingLevel = (line: string): number => /^(#{1,6})\s/.exec(line)?.[1]!.length ?? 0;
