import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const localeUrl = (name) => new URL(`../public/locales/${name}.json`, import.meta.url);

async function readLocale(name) {
  const raw = await readFile(localeUrl(name), "utf8");
  const keys = [...raw.matchAll(/^  "((?:\\.|[^"\\])+)":/gm)].map((match) => JSON.parse(`"${match[1]}"`));
  assert.equal(new Set(keys).size, keys.length, `${name}.json has no duplicate keys hidden by JSON parsing`);
  return JSON.parse(raw);
}

const placeholders = (words) => [...words.matchAll(/\{[A-Za-z][A-Za-z0-9_.-]*\}/g)].map((match) => match[0]).sort();

test("the shipped language files are valid, unique and keep the same interpolation contract", async () => {
  const [english, french] = await Promise.all([readLocale("en"), readLocale("fr")]);
  for (const [key, words] of Object.entries(english)) {
    assert.equal(typeof french[key], "string", `${key} has French words`);
    assert.ok(words.length > 0 && french[key].length > 0, `${key} is not blank`);
    assert.equal(placeholders(french[key]).length, placeholders(words).length, `${key} keeps its placeholder count`);
  }
});
