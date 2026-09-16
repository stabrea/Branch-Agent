/**
 * A `.gitignore`-style matcher. Kept deliberately small and free of imports so that any branch
 * can create this file and the merge stays trivial.
 *
 * Supported: blank lines and `#` comments, `!` negation, a trailing `/` for directories only,
 * a leading or embedded `/` for patterns anchored at the ignore file, `*`, `?` and `**`.
 */
export function ignoreMatcher(
  text: string,
): (path: string, isDirectory?: boolean) => boolean {
  const rules = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .slice(0, 500)
    .map(toRule);
  return (path, isDirectory = false) => {
    const clean = path.replace(/^\.\//, "").replace(/\/+$/, "");
    let ignored = false;
    for (const rule of rules)
      if (matches(rule, clean, isDirectory)) ignored = !rule.negated;
    return ignored;
  };
}

interface Rule {
  expression: RegExp;
  negated: boolean;
  directoryOnly: boolean;
}

function toRule(line: string): Rule {
  const negated = line.startsWith("!");
  let pattern = negated ? line.slice(1) : line;
  const directoryOnly = pattern.endsWith("/");
  if (directoryOnly) pattern = pattern.slice(0, -1);
  const anchored = pattern.includes("/") && !pattern.startsWith("**/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const body = translate(pattern);
  return {
    expression: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`),
    negated,
    directoryOnly,
  };
}

/** Translates one glob body into a regular expression source string. */
function translate(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/** A rule matches the path itself or, for a directory rule, anything inside that directory. */
function matches(rule: Rule, path: string, isDirectory: boolean): boolean {
  if (rule.expression.test(path)) return !rule.directoryOnly || isDirectory;
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++)
    if (rule.expression.test(parts.slice(0, i).join("/"))) return true;
  return false;
}
