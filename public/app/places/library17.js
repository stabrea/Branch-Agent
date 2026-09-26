/* Library, pass 17 (patch17b.js, SHOWCASE17 rows 20-22, 127-131, 140, 143-145, 148, 153, 212 and 213).
   Documents:
   - Ask a spreadsheet: one read-only SQL question over a spreadsheet in the library that was added from a workspace file
     (POST /api/data/ask), answered with the engine's table and a bar chart drawn from its rows. Saving it as a report
     stays greyed: the engine's report route builds the file's text and keeps nothing.
   - Compare or edit exactly: two library documents compared by the engine's documents.compare (POST /api/action, a read).
     Saving the comparison and "Make the edit" stay greyed: nothing keeps a comparison, and an exact edit needs a request
     a model turns into the change.
   - Labels (Advanced): the engine's label catalogue (GET /api/labels); a label shows only the documents that carry it.
   - Map › Ask the map: the most-mentioned names of the first map the engine has built (GET /api/knowledge/extras, POST
     /api/knowledge/graph/names); a name shows what the documents say about it (POST /api/knowledge/graph). No route gives
     the whole map to draw, so no picture of it is drawn.
   - Managing what it reads (Advanced): knowledge bases (GET /api/knowledge), a guided tour of this workspace's code
     (POST /api/learn/tour, refused in the engine's words while switched off), synced sources (GET /api/asks/sources) and
     kept pages (GET /api/asks/pages). Merging, starting the tour in a conversation, syncing (it reaches other services)
     and writing an article stay greyed.
   Memory › How it learns (Advanced): patterns it noticed (GET /api/memory/learned; Keep all stages them and accepts each,
   POST /api/memory/learned then /api/memory/proposals/<id>/accept), the timeline (GET /api/learning-more/journey), the
   versions of the newest fact (GET /api/memory/versions, put back with POST /api/memory/versions/restore), forgetting what
   one conversation taught (POST /api/memory/forget/preview, then /api/memory/forget), checkpoints (GET and POST
   /api/memory/checkpoints) and bringing memories in from a JSON Lines file (POST /api/memory/import). */

import { esc, renderNow } from "../core/dom.js";
import { E, level, refresh } from "../core/state.js";
import { ic, toast, openDlg, closeDlg, dialog } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { onDemo17, demoPlace17, demoDlg17 } from "./demo17.js";
import { list17, when17 } from "./parts17.js";

const L = { labels: { catalog: [], labels: [] }, label: null, graph: null, names: [], kg: null, links: [], problem: "" };
const askable = (d) => Boolean(d.filePath) && /\.(csv|tsv|json|xlsx)$/i.test(d.filePath);
const tableName = (path) => { const base = String(path).split("/").pop().replace(/\.[a-z0-9]+$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 39); return /^[a-z]/.test(base) ? base : `t_${base || "data"}`.slice(0, 40); };
const documents = async () => (await api("documents")).documents ?? [];

/* ---------- Work with documents ---------- */
export function workSection() {
  const tools = [["sqlb17", "term", "Ask a spreadsheet", "Questions in plain words or SQL, answered with a table and a chart. Read only."], ["doccmpb17", "doc", "Compare or edit exactly", "What changed between two versions, and edits that leave every other byte as it was."]];
  const labels = level() >= 1 && L.labels.catalog.length ? `<div class="labels-b17" role="group" aria-label="Labels"><span>Labels</span>${L.labels.catalog.map((l) => `<button type="button" class="chip-b17" data-act="labelb17" data-v="${esc(l.label)}" aria-pressed="${L.label === l.label}">${esc(l.label)} <em>${esc(l.count)}</em></button>`).join("")}</div>` : "";
  return `<div class="sec x15-sec"><h2>Work with documents</h2><div class="tools-b17">${tools.map(([a, i, t, s]) => `<button type="button" class="tool-b17" data-act="${a}"><span class="ico-tile">${ic(i, "s")}</span><span><b>${t}</b><small>${s}</small></span></button>`).join("")}</div>${labels}</div>`;
}
/* The documents a chosen label leaves showing; every document while none is chosen. */
export function labelled(docs) {
  if (!L.label) return docs;
  const ids = new Set(L.labels.labels.filter((x) => x.target === "document" && x.label === L.label).map((x) => x.targetId));
  return docs.filter((d) => ids.has(d.id));
}

