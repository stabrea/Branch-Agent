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
  [/\b(Taofik|Hartwell|Okafor|Marcus Lee|Priya Shah|Fieldnotes|Lisbon|keepoak\.com\/t\/|Legion|Dana)\b/i, "prototype example name"],
  [/(?:[>"]|·\s)(Scout|Ledger|Ada|Ember|Tock|Kite|Morel)/, "prototype example Trunk"],
  [/\b(Qwen3\.6|GPT-6 Sol)\b/, "prototype example model"],
  [/>\s*(Connected|Loaded|Online|Up to date|is up to date|Last night, 2:00 AM|0\.20\.0 ready)\s*</, "status written into markup"],
  [/\b\d+(\.\d+)?\s?(GB|MB)\b(?![^`]*\$\{)/, "size written into markup"],
  [/version\s*(\|\||\?\?)\s*["'`]\d/, "version written in as a fallback"],
  [/catch\s*\(\w+\)\s*\{\s*(\/\*[^*]*\*\/)?\s*\}|catch\s*\{\s*\}/, "error swallowed (show error.message)"],
  [/real implementation|placeholder screen|For now, show/i, "stub left in"],
  [/\son(submit|click|input|change)=/, "inline event handler (the CSP refuses it)"],
  [/aria-(pressed|checked)=\\?"true\\?"|<input[^>]*\schecked[\s>]|<option[^>]*\sselected[\s>]/, "state written into markup (compute it)"],
  [/\|\|\s*["']\$\d/, "amount written in as a fallback"],
];
// A toast's own words must be the prototype's: any literal toast text has to appear in prototype.html.
const PROTO = readFileSync("design/redesign/prototype.html", "utf8").replaceAll("’", "'");
const toastWords = (line) => [...line.matchAll(/toast\((["'`])((?:(?!\1).)*)\1/g)].map((m) => m[2]).filter((t) => !t.includes("${"));
// The tour's own copy names the model families; setup's textarea keeps the prototype's placeholder hint.
const EXEMPT = { "public/app/flows/tour.js": ["prototype example model"], "public/app/flows/setup.js": ["prototype example name"] };

// The owner's decision: Branch has no demo or practice model; setup is how a model is chosen. Checked on every line,
// comments included, so not even a note about one comes back.
const NO_DEMO = /Offline demonstration|Practice mode|offline-demo-fixture/;

let bad = 0;
for (const f of files) {
  const rel = f.replaceAll("\\", "/");
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    if (NO_DEMO.test(line)) { console.log(`${rel}:${i + 1}: demo model in the window: ${line.match(NO_DEMO)[0]}`); bad++; }
    for (const [re, why] of RULES) {
      if (EXEMPT[rel]?.includes(why) || /^\s*(\/\/|\/\*|\*)/.test(line)) continue;
      // A state the line explains as true ("// state: <why>") is allowed; the reason is read in review.
      if (why.startsWith("state written") && /\/\/ state: \S/.test(line)) continue;
      if (re.test(line)) { console.log(`${rel}:${i + 1}: ${why}: ${line.match(re)[0].trim()}`); bad++; }
    }
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
    for (const words of toastWords(line)) {
      if (!PROTO.includes(words.replaceAll("’", "'"))) { console.log(`${rel}:${i + 1}: toast words not in the prototype: ${words}`); bad++; }
    }
  });
}
console.log(bad ? `${bad} fake or forbidden thing(s)` : "fakes ok");
process.exit(bad ? 1 : 0);
