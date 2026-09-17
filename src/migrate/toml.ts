/**
 * Enough of TOML to read Codex's `config.toml`: tables and dotted table names, dotted keys, basic,
 * literal and multi-line strings, numbers, booleans, dates as text, arrays (across lines) and
 * inline tables. Arrays of tables (`[[...]]`) are read past. Anything it cannot read makes it give
 * up on the whole file with an error, rather than guess at what a setting meant.
 */
type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Table = { [key: string]: Value };

/** Names that would reach into JavaScript's own objects rather than make a table entry. */
const forbiddenNames = new Set(["__proto__", "constructor", "prototype"]);
/** How deeply arrays and inline tables may nest, so a hostile file cannot exhaust the stack. */
const maximumDepth = 32;

class Reader {
  position = 0;
  depth = 0;
  constructor(readonly text: string) {}
  fail(what: string): never { throw new Error(`config.toml could not be read: ${what} near character ${this.position}`); }
  peek(offset = 0): string { return this.text[this.position + offset] ?? ""; }
  startsWith(token: string): boolean { return this.text.startsWith(token, this.position); }
  /** Spaces and tabs; with `lines`, also newlines and comments. */
  skip(lines: boolean): void {
    for (;;) {
      const char = this.peek();
      if (char === " " || char === "\t" || (lines && (char === "\n" || char === "\r"))) this.position++;
      else if (char === "#") while (this.position < this.text.length && this.peek() !== "\n") this.position++;
      else return;
    }
  }
  key(): string[] {
    const parts: string[] = [];
    do {
      this.skip(false);
      const char = this.peek();
      if (char === '"' || char === "'") parts.push(this.string());
      else {
        const match = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.position));
        if (!match) this.fail("a name was expected");
        parts.push(match[0]);
        this.position += match[0].length;
      }
      this.skip(false);
    } while (this.peek() === "." && ++this.position);
    return parts;
  }
  string(): string {
    const quote = this.peek(), triple = this.startsWith(quote.repeat(3));
    this.position += triple ? 3 : 1;
    if (triple && this.peek() === "\n") this.position++;
    let out = "";
    for (;;) {
      if (this.position >= this.text.length) this.fail("a string was not closed");
      if (triple ? this.startsWith(quote.repeat(3)) : this.peek() === quote) break;
      const char = this.text[this.position++]!;
      if (char === "\n" && !triple) this.fail("a line break inside a string");
      if (char !== "\\" || quote === "'") { out += char; continue; }
      out += this.escape();
    }
    this.position += triple ? 3 : 1;
    return out;
  }
  escape(): string {
    const char = this.text[this.position++] ?? "";
    const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\" };
    if (char in simple) return simple[char]!;
    if (char === "u" || char === "U") {
      const length = char === "u" ? 4 : 8, hex = this.text.slice(this.position, this.position + length);
      this.position += length;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    if (char === "\n" || char === "\r" || char === " ") { this.skip(true); return ""; }
    return this.fail("an unknown escape in a string");
  }
  value(): Value {
    this.skip(false);
    const char = this.peek();
    if (char === '"' || char === "'") return this.string();
    if (char === "[") return this.array();
    if (char === "{") return this.inline();
    const match = /^[^\s,\]}#]+/.exec(this.text.slice(this.position));
    if (!match) return this.fail("a value was expected");
    this.position += match[0].length;
    if (match[0] === "true" || match[0] === "false") return match[0] === "true";
    const number = Number(match[0].replace(/_/g, ""));
    return Number.isFinite(number) && /^[+-]?[\d.]/.test(match[0]) && !/^\d{4}-/.test(match[0]) ? number : match[0];
  }
  nest(): void { if (++this.depth > maximumDepth) this.fail("values are nested too deeply"); }
  array(): Value[] {
    const items: Value[] = [];
    this.nest();
    this.position++;
    for (;;) {
      this.skip(true);
      if (this.peek() === "]") { this.position++; this.depth--; return items; }
      items.push(this.value());
      this.skip(true);
      if (this.peek() === ",") this.position++;
      else if (this.peek() !== "]") this.fail("a comma or ] was expected");
    }
  }
  inline(): Table {
    const table: Table = {};
    this.nest();
    this.position++;
    for (;;) {
      this.skip(false);
      if (this.peek() === "}") { this.position++; this.depth--; return table; }
      const key = this.key();
      if (this.peek() !== "=") this.fail("= was expected");
      this.position++;
      assign(table, key, this.value());
      this.skip(false);
      if (this.peek() === ",") this.position++;
    }
  }
}

function tableAt(root: Table, path: string[]): Table {
  let table = root;
  for (const part of path) {
    const next = Object.hasOwn(table, part) ? table[part] : undefined;
    if (next === undefined) table = (table[part] = {});
    else if (typeof next === "object" && !Array.isArray(next)) table = next;
    else throw new Error(`config.toml could not be read: ${path.join(".")} is both a value and a table`);
  }
  return table;
}

function assign(root: Table, key: string[], value: Value): void {
  if (key.some((part) => forbiddenNames.has(part))) throw new Error(`config.toml could not be read: ${key.join(".")} is not a name Branch accepts`);
  tableAt(root, key.slice(0, -1))[key[key.length - 1]!] = value;
}

export function parseToml(text: string): Table {
  const reader = new Reader(text.replace(/^\u{FEFF}/u, "")), root: Table = {};
  let current: Table | null = root;
  for (;;) {
    reader.skip(true);
    if (reader.position >= reader.text.length) return root;
    if (reader.startsWith("[[")) {
      reader.position += 2; reader.key();
      if (!reader.startsWith("]]")) reader.fail("]] was expected");
      reader.position += 2;
      current = null; // arrays of tables are not needed here, so their keys are read and dropped
      continue;
    }
    if (reader.peek() === "[") {
      reader.position++;
      const path = reader.key();
      if (path.some((part) => forbiddenNames.has(part))) reader.fail("a table name Branch does not accept");
      if (reader.peek() !== "]") reader.fail("] was expected");
      reader.position++;
      current = tableAt(root, path);
      continue;
    }
    const key = reader.key();
    if (reader.peek() !== "=") reader.fail("= was expected");
    reader.position++;
    const value = reader.value();
    if (current) assign(current, key, value);
  }
}
