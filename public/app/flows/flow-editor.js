/* A procedure as a picture (the prototype's flow editor), opened from Automations › Procedures. Two kinds of record open
   here, and only one can change:
   - A procedure that starts itself (GET /api/autonomy/procedures): its start and its steps, each a request to a Trunk
     ("Ask a Trunk") or one that asks the owner first ("Ask me"). Adding, moving and taking out steps is a draft in the
     window; Save opens the prototype's "Change …?" with the difference, and "Approve version N" is the same owner's yes a
     new procedure gets: the change is asked (POST /api/autonomy/procedures/<id>/propose) and answered
     (POST /api/autonomy/decide). It stays the same procedure; the version before is kept in its history, and "Go back to
     this" is itself such a change. "If it says", "When" and "Wait" steps have no engine form, so they stay greyed.
   - A saved recipe (GET /api/state `procedures`: tool calls with exact expected results): drawn read-only. The engine
     has no route that saves edited recipe steps, so its editing controls and Run stay greyed. */

import { esc, paint } from "../core/dom.js";
import { openDlg, closeDlg, dialog, ic, toast } from "../core/ui.js";
import { E, refresh } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { api } from "../core/api.js";

const OFF = ' disabled aria-disabled="true" data-tip="Coming soon"';
const KINDS = [["when", "When"], ["do", "Ask a Trunk"], ["if", "If it says"], ["ask", "Ask me"], ["wait", "Wait"]];
const EDITABLE = new Set(["do", "ask"]);
let F = null; // the open procedure: { record, steps: [{ kind, text, orig }] }

