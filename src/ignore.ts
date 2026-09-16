/**
 * A `.branchignore` file in the workspace root hides extra paths from the assistant. It uses the
 * same syntax people already know from `.gitignore`: one pattern per line, `#` for a comment, a
 * trailing `/` for folders only, `!` to un-hide something, `*` and `?` inside one folder name and
 * `**` across folders. The fixed secret patterns (`.env`, `.ssh`, keys and the like) are applied
 * first and a `!` line can never bring those back.
 */
export interface IgnoreMatcher {
  /** True when this path, written relative to the workspace root with "/" separators, is hidden. */
  ignores(path: string, isDirectory?: boolean): boolean;
  /** How many usable patterns the file contained. */
  readonly patterns: number;
}
interface Rule { test: RegExp; negated: boolean; directoryOnly: boolean }

/** Builds a matcher from the text of a `.branchignore` (or any gitignore-style) file. */
export function ignoreMatcher(text: string): IgnoreMatcher {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/).slice(0, 1000)) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const body = (negated ? line.slice(1) : line).replace(/^\\([!#])/, "$1");
    const directoryOnly = body.endsWith("/");
    const pattern = directoryOnly ? body.slice(0, -1) : body;
    if (!pattern || pattern === "/") continue;
    rules.push({ negated, directoryOnly, test: compile(pattern) });
  }
  return { patterns: rules.length, ignores: (path, isDirectory = false) => decide(rules, path, isDirectory) };
}

const escape = (character: string): string => (/[.+^${}()|[\]\\]/.test(character) ? "\\" + character : character);

/** Turns one gitignore pattern into an anchored regular expression over a "/" separated path. */
function compile(pattern: string): RegExp {
  const anchored = pattern.includes("/") && !pattern.startsWith("**/") && pattern.indexOf("/") !== pattern.length - 1;
  const body = pattern.replace(/^\//, "");
  let out = "";
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!;
    if (character !== "*") { out += character === "?" ? "[^/]" : escape(character); continue; }
    if (body[index + 1] !== "*") { out += "[^/]*"; continue; }
    if (body[index + 2] === "/") { out += "(?:.*/)?"; index += 2; } else { out += ".*"; index += 1; }
  }
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${out}$`);
}

/** Last matching rule wins, and nothing inside a hidden folder can be un-hidden. */
function decide(rules: Rule[], path: string, isDirectory: boolean): boolean {
  const parts = path.split("/").filter(Boolean);
  let ignored = false;
  for (let depth = 1; depth <= parts.length; depth++) {
    const candidate = parts.slice(0, depth).join("/");
    const directory = depth < parts.length || isDirectory;
    for (const rule of rules) {
      if (rule.directoryOnly && !directory) continue;
      if (rule.test.test(candidate)) ignored = !rule.negated;
    }
    if (ignored && depth < parts.length) return true;
  }
  return ignored;
}
