/* Pass 17 part D §3: "Learn this app or workflow", the behaviour-workbook skill, in Customize › Tools › Skills, 1:1 with
   the prototype's patch17d.js. Everything is the engine's (src/workbooks.ts): the switch (GET /api/workbooks,
   POST /api/workbooks/settings), Start learning (POST /api/workbooks/learn: a real task, narrowed to the browser and the
   web, that saves the workbook), each workbook (GET /api/workbooks/<id>), Run the checks again (POST .../rerun), Make it
   a skill (POST .../skill: installed switched off, for the owner to review), and Save the workbook (GET .../markdown,
   saved as a Markdown file). While a workbook is learning the window asks again every two seconds; no stage or count is
   drawn that the engine did not say. Every word a workbook holds came from the pages it read, so all of it is escaped.
   Where the checks run is only Branch's own browser: a private computer is not in this build, so that choice is greyed. */

import { esc, render } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { ic, toast, openDlg, dialog } from "../core/ui.js";

export const LEARN_ID = "learn17d";
const W = { mode: null, list: [], open: null, tab: "must", what: "", timer: null, waiting: new Map() };
const STAGES = [["Read it", "Pages, help and settings"], ["Write the MUST list", "Numbered, one behaviour each"], ["Derive the checks", "Two or three per MUST"], ["Run them for real", "On a computer it may use"]];

const pill = (cls, text) => `<span class="pill ${cls}"><i></i>${esc(text)}</span>`;
const when = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const tally = (w) => { const n = (s) => w.must.filter((m) => m.status === s).length; return { pass: n("pass"), fail: n("fail"), unclear: n("unclear"), all: w.must.length }; };

/** The built-in skill, first in the skills list. */
export const learnItem = () => ({ id: LEARN_ID, name: "learn-this", sub: "Learn an app, site or workflow: write what it must do, then prove each point on the real thing.", icon: "book17d" });

/** The card at the top of the list whenever another skill is selected. */
export const learnTile = () => `<div class="tile wb-tile17d"><div class="th"><span class="ico-tile">${ic("book17d", "s")}</span><b>Learn an app or workflow</b></div><p>Branch reads it, writes what it must do, and proves each point on the real thing.</p><div class="acts"><button class="btn sm" type="button" data-act="t9-sel" data-v="${LEARN_ID}">Try it</button></div></div>`;

async function loadBooks() {
  if (E.profiles?.isOwner === false) return; // the owner's alone: the engine refuses anyone else
  const got = await api("workbooks").catch((error) => { toast(error.message); return null; });
  if (!got) return;
  const before = new Map(W.list.map((w) => [w.id, w.status]));
  W.mode = got.mode;
  W.list = got.workbooks;
  settled(before);
  render();
  follow();
}
/* A workbook that was learning and now is not: say how it went, in the engine's words, and open a new one. */
function settled(before) {
  for (const w of W.list) {
    if (before.get(w.id) !== "learning" || w.status === "learning") continue;
    const why = W.waiting.get(w.id);
    W.waiting.delete(w.id);
    if (w.status === "failed") { toast(w.error); continue; }
    const t = tally(w);
    if (why === "rerun" && w.changed === false) toast("Same result. Nothing changed since the last run.");
    else toast(`Workbook ready: ${t.pass} of ${t.all} proved.`);
    if (why === "new" && !dialog()) { W.open = w.id; W.tab = "must"; wbDlg(); }
    else if (W.open === w.id && dialog()?.querySelector(".wbv17d")) wbDlg();
  }
}
function follow() {
  clearTimeout(W.timer);
  if (W.list.some((w) => w.status === "learning")) W.timer = setTimeout(loadBooks, 2000);
}

