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

/** The keys written at the top level of one object body, ignoring anything nested inside it. */
function topLevelKeys(body) {
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

const SCHEMA = /export const (\w+(?:Settings|Preferences|Config))Schema\s*=\s*z[\s\S]{0,10}?\.object\(\{/g;

/** Every settable key, mapped to the schemas that declare it. */
function settingKeys() {
  const keys = new Map();
  for (const file of sourceFiles(SOURCE)) {
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