/* ---------- Ask a spreadsheet ---------- */
const SQ = { files: [], f: null, sql: "", result: null };
function sqlChart(columns, rows) {
  if (columns.length !== 2 || !rows.length || !rows.every((r) => typeof r[1] === "number")) return "";
  const mx = Math.max(...rows.map((r) => Math.abs(r[1]))) || 1, h = 24;
  return `<svg class="chart-b17" viewBox="0 0 320 ${rows.length * h + 6}" role="img" aria-label="Bar chart of the result">${rows.map(([l, v], i) => `<text x="0" y="${i * h + 16}">${esc(String(l).slice(0, 18))}</text><rect x="110" y="${i * h + 5}" width="${Math.max(2, (Math.abs(v) / mx) * 160).toFixed(1)}" height="14" rx="3"/><text class="v-b17" x="${(116 + (Math.abs(v) / mx) * 160).toFixed(1)}" y="${i * h + 16}">${esc(v.toLocaleString())}</text>`).join("")}</svg>`;
}
function sqlResult() {
  const r = SQ.result;
  if (!r) return '<p class="hint" data-css="margin:0">Run it to see the table and the chart.</p>';
  const head = r.columns.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = r.rows.map((row) => `<tr>${row.map((v) => `<td>${esc(v === null ? "" : typeof v === "number" ? v.toLocaleString() : v)}</td>`).join("")}</tr>`).join("");
  return `<div class="res-b17"><table class="tbl-b17"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${sqlChart(r.columns, r.rows)}</div>`;
}
function drawSql() {
  const files = SQ.files.map((d) => `<button type="button" data-act="sqlfileb17" data-v="${esc(d.id)}" aria-pressed="${SQ.f === d.id}">${esc(d.name)}</button>`).join("");
  openDlg({ title: "Ask a spreadsheet", wide: true,
    body: `<div class="seg" role="group" aria-label="File">${files}</div><textarea class="inp sql-b17" id="sql-q-b17" rows="3" aria-label="SQL" spellcheck="false">${esc(SQ.sql)}</textarea>${sqlResult()}<p class="hint" data-css="margin:0">Read only: only SELECT runs, and the file is never changed.</p>`,
    foot: `${SQ.result ? '<button class="btn ghost" type="button" data-act="sqlsaveb17">Save as a report</button>' : ""}<button class="btn pri" type="button" data-act="sqlrunb17" ${SQ.f ? "" : "disabled"}>${SQ.result ? "Run again" : "Run"}</button>` });
}
async function openSql() {
  try { SQ.files = (await documents()).filter(askable); } catch (error) { toast(error.message); return; }
  if (!SQ.files.some((d) => d.id === SQ.f)) pickFile(SQ.files[0]?.id ?? null);
  drawSql();
}
function pickFile(id) {
  SQ.f = id;
  SQ.result = null;
  const doc = SQ.files.find((d) => d.id === id);
  SQ.sql = doc ? `SELECT * FROM ${tableName(doc.filePath)}` : "";
}
async function runSql() {
  SQ.sql = document.getElementById("sql-q-b17")?.value ?? SQ.sql;
  try { SQ.result = await api("data/ask", { document: SQ.f, sql: SQ.sql }); } catch (error) { toast(error.message); return; }
  drawSql();
}

