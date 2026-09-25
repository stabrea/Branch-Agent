// Fails on what must never reach the window: inline style="" (the engine's CSP refuses it), the prototype's asset paths,
// design-note attributes, the prototype's example people, Trunks, places and models, and a status written into markup
// rather than computed from the engine. Prints each hit as file:line.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js")) files.push(p); } };
walk("public/app");

const RULES = [
  [/ style="/, "inline style (use data-css)"],
  [/src="assets\//, "prototype asset path (art lives in /art/)"],
  [/data-note=/, "design-note attribute"],
  [/\b(Taofik|Hartwell|Okafor|Marcus Lee|Priya Shah|Fieldnotes|Lisbon|keepoak\.com\/t\/|Legion|Dana)\b/, "prototype example name"],
  [/(?:[>"]|·\s)(Scout|Ledger|Ada|Ember|Tock|Kite|Morel)/, "prototype example Trunk"],
  [/\b(Qwen3\.6|GPT-6 Sol)\b/, "prototype example model"],
  [/>\s*(Connected|Loaded|Online|Up to date|is up to date|Last night, 2:00 AM|0\.20\.0 ready)\s*</, "status written into markup"],
  [/\b\d+(\.\d+)?\s?(GB|MB)\b(?![^`]*\$\{)/, "size written into markup"],
];
// The tour's own copy names the model families; setup's textarea keeps the prototype's placeholder hint.
const EXEMPT = { "public/app/flows/tour.js": ["prototype example model"], "public/app/flows/setup.js": ["prototype example name"] };

let bad = 0;
for (const f of files) {
  const rel = f.replaceAll("\\", "/");
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    for (const [re, why] of RULES) {
      if (EXEMPT[rel]?.includes(why) || /^\s*(\/\/|\/\*|\*)/.test(line)) continue;
      if (re.test(line)) { console.log(`${rel}:${i + 1}: ${why}: ${line.match(re)[0].trim()}`); bad++; }
    }
  });
}
console.log(bad ? `${bad} fake or forbidden thing(s)` : "fakes ok");
process.exit(bad ? 1 : 0);
