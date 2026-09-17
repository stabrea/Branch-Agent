/**
 * Reads the few string values a Gemini CLI command file holds (`description = "..."`, and
 * `prompt = """..."""`). It is not a TOML parser: tables, arrays and numbers are ignored, and a file
 * it cannot read simply gives nothing back. Nothing here runs anything.
 */
const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };

function basicString(text: string): string {
  return text.replace(/\\(.)/g, (_, char: string) => escapes[char] ?? char);
}

/** The top-level string keys of a small TOML file, before its first table. */
export function tomlStrings(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = source.replace(/\r\n/g, "\n");
  const pattern = /^([A-Za-z0-9_-]+)\s*=\s*("""([\s\S]*?)"""|'''([\s\S]*?)'''|"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)')/gm;
  const firstTable = text.search(/^\s*\[/m);
  for (const match of text.matchAll(pattern)) {
    if (firstTable >= 0 && (match.index ?? 0) > firstTable) break;
    const [, key, , triple, literalTriple, basic, literal] = match;
    const value = triple !== undefined ? basicString(triple.replace(/^\n/, ""))
      : literalTriple !== undefined ? literalTriple.replace(/^\n/, "")
        : basic !== undefined ? basicString(basic) : literal ?? "";
    out[key!] = value;
  }
  return out;
}