/* ---------- Compare or edit exactly ---------- */
const DC = { mode: "compare", docs: [], a: null, b: null, result: null };
const docSelect = (id, value) => `<select class="inp" id="${id}" data-sw="${id}" aria-label="${id === "doc-a-b17" ? "First document" : "Second document"}">${DC.docs.map((d) => `<option value="${esc(d.id)}"${d.id === value ? " selected" : ""}>${esc(d.name)}</option>`).join("")}</select>`;
function compareBody() {
  const r = DC.result;
  const diffs = r ? `<p class="lead-b17">${esc(r.summary)}</p><div class="diffs-b17">${r.changes.map((c) => `<div class="dif-b17"><small>${esc(c.section)}</small>${c.before ? `<del>${esc(c.before)}</del>` : ""}${c.after ? `<ins>${esc(c.after)}</ins>` : ""}</div>`).join("")}</div><p class="hint" data-css="margin:0">The other ${esc(r.unchanged)} paragraphs are identical, formatting included.</p>` : "";
  return `<div class="test-b17">${docSelect("doc-a-b17", DC.a)}${docSelect("doc-b-b17", DC.b)}</div>${diffs}`;
}
function drawDoc() {
  const m = DC.mode;
  openDlg({ title: m === "compare" ? "Compare two documents" : "Edit exactly", wide: true,
    body: `<div class="seg" role="group" aria-label="What to do">${[["compare", "Compare"], ["edit", "Edit exactly"]].map(([v, l]) => `<button type="button" data-act="docmodeb17" data-v="${v}" aria-pressed="${m === v}">${l}</button>`).join("")}</div>${m === "compare" ? compareBody() : ""}`,
    foot: m === "compare" ? '<button class="btn" type="button" data-act="dlg-close">Close</button><button class="btn pri" type="button" data-act="docsaveb17" data-v="compare">Save the comparison</button>' : '<button class="btn ghost" type="button" data-act="dlg-close">Not now</button><button class="btn pri" type="button" data-act="docsaveb17" data-v="edit">Make the edit</button>' });
}
async function compareNow() {
  const a = DC.docs.find((d) => d.id === DC.a), b = DC.docs.find((d) => d.id === DC.b);
  DC.result = null;
  if (a && b && a !== b) {
    try { DC.result = await api("action", { tool: "documents.compare", args: { file: a.filePath, against: b.filePath } }); } catch (error) { toast(error.message); }
  }
  drawDoc();
}
async function openDoc() {
  try { DC.docs = (await documents()).filter((d) => d.filePath); } catch (error) { toast(error.message); return; }
  if (!DC.docs.some((d) => d.id === DC.a)) DC.a = DC.docs[1]?.id ?? null;
  if (!DC.docs.some((d) => d.id === DC.b)) DC.b = DC.docs[0]?.id ?? null;
  await compareNow();
}

/* ---------- Ask the map ---------- */
export function mapSection(view) {
  if (view !== "map") return "";
  const chips = L.names.map((n) => `<button type="button" class="chip-b17" data-act="kgb17" data-v="${esc(n.name)}" aria-pressed="${L.kg === n.name}">${esc(n.name)}</button>`).join("");
  const links = L.kg ? `<ul class="kgl-b17">${L.links.map((k) => `<li><b>${esc(k.from)}</b> <span>${esc(k.relation)}</span> <b>${esc(k.to)}</b><small>from ${esc(k.citation?.document ?? "")}</small></li>`).join("")}</ul>` : "";
  return `<div class="sec x15-sec kg-b17"><h2>Ask the map</h2><p class="hint" data-css="margin:0 0 8px">Pick a name to see what the documents say about it.</p><div class="chips-b17">${chips}</div>${links}</div>`;
}
async function askMap(el) {
  const name = el.dataset.v;
  if (L.kg === name) { L.kg = null; renderNow(); return; }
  try { L.links = (await api("knowledge/graph", { collection: L.graph, entity: name })).links ?? []; } catch (error) { toast(error.message); return; }
  L.kg = name;
  renderNow();
}

/* ---------- Managing what it reads ---------- */
const MANAGE = [
  ["kbmanage", "folder", ["Knowledge bases", "Folders it reads, kept as quotable passages. Rename, merge, split and choose how long they stay.", "Manage"]],
  ["learnfolder", "teach", ["Understand a folder", "A map of a folder, then a short guided tour of what’s in it.", "Try it"]],
  ["sources", "retry", ["Bring things in from other services", "Keeps a copy of chosen items from Drive, Notion or a notes vault, in sync.", "See sources"]],
  ["pages", "doc", ["Kept answers and long articles", "An answer you like becomes a page you can reopen; a long article is written section by section.", "See pages"]],
];
export const manageSection = () => (level() >= 1 ? `<div class="sec x15-sec"><h2>Managing what it reads</h2><div class="rows">${MANAGE.map(([k, i, w]) => demoPlace17(k, i, w)).join("")}</div></div>` : "");

/* ---------- Memory › How it learns ---------- */
const LEARN = [
  ["habits", "spark", ["Habits it noticed", "Patterns in how you work, offered as memories you keep or drop.", "See them"]],
  ["learnlog", "clock", ["What it learned, week by week", "A timeline of new facts, skills and habits, and where each came from.", "Open the timeline"]],
  ["factver", "retry", ["Earlier versions of a fact", "Every change to a fact is kept, so an older one can come back.", "See an example"]],
  ["forgetconv", "x", ["Forget what one conversation taught", "Removes every fact that came from one conversation, and nothing else.", "Choose one"]],
  ["memckpt", "shield", ["Memory checkpoints", "A snapshot of memory and every skill version, to go back to all at once.", "See checkpoints"]],
  ["memimport", "folder", ["Bring memories in", "From a JSON Lines file or an archive Branch exported, here or on another computer.", "Choose a file"]],
];
export const learnSection = () => (level() >= 1 ? `<div class="sec x15-sec"><h2>How it learns</h2><div class="rows">${LEARN.map(([k, i, w]) => demoPlace17(k, i, w)).join("")}</div></div>` : "");

