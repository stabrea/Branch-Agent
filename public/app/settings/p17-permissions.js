/* Settings › Permissions, pass 17 (prototype patch17b), from the engine:
   Test a rule: POST /api/rules/test { tool, target } says which rule decides; nothing runs. An address is asked as
   web.fetch, words with a space as a command (shell.session.run), anything else as a file (files.write).
   What Trunks may reach: GET /api/firewall's sentences, and POST /api/firewall/test { address } for one address.
   Why is this set?: every setting whose value differs from how Branch ships (GET /api/settings-kit), each with the
   engine's own words (GET /api/settings-kit/why/<key>.<field>); Put back is POST /api/settings-kit/apply with that one
   field's shipped value and never confirmLoosening, so the engine itself refuses a put-back that loosens anything.
   Emergency stop: POST /api/safety-extras/stop { everything: true }, read back from GET /api/safety-extras.
   Every change to what Branch may reach: the engine's record (GET /api/audit), and Export as CSV saves
   GET /api/audit/export.csv.
   Security-held, greyed: the two switches here (one loosens approvals, one hides keys), the app lock (a PIN) and
   letting the emergency stop go (it loosens a stop); the rows under "Guards that are always on" have no readout yet. */
import { esc, render } from "../core/dom.js";
import { api, token } from "../core/api.js";
import { onDemo17 } from "../places/demo17.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast, openDlg, closeDlg, dialog, $ } from "../core/ui.js";
import { sw15, seg15 } from "./rows15.js";
import { demos17, demo17, row17, sec17, pill17 } from "./rows17.js";

const P = { kit: null, safety: null, result: null, fw: null, why: [] };

