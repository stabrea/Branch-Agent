/**
 * Small per-language readers that pick out the names a file declares and the files it pulls in.
 * These are regular expressions, not parsers: they read what a line looks like, so a name inside a
 * comment or a string can be picked up, and anything spread over several lines can be missed. That
 * is the trade: no build step and no extra program to install, in return for a map that is good
 * enough to say "the answer is probably in one of these five files".
 */
export interface SourceSymbol { name: string; kind: string; line: number }
export interface Scan { symbols: SourceSymbol[]; imports: string[] }

const maxSymbols = 60, maxImports = 40;

/** The kind of file, from its ending. Only the ones with a reader of their own are named here. */
const extensions: Record<string, string> = {
  ".ts": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript", ".tsx": "TypeScript",
  ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript",
  ".py": "Python", ".pyi": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java",
  ".cs": "C#", ".md": "Markdown", ".markdown": "Markdown",
};
export function mapLanguageOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot > 0 ? extensions[path.slice(dot).toLowerCase()] : undefined) ?? "Other";
}

type Kind = string | ((match: RegExpExecArray) => string);
/** Runs one expression line by line and records the name it found and where it was. */
function collect(text: string, pattern: RegExp, kind: Kind, group = 1): SourceSymbol[] {
  const found: SourceSymbol[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length && found.length < maxSymbols; index++) {
    const line = lines[index]!;
    if (line.length > 400) continue;
    const match = pattern.exec(line);
    if (!match?.[group]) continue;
    found.push({ name: match[group]!.slice(0, 120), kind: typeof kind === "string" ? kind : kind(match), line: index + 1 });
  }
  return found;
}
/** Every target named by an import-style line, in order, without repeats. */
function collectImports(text: string, pattern: RegExp): string[] {
  const imports: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (imports.length >= maxImports) break;
    const match = pattern.exec(line);
    const target = match?.[1] ?? match?.[2];
    if (target) imports.push(target);
  }
  return imports;
}

const scriptDeclaration =
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const scriptImport = /^\s*(?:import\b[^'"]*|export\b[^'"]*from\s*)['"]([^'"]{1,200})['"]|require\(\s*['"]([^'"]{1,200})['"]\s*\)/;
const kindOf = (word: string): string =>
  word.startsWith("function") ? "function" : word === "const" || word === "let" || word === "var" ? "value" : word;
const scriptScan = (text: string): Scan => ({
  symbols: collect(text, scriptDeclaration, (match) => kindOf(match[1]!), 2),
  imports: collectImports(text, scriptImport),
});

const pythonImport = /^\s*(?:from\s+([.\w]{1,200})\s+import\b|import\s+([.\w]{1,200}))/;
const pythonScan = (text: string): Scan => ({
  symbols: collect(text, /^\s*(class|def|async\s+def)\s+([A-Za-z_]\w*)/, (m) => (m[1] === "class" ? "class" : "function"), 2),
  imports: collectImports(text, pythonImport),
});

const readers: Record<string, (text: string) => Scan> = {
  TypeScript: scriptScan,
  JavaScript: scriptScan,
  Python: pythonScan,
  Go: (text) => ({
    symbols: [
      ...collect(text, /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, "function"),
      ...collect(text, /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface|\w)/, "type"),
    ].slice(0, maxSymbols),
    imports: [],
  }),
  Rust: (text) => ({
    symbols: collect(text, /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|mod)\s+([A-Za-z_]\w*)/, (m) => (m[1] === "fn" ? "function" : m[1]!), 2),
    imports: [],
  }),
  Java: (text) => ({
    symbols: collect(text, /^\s*(?:(?:public|protected|private|abstract|final|static)\s+)*(class|interface|enum|record)\s+([A-Za-z_]\w*)/, (m) => m[1]!, 2),
    imports: [],
  }),
  "C#": (text) => ({
    symbols: collect(text, /^\s*(?:(?:public|internal|protected|private|abstract|sealed|static|partial)\s+)*(class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/, (m) => m[1]!, 2),
    imports: [],
  }),
  Markdown: (text) => ({
    symbols: collect(text, /^(#{1,3})\s+(.{1,120})$/, (m) => `heading${m[1]!.length}`, 2),
    imports: [],
  }),
};

/** What one file declares and what it pulls in, or nothing when there is no reader for its kind. */
export function scanSource(path: string, text: string): Scan {
  const reader = readers[mapLanguageOf(path)];
  if (!reader) return { symbols: [], imports: [] };
  const scan = reader(text);
  return { symbols: scan.symbols.slice(0, maxSymbols), imports: [...new Set(scan.imports)].slice(0, maxImports) };
}