const FV = { memory: null, versions: [] };
const FC = { session: null, remove: [] };

function registerManage() {
  onDemo17("kbmanage", { open: async () => {
    const { collections } = await api("knowledge");
    demoDlg17("kbmanage", { title: "Knowledge bases", lead: "Your knowledge bases:", rows: list17(collections).map((c) => [c.name, `${c.documents} documents · ${c.chunks} passages`, c.note ? ["warn", c.note] : null]) });
  } });
  onDemo17("learnfolder", { open: async () => {
    const tour = await api("learn/tour", { subject: "code", of: "" });
    demoDlg17("learnfolder", { title: "Understand a folder", go: "Start the tour", rows: (tour.steps ?? []).map((s) => [`${s.order} · ${s.title}`, s.words, null]) });
  } });
  onDemo17("sources", { open: async () => {
    const { status } = await api("asks/sources");
    demoDlg17("sources", { title: "Bring things in from other services", lead: "Syncing:", go: "Sync now", rows: list17(status).map((s) => [s.id, [s.kind, s.syncedAt ? when17(s.syncedAt) : "", s.error].filter(Boolean).join(" · "), s.error ? ["warn", s.error.slice(0, 30)] : null]) });
  } });
  onDemo17("pages", { open: async () => {
    const { pages } = await api("asks/pages");
    demoDlg17("pages", { title: "Kept answers and long articles", lead: "Kept:", go: "Write an article", rows: list17(pages).map((p) => [p.title, p.question || when17(p.updatedAt), null]) });
  } });
}

function registerLearn() {
  onDemo17("habits", { open: async () => {
    const { noticed } = await api("memory/learned");
    demoDlg17("habits", { title: "Habits it noticed", go: noticed.length ? "Keep all" : undefined, rows: noticed.map((n) => [n.text, n.evidence?.[0] ?? "", ["idle", "Suggested"]]) });
  }, go: async () => {
    const { proposals } = await api("memory/learned", {});
    for (const p of proposals) await api(`memory/proposals/${encodeURIComponent(p.id)}/accept`, {});
    closeDlg();
    await refresh();
    toast(`Kept ${proposals.length} habits. Each one is in Memory and can be forgotten.`);
  } });
  onDemo17("learnlog", { open: async () => {
    const { entries } = await api("learning-more/journey?limit=50");
    demoDlg17("learnlog", { title: "What it learned, week by week", rows: entries.map((e) => [e.title, [when17(e.at), e.detail].filter(Boolean).join(" · "), ["idle", e.kind]]) });
  } });
  onDemo17("factver", { open: openVersions, go: restoreVersion });
  onDemo17("forgetconv", { open: () => openForget(), go: forgetConversation });
  onDemo17("memckpt", { open: async () => {
    const { checkpoints } = await api("memory/checkpoints");
    demoDlg17("memckpt", { title: "Memory checkpoints", lead: "Checkpoints:", go: "Make one now", rows: checkpoints.map((c) => [when17(c.createdAt), `${c.label} · ${c.memories} facts · ${c.skills} skills`, ["ok", "Kept"]]) });
  }, go: async () => {
    const made = await api("memory/checkpoints", {});
    closeDlg();
    toast(`Checkpoint made: ${made.memories} facts and ${made.skills} skills.`);
  } });
  onDemo17("memimport", { open: importMemories });
}

/* The versions of the most recently changed fact that has more than one; the one before the current is offered back. */
async function openVersions() {
  const changed = (E.state?.memory ?? []).filter((m) => Number(m.revision) > 1);
  const newest = changed.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  FV.memory = newest ?? null;
  FV.versions = newest ? (await api(`memory/versions?id=${encodeURIComponent(newest.id)}`)).versions ?? [] : [];
  const earlier = FV.versions.find((v) => v.revision < newest?.revision);
  demoDlg17("factver", { title: "Earlier versions of a fact", lead: newest?.data?.text ?? "", go: earlier ? `Put back the ${when17(earlier.createdAt)} version` : undefined,
    rows: FV.versions.map((v) => [v.data?.text ?? "", when17(v.createdAt), v.revision === newest.revision ? ["ok", "Current"] : ["idle", "Earlier"]]) });
}
async function restoreVersion() {
  const earlier = FV.versions.find((v) => v.revision < FV.memory?.revision);
  if (!earlier) return;
  await api("memory/versions/restore", { id: FV.memory.id, revision: earlier.revision });
  closeDlg();
  await refresh();
  toast(`Put back “${earlier.data?.text ?? ""}”. The newer one is kept as a version.`);
}