export function learnDetail() {
  if (W.mode === null) { if (!W.asked) { W.asked = true; loadBooks(); } return '<div class="t9-detail wb17d"></div>'; }
  const running = W.list.some((w) => w.status === "learning");
  const browser = true; // the only place checks run in this build
  const rows = W.list.map((w) => {
    const t = tally(w), state = w.status === "learning" ? pill("work", "Learning…") : w.status === "ready" ? pill(t.fail ? "warn" : "ok", `${t.pass} of ${t.all} pass`) : "";
    const sub = w.status === "failed" ? w.error : `${w.source || w.name} · ${when(w.updatedAt)}`;
    return `<div class="prow wb-row17d"><span class="grow"><b>${esc(w.name)}</b><small>${esc(sub)}</small></span>${state}${w.status === "ready" ? `<button class="btn sm" type="button" data-act="wbopen17d" data-id="${esc(w.id)}">Open</button>` : ""}</div>`;
  }).join("");
  return `<div class="t9-detail wb17d"><div class="t9-dh"><span class="ico-tile t9i" data-css="width:40px;height:40px">${ic("book17d", "s")}</span><span class="grow"><b>learn-this</b><small>Built in · learns an app or workflow and proves what it learned</small></span><input type="checkbox" class="sw" id="wb-on17d" ${W.mode === "on" ? "checked" : ""} aria-label="learn-this on or off"></div>
    <div class="sec"><h2>How it works</h2><ol class="wb-how17d">${STAGES.map(([t, s], i) => `<li><em>${i + 1}</em><span><b>${t}</b><small>${s}</small></span></li>`).join("")}</ol><p class="hint">It writes a workbook: what the app MUST do, the checks for each point, and which passed on the real thing. A Trunk then works from what was proved, not from guesses.</p></div>
    <div class="sec"><h2>Learn something new</h2><label class="fld"><span>An app, a site or a workflow</span><input class="inp" id="wb-what17d" value="${esc(W.what)}" autocomplete="off"></label>
      <div class="fld"><span>Where it runs the checks</span><span class="seg"><button type="button" data-act="wbwhere17d" data-v="private" aria-pressed="false">Private computer</button><button type="button" aria-pressed="${browser}" disabled>Sealed browser only</button></span><small class="hint">Checks that would send, buy or delete are written down but never run.</small></div>
      <div class="acts"><button class="btn pri sm" type="button" data-act="wbstart17d" ${running || W.mode !== "on" ? "disabled" : ""}>${running ? "Learning…" : "Start learning"}</button></div></div>
    <div class="sec"><h2>Workbooks</h2><div class="rows">${rows}</div></div></div>`;
}

