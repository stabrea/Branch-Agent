// A control may be marked live only if something handles it: an on("name") handler for a data-act, or a 'change'
// listener that names the switch's id. Prints every live id with no handler.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const files = []; const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") && files.push(p); } }; walk("public/app");
const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
const handled = new Set([...all.matchAll(/\bon\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]));
let bad = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const ids = [...src.matchAll(/markLive\(\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]));
  const block = /export const live\s*=\s*\{([\s\S]*?)\};/.exec(src);
  if (block) ids.push(...[...block[1].matchAll(/["']([^"']+)["']\s*:/g)].map((m) => m[1]));
  for (const id of ids) {
    if (id.startsWith("sw:")) { const sw = id.slice(3); const uses = src.split(sw).length - 1; if (!/addEventListener\(\s*["']change["']/.test(src) || uses < 2) { console.log(`${f}: ${id} has no change handler`); bad++; } }
    else if (!handled.has(id)) { console.log(`${f}: ${id} has no on() handler`); bad++; }
  }
}
console.log(bad ? `${bad} live control(s) with nothing behind them` : "live ok");
process.exit(bad ? 1 : 0);