/* Forgetting one conversation: the conversations to choose from, then what the engine would remove from the chosen one. */
async function openForget(sessionId = FC.session) {
  FC.session = sessionId;
  FC.remove = sessionId ? (await api("memory/forget/preview", { sessionId })).remove ?? [] : [];
  const title = (s) => s.opening || s.title || "";
  const chips = E.sessions.slice(0, 12).map((s) => `<button type="button" class="chip-b17" data-act="fconvb17" data-v="${esc(s.sessionId ?? s.id)}" aria-pressed="${(s.sessionId ?? s.id) === FC.session}">${esc(title(s))}</button>`).join("");
  demoDlg17("forgetconv", { title: "Forget what one conversation taught", go: FC.remove.length ? `Forget these ${FC.remove.length}` : undefined, rows: FC.remove.map((m) => [m.text, when17(m.createdAt), ["idle", "Fact"]]) });
  dialog()?.querySelector(".dlg-b")?.insertAdjacentHTML("afterbegin", `<div class="chips-b17">${chips}</div>`);
}
async function forgetConversation() {
  const answer = await api("memory/forget", { sessionId: FC.session, ids: FC.remove.map((m) => m.id) });
  closeDlg();
  await refresh();
  toast(`Forgot ${answer.removed?.length ?? answer.removed ?? 0} facts. The conversation itself stays.`);
}

/* Bringing memories in: a JSON Lines file (or an archive Branch exported), sent as the engine's import takes it. */
function importMemories() {
  const input = Object.assign(document.createElement("input"), { type: "file", accept: ".jsonl,.json,application/json" });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const body = file.name.endsWith(".jsonl") ? { jsonl: text } : JSON.parse(text);
      const report = await api("memory/import", body);
      await refresh();
      if (!report.imported && report.skipped?.length) toast(report.skipped[0].reason);
      else toast(`Brought in ${report.imported ?? 0} facts.`);
    } catch (error) { toast(error.message); }
  });
  input.click();
}

/* ---------- reading ---------- */
async function readMap() {
  const { graphs } = await api("knowledge/extras");
  L.graph = list17(graphs)[0]?.collection ?? null;
  L.names = L.graph ? (await api("knowledge/graph/names", { collection: L.graph })).names ?? [] : [];
}
export async function readLibrary17(tab, view) {
  if (tab !== "documents") return { changed: false };
  const before = JSON.stringify([L.labels, L.names]);
  try {
    L.labels = await api("labels");
    if (view === "map") await readMap();
  } catch (error) { return { changed: false, error }; }
  return { changed: JSON.stringify([L.labels, L.names]) !== before };
}

export function initLibrary17() {
  markLive(["sqlb17", "sqlfileb17", "sqlrunb17", "sw:sql-q-b17", "doccmpb17", "docmodeb17", "sw:doc-a-b17", "sw:doc-b-b17", "labelb17", "kgb17", "fconvb17"]);
  on("sqlb17", () => openSql());
  on("sqlfileb17", (el) => { pickFile(el.dataset.v); drawSql(); });
  on("sqlrunb17", () => runSql());
  on("doccmpb17", () => openDoc());
  on("docmodeb17", (el) => { DC.mode = el.dataset.v; drawDoc(); });
  on("labelb17", (el) => { L.label = L.label === el.dataset.v ? null : el.dataset.v; renderNow(); });
  on("kgb17", (el) => askMap(el));
  on("fconvb17", (el) => openForget(el.dataset.v).catch((error) => toast(error.message)));
  document.addEventListener("change", (e) => {
    const id = e.target?.id;
    if (id !== "doc-a-b17" && id !== "doc-b-b17") return;
    if (id === "doc-a-b17") DC.a = e.target.value; else DC.b = e.target.value;
    compareNow();
  });
  registerManage();
  registerLearn();
}