function wbList(w) {
  const mark = (s) => (s === "pass" ? pill("ok", "Pass") : s === "fail" ? pill("no", "Fails") : pill("idle", "Not proved"));
  if (W.tab === "must") return `<ol class="wb-must17d">${w.must.map((m, i) => `<li class="${m.status}"><span class="wb-n17d">MUST ${i + 1}</span><span class="grow"><b>${esc(m.text)}</b><small>${m.checks.length} ${m.checks.length === 1 ? "check" : "checks"}</small></span>${mark(m.status)}</li>`).join("")}</ol>`;
  if (W.tab === "checks") return `<ol class="wb-checks17d">${w.must.map((m, i) => `<li><b>MUST ${i + 1} · ${esc(m.text)}</b><ul>${m.checks.map((c) => `<li class="${m.status}">${ic(m.status === "pass" ? "check" : m.status === "fail" ? "x" : "info", "s")}${esc(c)}</li>`).join("")}</ul></li>`).join("")}</ol>`;
  const rows = w.must.map((m, i) => (m.status === "pass" ? "" : `<div class="status"><span class="sdot ${m.status === "fail" ? "bad" : ""}"></span><div><b>MUST ${i + 1}: ${esc(m.text)}</b><p>${m.found ? `${esc(m.found)}. ` : ""}${m.status === "fail" ? "The workbook now says what really happens, so a Trunk won’t count on it." : "Written down to check again later."}</p></div></div>`)).join("");
  return `<div class="wb-fail17d">${rows || '<p class="empty">Everything passed.</p>'}</div>`;
}
function wbDlg() {
  const w = W.list.find((x) => x.id === W.open);
  if (!w) return;
  const t = tally(w), share = t.all ? Math.round((t.pass / t.all) * 100) : 0;
  const ring = `<span class="wb-ring17d" role="img" aria-label="${t.pass} of ${t.all} pass"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" pathLength="100"/><circle class="wb-arc17d" cx="18" cy="18" r="15" pathLength="100" data-css="stroke-dasharray:${share} 100"/></svg><b>${t.pass}/${t.all}</b></span>`;
  const head = `<div class="wbv-h17d">${ring}<span class="grow"><b>${t.pass} of ${t.all} proved on the real thing</b><small>${esc(w.source || w.name)} · read ${w.pages} pages · ran on Sealed browser only · ${esc(when(w.updatedAt))}</small><span class="wbv-k17d">${pill("ok", `${t.pass} pass`)}${t.fail ? pill("no", `${t.fail} fail`) : ""}${t.unclear ? pill("idle", `${t.unclear} not proved`) : ""}</span></span></div>`;
  const tabs = [["must", "What it must do"], ["checks", "The checks"], ["fail", "What didn’t pass"]].map(([v, l]) => `<button class="tab" role="tab" type="button" aria-selected="${W.tab === v}" data-act="wbtab17d" data-v="${v}">${l}</button>`).join("");
  const learning = w.status === "learning";
  openDlg({ title: w.name, wide: true, body: `<div class="wbv17d">${head}<div class="tabs" role="tablist" data-css="margin:12px 0 8px">${tabs}</div>${wbList(w)}</div>`,
    foot: `<button class="btn ghost" type="button" data-act="wbexport17d">Save the workbook</button><button class="btn" type="button" data-act="wbrerun17d" ${learning ? "disabled" : ""}>Run the checks again</button><button class="btn pri" type="button" data-act="wbskill17d" ${w.skillId || learning ? "disabled" : ""}>${w.skillId ? "Skill made" : "Make it a skill"}</button>` });
}

async function start() {
  const what = (document.getElementById("wb-what17d")?.value ?? W.what).trim();
  W.what = what;
  try {
    const { workbook } = await api("workbooks/learn", { what, where: "browser" });
    W.waiting.set(workbook.id, "new");
    W.what = "";
    await loadBooks();
  } catch (error) { toast(error.message); }
}
async function rerun() {
  try {
    await api(`workbooks/${encodeURIComponent(W.open)}/rerun`, {});
    W.waiting.set(W.open, "rerun");
    await loadBooks();
    wbDlg();
  } catch (error) { toast(error.message); }
}
async function makeSkill() {
  try {
    const made = await api(`workbooks/${encodeURIComponent(W.open)}/skill`, {});
    await loadBooks();
    wbDlg();
    toast(`Skill “${made.name}” made.`);
  } catch (error) { toast(error.message); }
}
async function saveMarkdown() {
  try {
    const { name, markdown } = await api(`workbooks/${encodeURIComponent(W.open)}/markdown`);
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([markdown], { type: "text/markdown" })), download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (error) { toast(error.message); }
}
async function setMode(on) {
  try { await api("workbooks/settings", { mode: on ? "on" : "off" }); } catch (error) { toast(error.message); }
  await loadBooks();
}

export function initLearn17d() {
  markLive(["wbstart17d", "wbopen17d", "wbtab17d", "wbrerun17d", "wbskill17d", "wbexport17d", "sw:wb-what17d", "sw:wb-on17d"]);
  on("wbstart17d", () => start());
  on("wbopen17d", (el) => { W.open = el.dataset.id; W.tab = "must"; wbDlg(); });
  on("wbtab17d", (el) => { W.tab = el.dataset.v; wbDlg(); });
  on("wbrerun17d", () => rerun());
  on("wbskill17d", () => makeSkill());
  on("wbexport17d", () => saveMarkdown());
  document.addEventListener("input", (e) => { if (e.target.id === "wb-what17d") W.what = e.target.value; });
  document.addEventListener("change", (e) => { if (e.target.id === "wb-on17d") setMode(e.target.checked); });
}
