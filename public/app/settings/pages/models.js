/* Settings › Models, 1:1 with the prototype's five tabs, each drawn from the engine:
   Connections: every connection that can have several accounts, with its accounts (GET /api/accounts, flows/account.js);
   Defaults: the engine's model presets (GET /api/state models); On this computer: what Ollama has installed, and
   "Get another model", which downloads one of the engine's recommendations (POST /api/local-models/pull) and follows
   GET /api/local-models/downloads until it is done, with Stop (POST /api/local-models/stop). */
import { esc, renderNow, $ } from "../../core/dom.js";
import { level, E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { ic, toast, openDlg, dialog } from "../../core/ui.js";
import { logo } from "../../core/logos.js";
import { ctl } from "../parts.js";
import { A, loadAccounts, ownerOnly } from "../../flows/account.js";
import { L, loadLocal, gb, DOWNLOAD_ICON } from "./local.js";
import { sections17, init17 } from "../p17-models.js";
import { t } from "../../../i18n.js";

const TABS = [["connections", "Connections"], ["defaults", "Defaults"], ["local", "On this computer"], ["second", "Second opinion"], ["media", "Media"]];
let tab = "connections";
/* The download the dialog is following, by its Ollama name. */
let following = null;

function group(p) {
  const n = p.accounts.length;
  const rows = p.accounts.map((a) => `<div class="acct-r"><span class="grow"><b>${esc(a.label)}</b><small>${esc(p.name ?? p.pool)}</small></span>${p.defaultAccount === a.id ? '<span class="pill ok"><i></i>Answers first</span>' : '<span class="pill idle"><i></i>Next in line</span>'}<button class="icon-btn" type="button" aria-label="More for ${esc(a.label)}" data-act="acct-menu" data-pool="${esc(p.pool)}" data-id="${esc(a.id)}">${ic("more", "s")}</button></div>`).join("");
  return `<div class="acct-g"><div class="acct-gh">${logo(p.pool, p.name, 30)}<b>${esc(p.name ?? p.pool)}</b><span class="n6">${n ? `${n} ${n === 1 ? "account" : "accounts"}` : "Not set up"}</span></div>${rows}
    <button class="add-row" type="button" data-act="addacct" data-v="${esc(p.pool)}" ${ownerOnly()}>${ic("plus", "s")}${n ? `Add another ${esc(p.name ?? p.pool)} account` : `Sign in to ${esc(p.name ?? p.pool)}`}</button></div>`;
}

function connections() {
  return `<p class="hint" data-css="margin:2px 0 12px">You can sign in to the same service more than once. When one account runs low, Branch moves to the next. The order is in <button class="link" type="button" data-act="setpage" data-v="accounts">Settings › Accounts</button>.</p>
    <div class="acct-gs">${(A.view?.pools ?? []).map(group).join("")}</div>
    <div class="acts" data-css="margin-top:14px"><button class="btn pri" type="button" data-act="addacct" ${ownerOnly()}>${ic("plus", "s")}Add an account</button></div>`;
}

function defaults() {
  const m = E.state?.models;
  const presets = m?.presets ?? [];
  return [["Everyday answers", "Most conversations."], ["Planning and hard problems", "When a task has many steps."], ["Quick and cheap jobs", "Sorting, tagging, short replies."], ["Summaries", "Keeping long conversations short."]]
    .map(([n, s], i) => `<div class="ctl"><b>${n}</b><span class="right"><span class="seg">${presets.map((p) => `<button type="button" data-act="seg" aria-pressed="${i === 0 && p.id === m.defaultPreset}">${esc(p.name)}</button>`).join("")}</span></span><small>${s}</small></div>`).join("");
}

function local() {
  const have = L.data?.ollama?.models ?? [];
  const ready = have[0] ? `<div class="status"><span class="sdot"></span><div><b>${esc(have[0].name)} is ready on this computer</b><p>Loaded when first asked · nothing leaves this computer.</p></div></div>` : "";
  const rows = have.map((x) => `<div class="prow"><span class="ico-tile">${ic("cpu", "s")}</span><span class="grow"><b>${esc(x.name)}</b><small>${gb(x.size)}</small></span><button class="btn sm" type="button" data-act="toast">Use this</button></div>`).join("");
  return `${ready}<div class="rows" data-css="margin-top:10px">${rows}</div><div class="acts" data-css="margin-top:12px"><button class="btn" type="button" data-act="download">${DOWNLOAD_ICON}Get another model</button></div>`;
}

const BODIES = {
  connections, defaults, local,
  second: () => ctl("m-second", "Ask a second model on hard questions", "Shows both answers side by side when they disagree.", false),
  media: () => ctl("m-img", "Make pictures", "Uses your ChatGPT account.", false) + ctl("m-vid", "Make short videos", "Off until you choose a service.", false),
};

export function draw() {
  const lv = level();
  let html = `<h1>Models</h1><p class="lede">Which models answer, and where they run.</p><div class="tabs" role="tablist">${TABS.map(([id, l]) => `<button class="tab" role="tab" type="button" aria-selected="${tab === id}" data-act="mtab" data-v="${id}">${l}</button>`).join("")}</div>${BODIES[tab]()}`;
  if (lv >= 1) html += advanced();
  if (lv >= 2) html += TECHNICAL;
  return html + sections17(lv, tab);
}

/* ---------- Get another model ---------- */
function downloadBody() {
  const recs = L.data?.recommendations ?? [];
  return `<div class="rows">${recs.map((r) => `<div class="prow"><span class="ico-tile">${ic("cpu", "s")}</span><span class="grow"><b>${esc(r.model)}</b><small>${gb(r.downloadBytes)} · ${esc(r.expectation)}</small></span><button class="btn sm" type="button" data-act="dl-go" data-m="${esc(r.model)}" ${r.fits ? "" : "disabled"}>Download</button></div>`).join("")}</div>
    <div class="progress" id="dl-p" hidden><u id="dl-bar"></u></div><p class="hint" id="dl-t" data-css="margin:0"></p><div class="acts" id="dl-stop" data-css="display:none"><button class="btn ghost sm" type="button" data-act="lm-stop">Stop</button></div>`;
}

async function openDownload() {
  following = null;
  if (!L.data) await loadLocal();
  openDlg({ title: "Get another model", body: downloadBody() });
}

/* Draws the engine's own report of the download into the dialog: how far, and its words when it failed. */
function show(d) {
  const p = $("#dl-p"), bar = $("#dl-bar"), text = $("#dl-t"), stop = $("#dl-stop");
  if (!p || !d) return;
  p.hidden = false;
  bar.style.width = `${Math.max(0, Math.min(100, Math.round(d.percent ?? 0)))}%`;
  text.textContent = d.error ? d.error : d.done ? t("window.models.ready") : t("window.models.downloaded", { percent: Math.round(d.percent ?? 0) });
  stop.style.display = d.done ? "none" : "";
}

async function follow(model) {
  while (following === model && dialog()) {
    const { downloads } = await api("local-models/downloads");
    const d = (downloads ?? []).find((x) => x.model === model);
    show(d);
    if (!d || d.done) break;
    await new Promise((done) => setTimeout(done, 700));
  }
  if (following === model) { following = null; await loadLocal(); }
}

async function startDownload(el) {
  const model = el.dataset.m;
  try {
    show(await api("local-models/pull", { model }));
    following = model;
    await follow(model);
  } catch (error) { toast(error.message); }
}

async function stopDownload() {
  if (!following) return;
  try {
    const { stopped } = await api("local-models/stop", { model: following });
    if (stopped) toast("Stopped. The part already downloaded is kept for next time.");
  } catch (error) { toast(error.message); }
}

/* Most steps in one task: the engine's own limit (GET /api/knobs values.limits.maxSteps), saved with
   POST /api/knobs { card: "limits", values: { maxSteps } }, which keeps the card's other values. */
let knobs = null;
async function loadKnobs() {
  try { knobs = await api("knobs"); } catch (error) { knobs = null; toast(error.message); }
  renderNow();
}
async function saveSteps(box) {
  if (!/^\d+$/.test(box.value.trim())) { renderNow(); return; }
  try { knobs = await api("knobs", { card: "limits", values: { maxSteps: Number(box.value) } }); } catch (error) { toast(error.message); }
  renderNow();
}

export function init() {
  init17();
  loadAccounts();
  loadLocal();
  loadKnobs();
  document.addEventListener("change", (e) => { if (e.target.id === "m-steps") saveSteps(e.target); });
  on("mtab", (el) => { tab = el.dataset.v; renderNow(); });
  on("download", () => openDownload());
  on("dl-go", (el) => startDownload(el));
  on("lm-stop", () => stopDownload());
  markLive(["mtab", "download", "dl-go", "lm-stop"]);
}

export function load() { loadAccounts(); loadKnobs(); return loadLocal(); }

export const live = { mtab: true, download: true, "dl-go": true, "lm-stop": true, "sw:m-steps": true };

/* The Advanced and Technical sections: drawn in place and greyed until each has its engine setting wired. */
const seg = (label, opts) => `<span class="right"><span class="seg" role="group" aria-label="${label}">${opts.map((o) => `<button type="button" aria-pressed="false" data-act="seg">${o}</button>`).join("")}</span></span>`;
const num = (label, unit) => `<span class="right num15"><input class="inp" aria-label="${label}" disabled>${unit ? `<small>${unit}</small>` : ""}</span>`;
const steps = () => {
  const value = knobs?.values?.limits?.maxSteps;
  /* A plain box, as the prototype's num15; nothing is shown until the engine has said what it keeps. */
  return value == null ? ""
    : `<span class="right num15"><input class="inp" id="m-steps" value="${esc(value)}" aria-label="Most steps in one task"><small>steps</small></span>`;
};
const row = (b, right, small = "") => `<div class="ctl"><b>${b}</b>${right}<small>${small}</small></div>`;
const sw = (id, b, small) => `<div class="ctl"><b>${b}</b><input class="sw" type="checkbox" id="${id}" aria-label="${b}" data-sw="set"><small>${small}</small></div>`;

/* The model choices are "Same model" and the engine's own model presets (GET /api/state models). */
const presetNames = () => (E.state?.models?.presets ?? []).map((p) => esc(p.name));
const advanced = () => `<div class="sec x15-sec"><h2>Budgets</h2>${row("Most steps in one task", steps(), "It stops and asks when it gets there.")}${row("Spend cap per task", num("Spend cap per task", "USD"), "Only for accounts that bill per use.")}${row("Sub-tasks at once", seg("Sub-tasks at once", ["1", "3", "5"]), "Parts of a big task that can run side by side.")}</div>`
  + `<div class="sec x15-sec"><h2>Models for smaller jobs</h2>${row("Sub-tasks and side jobs", seg("Sub-tasks and side jobs", ["Same model", ...presetNames()]), "Titles, summaries and searches inside a task.")}${sw("f15-pick-the-model-per-task", "Pick the model per task", "Easy tasks go to a quick model, hard ones to the best you have.")}${row("Planning model", seg("Planning model", ["Same model", ...presetNames()]), "Writes the plan in Plan first.")}${sw("f15-mix-models-on-hard-questions", "Mix models on hard questions", "Asks two and merges the best of each. Off until you choose: it doubles the cost.")}</div>`
  + `<div class="sec x15-sec"><h2>Compare models</h2>${row("Model arena", '<span class="right"><button class="btn sm" type="button" data-act="soon">Open the arena</button></span>', "The same task to two models, you pick the better. Ratings build up over time.")}${row("Test suites", '<span class="right"><button class="btn sm" type="button" data-act="compareb17">See history</button></span>', "Your own tasks with a check for each, with history.")}</div>`;

const TECHNICAL = `<div class="sec x15-sec"><h2>Retries and timeouts</h2>${row("Retries when a service fails", num("Retries when a service fails", ""))}${row("Wait for the first word", num("Wait for the first word", "s"), "Then it tries the next account.")}${row("Model rounds per step", num("Model rounds per step", ""))}${row("Tool and command timeout", num("Tool and command timeout", "s"))}${row("Largest tool answer kept whole", num("Largest tool answer kept whole", "KB"), "Bigger answers are saved to a file and summarised.")}</div>`
  + `<div class="sec x15-sec"><h2>Per connection</h2>${row("Thinking effort", seg("Thinking effort", ["Low", "Medium", "High"]), "For the connection in use; others keep their own.")}${row("Service tier", seg("Service tier", ["Standard", "Priority", "Flex"]), "Priority costs more; flex is cheaper and slower.")}${sw("f15-slow-down-near-a-rate-limit", "Slow down near a rate limit", "Spreads requests out instead of hitting the wall.")}${sw("f15-keep-claude-s-cache-warm", "Keep Claude’s cache warm", "A tiny request every 4 minutes during long tasks, so repeats cost less.")}${row("OpenRouter picks", seg("OpenRouter picks", ["Cheapest", "Fastest", "Only ones I list"]), "Which provider serves an OpenRouter model.")}${sw("f15-fewer-rounds", "Fewer rounds", "Groups tool calls that don’t depend on each other.")}</div>`;