export async function load17() {
  const [kit, safety] = await Promise.all(["settings-kit", "safety-extras"].map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  Object.assign(P, { kit, safety });
  render();
}

/* Every field whose value is not the one Branch ships, as { spec, field }. */
const changed = () => (P.kit?.settings ?? []).flatMap((spec) => spec.fields.filter((f) => f.value !== undefined && f.value !== null
  && JSON.stringify(f.value) !== JSON.stringify(f.initial)).map((field) => ({ spec, field })));
const kitMode = (key) => P.kit?.settings?.find((s) => s.key === key)?.fields?.find((f) => f.field === "mode")?.value;

export function sections17(lv) {
  if (lv < 1) return "";
  const n = P.kit ? changed().length : null;
  const stopped = P.safety?.stop?.engaged === true;
  let html = sec17("Test and explain",
    row17("Test a rule", "Type a command, a file or a site and see which rule decides, before any Trunk tries it.", "Test", "ruletestb17")
    + row17("What Trunks may reach, in sentences", "Every site and network rule written out as plain sentences.", "Read it", "fwb17")
    + row17("Why is this set?", "Each setting that differs from the default: who set it, when, and why. Put any back.", n == null ? "See" : `See ${n}`, "whyb17")
    + sw15("A second look before approvals", "Another model reads risky actions first and says what worries it.", (kitMode("approval_reviewer") ?? "off") !== "off")
    + sw15("Hold back keys found in answers", "A key or password in a reply is hidden before it is sent anywhere.", false)
    + demo17("trust"));
  html += sec17("Locks and records",
    seg15("App lock", "", [["off", "Off"], ["quiet", "After 15 min"], ["pin", "Always"]], null, "applockb17")
    + (stopped ? row17("Emergency stop", "Stopped. Every task is halted; nothing resumes until you say so.", "Let them resume", "estoprelb17")
      : row17("Emergency stop", "Stops every task at once, on every computer, and holds them.", "Stop everything", "estopb17"))
    + demos17(["audit", "practice"]));
  if (lv >= 2) html += sec17("Guards that are always on", demos17(["injection", "chatperm", "loopguard", "leakguard", "codecheck"]));
  return html;
}

/* ---------- Test a rule ---------- */
const DECIDES = { allow: ["ok", "Allowed"], ask: ["warn", "Asks"], deny: ["no", "Never"] };
function ruleDlg() {
  const r = P.result;
  const res = r ? `<div class="res-line-b17">${pill17(...(DECIDES[r.decision] ?? ["idle", r.decision]))}<span><b>${esc(r.because)}</b><small></small></span></div>` : "";
  openDlg({ title: "Test a rule", body: `<p class="lead-b17">Nothing runs. Branch only says what would decide.</p><div class="test-b17"><input class="inp" id="rule-in-b17" value="${esc(P.ruleQ ?? "")}" aria-label="Command, file or site"><button class="btn pri sm" type="button" data-act="rulerunb17">Test</button></div><div class="chips-b17">${["git status", "https://unknown.example"].map((t) => `<button type="button" class="chip-b17" data-act="rulepickb17" data-v="${esc(t)}">${esc(t)}</button>`).join("")}</div>${res}`,
    foot: '<button class="btn" type="button" data-act="dlg-close">Close</button>' });
}
const toolFor = (q) => (/^https?:\/\//i.test(q) ? "web.fetch" : /\s/.test(q) ? "shell.session.run" : "files.write");
async function runRule() {
  const q = ($("#rule-in-b17")?.value ?? "").trim();
  P.ruleQ = q;
  if (!q) return;
  try { P.result = await api("rules/test", { tool: toolFor(q), target: q }); } catch (error) { toast(error.message); return; }
  ruleDlg();
}

/* ---------- What Trunks may reach ---------- */
function fwDlg(out = "") {
  const sentences = P.fw?.sentences ?? [];
  openDlg({ title: "What Trunks may reach", body: `<ol class="fw-b17">${sentences.map((s) => `<li>${esc(s)}</li>`).join("")}</ol><div class="test-b17"><input class="inp" id="fw-in-b17" value="${esc(P.fwQ ?? "https://unknown.example")}" aria-label="An address to check"><button class="btn sm" type="button" data-act="fwtestb17">Check an address</button></div><p class="hint" id="fw-out-b17" data-css="margin:0">${esc(out)}</p>`,
    foot: '<button class="btn" type="button" data-act="dlg-close">Close</button>' });
}
async function openFw() {
  try { P.fw = await api("firewall"); } catch (error) { toast(error.message); return; }
  fwDlg();
}
async function testFw() {
  const address = ($("#fw-in-b17")?.value ?? "").trim();
  P.fwQ = address;
  if (!address) return;
  try {
    const r = await api("firewall/test", { address });
    fwDlg(r.reason ? `${r.address}: ${r.reason}` : r.address);
  } catch (error) { toast(error.message); }
}

/* ---------- Why is this set? ---------- */
const title = ({ spec, field }) => (spec.fields.length > 1 ? `${spec.name} · ${field.label}` : spec.name);
async function readWhy() {
  const rows = changed();
  P.why = await Promise.all(rows.map(async (row) => {
    const id = row.spec.key + "." + row.field.field;
    const words = await api(`settings-kit/why/${encodeURIComponent(id)}`).then((w) => w.words, (error) => error.message);
    return { ...row, words };
  }));
}
function whyDlg() {
  const body = P.why.map((row) => `<div class="prow why-b17"><span class="grow"><b>${esc(title(row))}</b><small>${esc(row.words)}</small></span>${pill17("ok", String(row.field.value))}<button class="btn ghost sm" type="button" data-act="whyputb17" data-key="${esc(row.spec.key)}" data-field="${esc(row.field.field)}">Put back</button></div>`).join("");
  openDlg({ title: "Why is this set?", wide: true, body: `<div class="rows">${body}</div>`, foot: '<button class="btn" type="button" data-act="dlg-close">Close</button>' });
}
async function openWhy() {
  try { P.kit = await api("settings-kit"); await readWhy(); } catch (error) { toast(error.message); return; }
  whyDlg();
  render();
}
async function putBack(el) {
  const row = P.why.find((r) => r.spec.key === el.dataset.key && r.field.field === el.dataset.field);
  if (!row) return;
  try {
    const done = await api("settings-kit/apply", { plan: { source: "set", key: row.spec.key, field: row.field.field, value: row.field.initial }, accept: [`${row.spec.key}.${row.field.field}`] });
    const why = done.skipped?.[0]?.why ?? done.refused?.[0]?.why ?? done.refused?.[0]?.reason;
    if (!done.applied?.length && why) toast(why);
    else if (done.applied?.length) toast(`Put back: ${title(row)}.`);
    P.kit = done.overview ?? await api("settings-kit");
    await readWhy();
  } catch (error) { toast(error.message); }
  if (dialog()) whyDlg();
  render();
}

/* ---------- Emergency stop ---------- */
function stopDlg() {
  openDlg({ title: "Stop everything?", body: '<p class="lead-b17">Every task on every computer stops at once and is held. Scheduled work waits. Nothing is lost.</p>',
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn bad" type="button" data-act="estopgob17">Stop everything</button>' });
}
async function stop() {
  try { await api("safety-extras/stop", { everything: true }); } catch (error) { toast(error.message); return; }
  closeDlg();
  await load17();
}

/* ---------- the record of every widening or narrowing ---------- */
async function openAudit() {
  const { entries } = await api("audit?limit=100");
  const day = (at) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const rows = (entries ?? []).map((e) => `<div class="prow"><span class="grow"><b>${esc(e.subject)}</b><small>${esc(day(e.at))} · ${esc(e.reason)}</small></span>${pill17("idle", e.outcome)}</div>`).join("");
  openDlg({ title: "Every change to what Branch may reach", body: `<div class="rows demo-b17">${rows}</div>`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Close</button><button class="btn pri" type="button" data-act="demodob17" data-k="audit">Export as CSV</button>' });
}
/* The CSV is not JSON, so it is fetched with the session key and saved as it came. */
async function saveAudit() {
  const key = token.get();
  const response = await fetch("/api/audit/export.csv", { cache: "no-store", headers: key ? { authorization: "Bearer " + key } : {} });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || String(response.status));
  const url = URL.createObjectURL(await response.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: `branch-record-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let started = false;
export function init17() {
  if (started) return;
  started = true;
  onDemo17("audit", { open: () => openAudit(), go: () => saveAudit() });
  on("ruletestb17", () => { P.result = null; ruleDlg(); });
  on("rulerunb17", () => runRule());
  on("rulepickb17", (el) => { const box = $("#rule-in-b17"); if (box) box.value = el.dataset.v; runRule(); });
  on("fwb17", () => openFw());
  on("fwtestb17", () => testFw());
  on("whyb17", () => openWhy());
  on("whyputb17", (el) => putBack(el));
  on("estopb17", () => stopDlg());
  on("estopgob17", () => stop());
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.target?.id === "rule-in-b17") { e.preventDefault(); runRule(); }
    if (e.target?.id === "fw-in-b17") { e.preventDefault(); testFw(); }
  });
  markLive(["ruletestb17", "rulerunb17", "rulepickb17", "fwb17", "fwtestb17", "whyb17", "whyputb17", "estopb17", "estopgob17", "sw:rule-in-b17", "sw:fw-in-b17"]);
  load17();
}
