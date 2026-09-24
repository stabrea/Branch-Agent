/**
 * Q48 review: finds every place in src/ that saves or deletes a `settings` record whose key is a
 * setting in the Settings catalogue, so a guard test can hold each of them to a change record.
 *
 * The key is read as a string, a template, a constant, or a small key builder (`reachKey(part)`),
 * in the same file or the file it is imported from. A key worked out any other way (`entry.key`,
 * `this.key(id)`, `prefix + id`) is reported as unresolved with its file, and the guard names those.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function tsFiles(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

const sources = new Map(tsFiles(join(root, "src")).map((path) => [path, readFileSync(path, "utf8")]));
/** Names in this code are plain identifiers, so only `$` needs escaping to sit inside a pattern. */
const escape = (name) => name.replaceAll("$", "[$]");

/** What a name defined in this file (or imported into it) stands for: a key, or a key prefix ending in "*". */
function definition(file, name, depth = 0) {
  const text = sources.get(file);
  if (!text || depth > 3) return undefined;
  const id = escape(name);
  const plain = new RegExp(String.raw`(?:const|let)\s+${id}\s*(?::[^=]+)?=\s*(["'` + "`" + String.raw`])([^"'$` + "`" + String.raw`]*)(\$\{)?`).exec(text);
  if (plain) return plain[3] ? `${plain[2]}*` : plain[2];
  const arrow = new RegExp(String.raw`const\s+${id}\s*=\s*\([^)]*\)(?:\s*:\s*\w+)?\s*=>\s*` + "`" + String.raw`([^$` + "`" + String.raw`]*)\$\{`).exec(text);
  if (arrow) return `${arrow[1]}*`;
  const declared = new RegExp(String.raw`function\s+${id}\s*\([^)]*\)[^{]*\{\s*return\s+` + "`" + String.raw`([^$` + "`" + String.raw`]*)\$\{`).exec(text);
  if (declared) return `${declared[1]}*`;
  const imported = new RegExp(String.raw`import\s*(?:type\s*)?\{[^}]*\b${id}\b[^}]*\}\s*from\s*["']([^"']+)["']`).exec(text);
  if (imported && imported[1].startsWith(".")) {
    const target = resolve(dirname(file), imported[1].replace(/\.js$/, ".ts"));
    return definition(target, name, depth + 1);
  }
  return undefined;
}

/** A key expression, as written, read as a key or a prefix; undefined when it is worked out some other way. */
function readKey(file, expression) {
  const text = expression.trim();
  const literal = /^(["'])([^"']*)\1$/.exec(text);
  if (literal) return literal[2];
  const template = /^`([^`$]*)(\$\{)?/.exec(text);
  if (template) return template[2] ? `${template[1]}*` : template[1];
  const name = /^([A-Za-z_$][\w$]*)(\s*\(.*)?$/s.exec(text);
  if (name) return definition(file, name[1]);
  return undefined;
}

/** The third argument of a call starting at `open` (the index just after "("), as written. */
function thirdArgument(text, open) {
  let depth = 0, index = open, start = open, argument = 0;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) { if (depth === 0) break; depth -= 1; }
    else if (char === "," && depth === 0) {
      argument += 1;
      if (argument === 2) start = index + 1;
      else if (argument === 3) return text.slice(start, index);
    }
  }
  return argument === 2 ? text.slice(start, index) : undefined;
}

/** Every save or delete of a `settings` record: its file, line, the key as written and as read. */
export function settingsWrites() {
  const found = [];
  for (const [file, text] of sources) {
    for (const match of text.matchAll(/\.(save|delete)\(\s*"settings"\s*,/g)) {
      const expression = thirdArgument(text, match.index + match[0].indexOf("(") + 1) ?? "";
      found.push({ file: relative(root, file).replaceAll("\\", "/"), line: text.slice(0, match.index).split("\n").length,
        call: match[1], expression: expression.trim(), key: readKey(file, expression) });
    }
  }
  return found;
}

/** The catalogue keys a key as read stands for: itself, or every key the prefix begins. */
export function catalogueKeysOf(key, catalogueKeys) {
  if (key === undefined) return [];
  return key.endsWith("*") ? catalogueKeys.filter((entry) => entry.startsWith(key.slice(0, -1))) : catalogueKeys.filter((entry) => entry === key);
}
