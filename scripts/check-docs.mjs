/**
 * Two checks that keep the written documents honest, run from `tests/handbook.test.mjs`.
 *
 * 1. Every setting a person can change is named somewhere in the reference. The names come from the
 *    settings and connection descriptions in `src/` — the `…SettingsSchema`, `…PreferencesSchema`
 *    and `…ConfigSchema` objects — so a new setting that nobody wrote down fails the build rather
 *    than quietly shipping undocumented.
 * 2. Every link between handbook chapters points at a chapter that exists, and at a heading that
 *    exists when it names one. A handbook that sends a person to a page that is not there is worse
 *    than no handbook.
 *
 * Prints what is wrong and exits non-zero. Prints one summary line and exits zero when all is well.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "src";
const REFERENCE = "docs/configuration.md";
const HANDBOOK = "docs/handbook";

/** Every TypeScript file under src/, in a stable order. */
function sourceFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (path.endsWith(".ts")) found.push(path);
  }
  return found;
}

/** The text between the braces of the object that starts at `open`, brace-matched. */
function objectBody(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return "";
}

/**
 * Comments blanked, to the same length so every other index still lines up. Prose in a comment can
 * read like a key ("w911: the three-way switch"), so it must not be read as one. The text is walked
 * rather than swept with one replacement: a string may hold "/*" or "*\/", and blanking from there
 * would swallow every key up to the next end-of-comment and hide an undocumented setting. A line
 * comment is left alone on purpose - "\/\/" also happens inside a regular expression such as
 * `regex(/^https?:\/\//)`, and a line comment has never been able to hide a key.
 */
export function withoutComments(source) {
  let out = "";
  for (let i = 0; i < source.length;) {
    // An escape is copied whole, so the "\/\/" of a regular expression such as `regex(/^https?:\/\//)`
    // is never mistaken for the start of a line comment.
    if (source[i] === "\\") { out += source.slice(i, i + 2); i += 2; continue; }
    const two = source.slice(i, i + 2);
    if (two === "/*" || two === "//") {
      const end = two === "/*" ? source.indexOf("*/", i + 2) : source.indexOf("\n", i);
      const stop = end < 0 ? source.length : two === "/*" ? end + 2 : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    const quote = source[i];
    if (quote === '"' || quote === "'" || quote === "`") {
      // The quotes are kept and what is between them blanked: a brace, a colon or a "/*" a person
      // wrote inside a default value is not part of the code around it either.
      out += quote;
      i += 1;
      for (; i < source.length; i += 1) {
        if (source[i] === "\\") { out += "  "; if (i + 1 < source.length) i += 1; continue; }
        if (source[i] === quote) { out += quote; i += 1; break; }
        out += " ";
      }
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

/** The keys written at the top level of one object body, ignoring anything nested inside it. */
export function topLevelKeys(source) {
  const body = withoutComments(source);
  const keys = [];
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const character = body[i];
    if (depth === 0 && /[A-Za-z_$"]/.test(character) && (i === 0 || /[\s,]/.test(body[i - 1]))) {
      const hit = /^"?([A-Za-z_$][\w$]*)"?\s*:/.exec(body.slice(i));
      if (hit) keys.push(hit[1]);
    }
    if ("{([".includes(character)) depth += 1;
    else if ("})]".includes(character)) depth -= 1;
  }
  return keys;
}

// phase2/settings integration: `\w*`, not `\w+`, so the look's own `PreferencesSchema` (src/preferences.ts) counts too.
const SCHEMA = /export const (\w*(?:Settings|Preferences|Config))Schema\s*=\s*z[\s\S]{0,10}?\.object\(\{/g;

/**
 * Every settable key, mapped to the schemas that declare it. Exported for tests/settings-grown.test.mjs
 * (S14), which holds Settings search to the same list; `root` is the checkout to read.
 */
export function settingKeys(root = ".") {
  const keys = new Map();
  for (const file of sourceFiles(join(root, SOURCE))) {
    const source = readFileSync(file, "utf8");
    for (const hit of source.matchAll(SCHEMA)) {
      const body = objectBody(source, source.lastIndexOf("{", hit.index + hit[0].length));
      for (const key of topLevelKeys(body))
        keys.set(key, (keys.get(key) ?? new Set()).add(`${hit[1]}Schema (${file.replaceAll("\\", "/")})`));
    }
  }
  return keys;
}

/** A setting counts as written down when the reference names it inside code marks. */
function undocumented(keys, reference) {
  const missing = [];
  for (const [key, where] of keys)
    if (!new RegExp("`[^`]*\\b" + key + "\\b[^`]*`").test(reference))
      missing.push(`${key} — declared by ${[...where].join(", ")}`);
  return missing.sort();
}

/** GitHub's own heading slug: lower case, punctuation dropped, spaces hyphenated. */
const slug = (heading) =>
  heading.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

const headingSlugs = (text) =>
  new Set([...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((hit) => slug(hit[1])));

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

/** Every handbook link that points at a chapter or a heading which is not there. */
function brokenLinks() {
  const broken = [];
  const slugsOf = new Map();
  for (const name of readdirSync(HANDBOOK).sort()) {
    if (!name.endsWith(".md")) continue;
    const from = join(HANDBOOK, name);
    const text = readFileSync(from, "utf8");
    for (const hit of text.matchAll(LINK)) {
      const target = hit[1];
      if (/^(https?:|mailto:)/i.test(target)) continue;
      const [file, anchor] = target.split("#");
      const path = file ? resolve(dirname(from), file) : resolve(from);
      if (!existsSync(path)) {
        broken.push(`${name}: ${target} — no such file`);
        continue;
      }
      if (!anchor) continue;
      if (!slugsOf.has(path)) slugsOf.set(path, headingSlugs(readFileSync(path, "utf8")));
      if (!slugsOf.get(path).has(anchor)) broken.push(`${name}: ${target} — no such heading`);
    }
  }
  return broken;
}

/** The whole check. Run when this file is the program; a test may import the pieces instead. */
function main() {
  const keys = settingKeys();
  const missing = undocumented(keys, readFileSync(REFERENCE, "utf8"));
  const broken = brokenLinks();

  for (const line of missing) console.error(`Not in ${REFERENCE}: ${line}`);
  for (const line of broken) console.error(`Broken handbook link in ${line}`);
  if (missing.length || broken.length) {
    console.error(`\n${missing.length} undocumented setting(s), ${broken.length} broken link(s).`);
    process.exitCode = 1;
  } else {
    console.log(`${keys.size} settings all named in ${REFERENCE}; every handbook link resolves.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