/* The prototype's picture: one box per step, joined top to bottom; a start is the accented "When" box. */
function flowSVG(boxes) {
  const W = 560, cx = W / 2, bh = 38, gap = 24, parts = [];
  let y = 10;
  const cut = (t, w) => { const n = Math.floor(w / 7.2); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
  boxes.forEach((b, i) => {
    const label = ({ when: "When: ", ask: "Ask me: " }[b.kind] ?? "") + (b.text || "…");
    parts.push(`<rect x="${cx - 160}" y="${y}" width="320" height="${bh}" rx="10" fill="${b.kind === "ask" ? "var(--accent-tint)" : "var(--raise)"}" stroke="${b.kind === "when" ? "var(--accent)" : "var(--line-2)"}" stroke-width="1.5"/><text x="${cx}" y="${y + bh / 2 + 4}" text-anchor="middle">${esc(cut(label, 304))}</text>`);
    y += bh;
    if (i < boxes.length - 1) { parts.push(`<path d="M${cx} ${y} C ${cx} ${y + gap / 2}, ${cx} ${y + gap / 2}, ${cx} ${y + gap}" stroke="var(--ink-3)" stroke-width="1.5" fill="none" marker-end="url(#fa)"/>`); y += gap; }
  });
  return `<svg class="flow-svg" viewBox="0 0 ${W} ${y + 10}" role="img" aria-label="The procedure as a picture"><defs><marker id="fa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--ink-3)"/></marker></defs>${parts.join("")}</svg>`;
}

/* ---------- a saved recipe: read-only ---------- */

const argsText = (args) => { const text = JSON.stringify(args ?? {}); return text === "{}" ? "" : text.length > 160 ? text.slice(0, 159) + "…" : text; };
function openRecipe(id) {
  const record = (E.state?.procedures ?? []).find((p) => p.id === id);
  if (!record) return;
  const steps = Array.isArray(record.data?.definition?.steps) ? record.data.definition.steps : [];
  const rows = steps.map((s, j) => `<div class="flow-row"><input class="inp" id="ft-${j}" value="${esc([s.tool, argsText(s.args)].filter(Boolean).join(" "))}" readonly aria-label="Step ${j + 1}">
    <span class="acts" data-css="gap:0"><button class="btn ghost sm soon" type="button"${OFF}>Move up</button><button class="btn ghost sm soon" type="button"${OFF}>Move down</button><button class="btn ghost sm soon" type="button"${OFF}>Take it out</button></span></div>`).join("");
  openDlg({ title: String(record.data?.definition?.name ?? ""), wide: true,
    body: `<div id="flow-pic">${flowSVG(steps.map((s) => ({ kind: "do", text: String(s.tool ?? "") })))}</div><div>${rows}</div><div class="acts"><button class="btn soon" type="button"${OFF}>${ic("plus", "s")}Add a step</button><span class="tb-grow"></span><button class="btn soon" type="button"${OFF}>${ic("play", "s")}Run</button><button class="btn pri soon" type="button"${OFF}>Save</button></div>` });
}

/* ---------- a procedure that starts itself: a draft, then a proposal ---------- */

const draftOf = (steps) => steps.map((s) => ({ kind: s.confirm ? "ask" : "do", text: s.prompt, orig: s }));
const stepText = (s) => (s.kind === "ask" ? "Ask me: " : "") + (s.text || "");
const titleOf = (text) => { const line = text.trim().split("\n")[0]; return line.length > 60 ? line.slice(0, 59) + "…" : line; };
/* Unchanged steps keep their own title; a new or edited one is named by its first line. */
const engineSteps = (draft) => draft.map((s) => ({ title: s.orig && s.orig.prompt === s.text.trim() ? s.orig.title : titleOf(s.text), prompt: s.text.trim(), confirm: s.kind === "ask" }));

function flowRow(s, j, n) {
  const field = s.kind === "ask" ? "The question" : "What to ask";
  const kinds = KINDS.map(([k, l]) => `<option value="${k}" ${s.kind === k ? "selected" : ""} ${EDITABLE.has(k) ? "" : "disabled"}>${l}</option>`).join("");
  return `<div class="flow-row"><select class="inp" id="fk-${j}" data-flow="kind" data-j="${j}" aria-label="Kind of step ${j + 1}">${kinds}</select><input class="inp" id="ft-${j}" data-flow="text" data-j="${j}" value="${esc(s.text)}" placeholder="${field}" aria-label="${field}, step ${j + 1}">
    <span class="acts" data-css="gap:0"><button class="btn ghost sm" type="button" data-act="flow-mv" data-j="${j}" data-d="-1" ${j === 0 ? "disabled" : ""}>Move up</button><button class="btn ghost sm" type="button" data-act="flow-mv" data-j="${j}" data-d="1" ${j === n - 1 ? "disabled" : ""}>Move down</button><button class="btn ghost sm" type="button" data-act="flow-rm" data-j="${j}">Take it out</button></span></div>`;
}
const pictureOf = () => flowSVG([{ kind: "when", text: F.record.starts }, ...F.steps]);

function historyList(r) {
  const versions = [{ version: r.version ?? 1, from: r.changedAt ?? r.createdAt, now: true }, ...(r.history ?? []).slice().reverse()];
  const when = (iso) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
  return `<div class="fh17d"><b>History</b><ol>${versions.map((x) => `<li><span class="grow"><b>Version ${x.version}</b><small>${esc(when(x.from))}</small></span>${x.now ? '<span class="pill ok"><i></i>In use</span>' : `<button class="btn ghost sm" type="button" data-act="ppold17d" data-v="${x.version}">Go back to this</button>`}</li>`).join("")}</ol></div>`;
}

function drawFlow() {
  const r = F.record;
  markLive(F.steps.flatMap((_, j) => [`sw:ft-${j}`, `sw:fk-${j}`]));
  openDlg({ title: r.procedure.name, wide: true,
    body: `<p class="hint" data-css="margin:0">${esc(r.starts)}. The picture redraws as you change the steps.</p><div id="flow-pic">${pictureOf()}</div><div>${F.steps.map((s, j) => flowRow(s, j, F.steps.length)).join("")}</div><div class="acts"><button class="btn" type="button" data-act="flow-add">${ic("plus", "s")}Add a step</button><span class="tb-grow"></span><button class="btn" type="button" data-act="flow-run">${ic("play", "s")}Run</button><button class="btn pri" type="button" data-act="flow-save">Save</button></div>${historyList(r)}` });
}

async function openAuto(id) {
  let list;
  try { list = (await api("autonomy/procedures")).procedures ?? []; } catch (error) { toast(error.message); return; }
  const record = list.find((p) => p.id === id);
  if (!record) return;
  F = { record, steps: draftOf(record.procedure.steps) };
  drawFlow();
}

/* The prototype's line difference: the longest run kept, the rest added or taken out. */
function diffSteps(a, b) {
  const A = a.map(stepText), B = b.map(stepText), L = Array.from({ length: A.length + 1 }, () => Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { out.push(["same", A[i]]); i++; j++; }
    else if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) { out.push(["add", B[j]]); j++; }
    else { out.push(["rm", A[i]]); i++; }
  }
  return out;
}

