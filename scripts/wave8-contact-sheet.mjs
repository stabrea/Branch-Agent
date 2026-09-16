/**
 * Wave 8: one page putting every before picture beside its after picture.
 * Run after both screenshot passes: node scripts/wave8-contact-sheet.mjs
 *
 * The sheet lives outside public/, so it carries a copy of the tokens it needs at the top rather
 * than linking tokens.css. It still writes no colour of its own: every value below is copied from
 * public/tokens.css, and every rule reads a token.
 */
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "C:/Users/bishi/AppData/Local/Temp/claude-session-files/wave8-design-qa";
const before = new Set(readdirSync(join(ROOT, "before")).filter((n) => n.endsWith(".png")));
const after = new Set(readdirSync(join(ROOT, "after")).filter((n) => n.endsWith(".png")));
const names = [...new Set([...before, ...after])].sort();

/** "settings-daylight-400x800.png" → { screen, theme, size } */
const parse = (name) => {
  const bare = name.replace(/\.png$/, "");
  const [size, theme, ...rest] = bare.split("-").reverse();
  return { screen: rest.reverse().join(" "), theme, size };
};

const rows = names.map((name) => {
  const { screen, theme, size } = parse(name);
  const cell = (stage, has) => has
    ? `<a href="${stage}/${name}"><img src="${stage}/${name}" alt="${screen}, ${theme}, ${size}, ${stage}" loading="lazy" /></a>`
    : `<p class="none">not taken in this pass</p>`;
  return `<section class="pair">
  <h2>${screen}<span class="tag">${theme}</span><span class="tag">${size}</span></h2>
  <div class="two">
    <figure>${cell("before", before.has(name))}<figcaption>before</figcaption></figure>
    <figure>${cell("after", after.has(name))}<figcaption>after</figcaption></figure>
  </div>
</section>`;
}).join("\n");

const page = `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Branch Agent — wave 8 design QA</title>
<style>
/* Copied from public/tokens.css. Nothing below writes a colour that is not one of these. */
:root {
  --ground: #03140b; --surface: #051810; --well: rgba(0,0,0,.26);
  --text: #edf1ea; --muted: rgba(237,241,234,.78); --faint: rgba(237,241,234,.6);
  --line: rgba(236,241,233,.12); --copper: #e07033; --copper-text: #f4a06c;
  --display: Archivo, "Arial Narrow", "Helvetica Neue", Arial, sans-serif;
  --body: Geist, "Helvetica Neue", Arial, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, Consolas, monospace;
  --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px;
  --r2: 12px; --r3: 16px;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root {
    --ground: #dde7da; --surface: #fffdf8; --well: rgba(23,40,30,.05);
    --text: #17231d; --muted: #59675f; --faint: rgba(18,33,26,.64);
    --line: rgba(23,40,30,.14); --copper-text: #a3480f;
    color-scheme: light;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: var(--s6) var(--s4);
  background: var(--ground); color: var(--text);
  font-family: var(--body); font-size: 15px; line-height: 1.55;
}
main { max-width: 1400px; margin: 0 auto; }
h1 { font-family: var(--display); font-size: 2rem; margin: 0 0 var(--s2); }
.lede { color: var(--muted); max-width: 68ch; margin: 0 0 var(--s6); }
.pair { border-top: 1px solid var(--line); padding: var(--s5) 0; }
.pair h2 {
  font-family: var(--display); font-size: 1.15rem; margin: 0 0 var(--s3);
  display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s2);
}
.tag {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: .4px;
  text-transform: uppercase; color: var(--faint);
  border: 1px solid var(--line); border-radius: 999px; padding: 2px var(--s2);
}
.two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s4); }
@media (max-width: 760px) { .two { grid-template-columns: 1fr; } }
figure { margin: 0; min-width: 0; }
img {
  display: block; width: 100%; height: auto;
  border: 1px solid var(--line); border-radius: var(--r2); background: var(--surface);
}
figcaption {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: .4px;
  text-transform: uppercase; color: var(--faint); padding-top: var(--s2);
}
figure:last-child figcaption { color: var(--copper-text); }
.none {
  margin: 0; padding: var(--s5); text-align: center; color: var(--faint);
  border: 1px dashed var(--line); border-radius: var(--r2); background: var(--well);
}
</style>
<main>
<h1>Wave 8 — every screen, before and after</h1>
<p class="lede">
  ${names.length} pictures of each pass: the ten sections plus the lock screen, the welcome card,
  the command palette, the workspace menu, the context pane, an answered conversation and the
  receipt sheet, in Forest and Daylight at 1280&times;800 and 400&times;800. Taken with
  <code>node tests/wave8-screenshots.mjs before</code> and <code>&hellip; after</code>.
  Click a picture to open it full size.
</p>
${rows}
</main>
`;

writeFileSync(join(ROOT, "contact-sheet.html"), page);
console.log(`${names.length} pairs into ${join(ROOT, "contact-sheet.html")}`);
