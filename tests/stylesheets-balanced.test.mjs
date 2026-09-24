/**
 * Every stylesheet the browser is given closes each rule it opens. A merge once lost the `}` after
 * `.profile-badge button` in public/shell.css (each side was whole alone), and the browser then read
 * the rules after it as nested inside that button, so the Recents "working" line was never styled.
 * No test saw it, because the file still loaded. Node only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const publicDir = new URL("../public/", import.meta.url);

async function stylesheets(dir = publicDir, prefix = "") {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...await stylesheets(new URL(`${entry.name}/`, dir), join(prefix, entry.name)));
    else if (entry.name.endsWith(".css")) found.push(join(prefix, entry.name));
  }
  return found;
}

/** Where the braces first go wrong, or null: comments and quoted strings are skipped. */
function unbalanced(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (quoted) => quoted.replace(/[^\n]/g, " "));
  const open = [];
  for (let at = 0; at < text.length; at++) {
    if (text[at] === "{") open.push(at);
    else if (text[at] === "}") {
      if (!open.length) return { line: text.slice(0, at).split("\n").length, why: "a } closes nothing" };
      open.pop();
    }
  }
  if (open.length) return { line: text.slice(0, open.at(-1)).split("\n").length, why: `${open.length} { never closed` };
  return null;
}

test("the brace check finds an unclosed rule and a stray close", () => {
  assert.equal(unbalanced(".a { color: red; }\n.b { top: 0; }"), null);
  assert.deepEqual(unbalanced(".a {\n  color: red;\n\n.b { top: 0; }"), { line: 1, why: "1 { never closed" });
  assert.deepEqual(unbalanced(".a { top: 0; }\n}\n.b { top: 0; }"), { line: 2, why: "a } closes nothing" });
  assert.equal(unbalanced('.a::before { content: "{"; } /* } */'), null, "braces in strings and comments do not count");
});

test("every stylesheet in public/ closes every rule it opens", async () => {
  const files = await stylesheets();
  assert.ok(files.length > 10, `found ${files.length} stylesheets`);
  for (const file of files) {
    const problem = unbalanced(await readFile(new URL(file, publicDir), "utf8"));
    assert.equal(problem, null, `public/${file}: ${problem?.why} (from line ${problem?.line})`);
  }
});