let PP = null; // the change on show: { steps (engine form), start, v }
function propDlg(draft, why, start) {
  const cur = F.record.version ?? 1, v = cur + 1, d = diffSteps(draftOf(F.record.procedure.steps), draft);
  const add = d.filter((x) => x[0] === "add").length, rm = d.filter((x) => x[0] === "rm").length;
  PP = { steps: engineSteps(draft), start, v };
  openDlg({ title: `Change “${F.record.procedure.name}”?`, wide: true,
    body: `<p data-css="margin:0 0 4px">Your edit. Nothing changes until you approve it. It stays the same procedure, as version ${v}; version ${cur} is kept in its history.</p>${why ? `<p class="hint" data-css="margin:0 0 8px">Why: ${esc(why)}</p>` : ""}
    <div class="df-k17d">${add ? `<span class="add">+${add} added</span>` : ""}${rm ? `<span class="rm">−${rm} taken out</span>` : ""}<span>version ${cur} → ${v}</span></div>
    <ol class="df17d">${d.map(([k, t]) => `<li class="${k}"><em>${k === "add" ? "+" : k === "rm" ? "−" : ""}</em><span>${esc(t)}</span></li>`).join("")}</ol>`,
    foot: `<button class="btn ghost" type="button" data-act="ppback17d">Back to editing</button><button class="btn pri" type="button" data-act="ppapprove17d" ${add + rm || start ? "" : "disabled"}>Approve version ${v}</button>` });
}

function save() {
  const bad = F.steps.findIndex((s) => !s.text.trim());
  if (bad >= 0) { const box = document.getElementById(`ft-${bad}`); box?.focus(); box?.setAttribute("aria-invalid", "true"); return; }
  if (JSON.stringify(F.steps.map(stepText)) === JSON.stringify(draftOf(F.record.procedure.steps).map(stepText))) { closeDlg(); return; }
  propDlg(F.steps);
}

/* The owner's yes: the change is asked the way any procedure change is, and answered at once. */
async function approve() {
  const { steps, start, v } = PP;
  try {
    const asked = await api(`autonomy/procedures/${encodeURIComponent(F.record.id)}/propose`, { steps, ...(start ? { start } : {}) });
    if (!asked.id) { toast(asked.said); return; }
    await api("autonomy/decide", { id: asked.id, yes: true });
  } catch (error) { toast(error.message); return; }
  closeDlg();
  F = null;
  await refresh().catch((error) => toast(error.message));
  toast(`Version ${v} approved. It runs the new way next time; the old version is kept.`);
}

function goBack(version) {
  const old = (F.record.history ?? []).find((x) => x.version === version);
  if (!old) return;
  const start = JSON.stringify(old.start) === JSON.stringify(F.record.procedure.start) ? undefined : old.start;
  propDlg(draftOf(old.steps), `Going back to version ${version}. It becomes a new version, so nothing in the history is lost.`, start);
}

/* Typing redraws the picture; a new kind redraws the row. */
function listenDraft() {
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (!F || el.dataset?.flow !== "text") return;
    F.steps[+el.dataset.j].text = el.value;
    const pic = dialog()?.querySelector("#flow-pic");
    if (pic) paint(pic, pictureOf());
  });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!F || el.dataset?.flow !== "kind" || !EDITABLE.has(el.value)) return;
    F.steps[+el.dataset.j].kind = el.value;
    drawFlow();
  });
}

export function init() {
  markLive(["flow", "flow-add", "flow-mv", "flow-rm", "flow-save", "ppback17d", "ppapprove17d", "ppold17d"]);
  on("flow", (el) => (el.dataset.v === "auto" ? openAuto(el.dataset.id) : openRecipe(el.dataset.id)));
  on("flow-add", () => { F.steps.push({ kind: "do", text: "" }); drawFlow(); setTimeout(() => document.getElementById(`ft-${F.steps.length - 1}`)?.focus(), 0); });
  on("flow-mv", (el) => { const j = +el.dataset.j, d = +el.dataset.d, s = F.steps; [s[j], s[j + d]] = [s[j + d], s[j]]; drawFlow(); });
  on("flow-rm", (el) => { F.steps.splice(+el.dataset.j, 1); drawFlow(); });
  on("flow-save", () => save());
  on("ppback17d", () => drawFlow());
  on("ppapprove17d", () => approve());
  on("ppold17d", (el) => goBack(+el.dataset.v));
  listenDraft();
}
