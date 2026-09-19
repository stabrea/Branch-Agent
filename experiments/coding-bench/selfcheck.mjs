/**
 * Proves the checks before any agent is marked by them: every untouched seed must FAIL its check,
 * and a known-good solution (below) must PASS it. Run: node experiments/coding-bench/selfcheck.mjs
 */
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { tasks } from "./tasks.mjs";

const seeds = join(dirname(fileURLToPath(import.meta.url)), "seeds");

const solutions = {
  "fix-range": { "src/range.js": "export function range(s, e, step = 1) { const o = []; for (let n = s; n <= e; n += step) o.push(n); return o; }\n" },
  "add-median": {
    "src/stats.js": "export function mean(v) { if (!v.length) throw new Error('x'); return v.reduce((a, b) => a + b, 0) / v.length; }\nexport function median(v) { if (!v.length) throw new Error('median of nothing'); const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }\n",
    "test/stats.test.mjs": "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { mean, median } from '../src/stats.js';\ntest('mean', () => assert.equal(mean([1, 2, 3]), 2)); test('median', () => assert.equal(median([3, 1, 2]), 2));\n",
  },
  "extract-helper": {
    "src/format.js": "export function formatPrice(cents) { return '$' + (cents / 100).toFixed(2); }\n",
    "src/cart.js": "import { formatPrice } from './format.js';\nexport function cartLine(item) { return `${item.name}: ${formatPrice(item.cents)}`; }\n",
    "src/invoice.js": "import { formatPrice } from './format.js';\nexport function invoiceTotal(items) { return `Total ${formatPrice(items.reduce((s, i) => s + i.cents, 0))}`; }\n",
  },
  "stack-trace": { "src/csv.js": "export function parseCsv(t) { const l = t.split('\\n').filter((x) => x.trim()); const h = l[0].split(','); return l.slice(1).map((r) => { const c = r.split(','); const o = {}; h.forEach((k, i) => { o[k] = c[i].trim(); }); return o; }); }\n" },
  "cli-flag": {
    "cli.mjs": "const a = process.argv.slice(2); let n = 'world', s = false; for (let i = 0; i < a.length; i++) { if (a[i] === '--name') n = a[++i]; else if (a[i] === '--shout') s = true; } const g = `Hello, ${n}!`; console.log(s ? g.toUpperCase() : g);\n",
    "README.md": "`--shout` prints in upper case.\n",
  },
  "update-docs": { "README.md": "createClient({ baseUrl, timeoutMs, retries }) — baseUrl required, timeoutMs 5000, retries 2\n" },
  "rename": {
    "src/users.js": "const users = new Map([[1, { id: 1, name: 'Ada' }]]);\nexport function getUser(id) { return users.get(id) ?? null; }\n",
    "src/profile.js": "import { getUser } from './users.js';\nexport function profileTitle(id) { const u = getUser(id); return u ? `Profile of ${u.name}` : 'Unknown user'; }\n",
    "src/admin.js": "import { getUser } from './users.js';\nexport function isKnown(id) { return getUser(id) !== null; }\n",
    "test/users.test.mjs": "",
  },
  "flaky": { "src/rank.js": "export function rank(p) { return [...p].sort((a, b) => b.score - a.score); }\n" },
  "dep-bump": { "src/report.js": "import { formatDate } from '../vendor/datefmt/index.js';\nexport const reportTitle = (d) => `Report for ${formatDate(d, 'YYYY-MM-DD')}`;\nexport const fileName = (d) => `report-${formatDate(d, 'YYYYMMDD')}.txt`;\n" },
  "validate-config": { "src/config.js": "export function loadConfig(r) { if (r.port === undefined) throw new Error('port is required'); if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535) throw new Error('port must be between 1 and 65535'); return { host: r.host ?? 'localhost', port: r.port }; }\n" },
  "missing-await": { "src/store.js": "const d = { a: 1, b: 2, c: 3 }; export async function load(k) { return d[k]; } export async function total(ks) { let s = 0; for (const k of ks) s += await load(k); return s; }\n" },
  "word-wrap": { "src/wrap.js": "export function wrap(t, w) { return t.split('\\n').map((p) => { const out = []; let line = ''; for (const word of p.split(' ')) { if (!line) line = word; else if (line.length + 1 + word.length <= w) line += ' ' + word; else { out.push(line); line = word; } } out.push(line); return out.join('\\n'); }).join('\\n'); }\n" },
};

function prepared(task, files) {
  const dir = mkdtempSync(join(tmpdir(), `cb-${task.id}-`));
  cpSync(join(seeds, task.seed, "work"), dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    if (body === "") { rmSync(full, { force: true }); continue; }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  const verify = join(seeds, task.seed, "verify");
  if (task.restoreVerify && existsSync(verify)) cpSync(verify, dir, { recursive: true });
  return dir;
}

let bad = 0;
for (const task of tasks) {
  const untouched = prepared(task, {});
  const solved = prepared(task, solutions[task.id] ?? {});
  const before = task.check(untouched, "");
  const after = task.check(solved, "");
  const ok = !before.passed && after.passed;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "BAD "} ${task.id.padEnd(16)} seed: ${before.why.slice(0, 70)} | solved: ${after.why.slice(0, 70)}`);
  rmSync(untouched, { recursive: true, force: true });
  rmSync(solved, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);
