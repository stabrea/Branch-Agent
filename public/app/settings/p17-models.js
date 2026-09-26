/* Settings › Models, pass 17 (prototype patch17b), from the engine:
   Compare models (Test suites › See history): the suites are GET /api/evaluation/suites; the table is the newest run
   of the chosen suite for each model choice, from GET /api/evaluation/history?suite=<id>; Run again is
   POST /api/evaluation/compare { suite, presets } over the connections set up, mixtures left out (GET
   /api/model-savings connections; it needs two, runs read-only and spends on each).
   The engine keeps no answer per task, so "side by side" stays greyed.
   What it saved: the current conversation's rounds (GET /api/model-savings/rounds?session=<id>), shown as the share of
   what was sent that the service's cache served. The engine keeps no before-and-after figures, so none are drawn.
   Mixing models needs a mixture chosen first (GET /api/model-savings), which the design has no way to pick: greyed.
   The model arena stays greyed: starting a round spends on two models, its switch ships off and the design has no
   question to ask them. */
import { esc, render } from "../core/dom.js";
import { S } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast, openDlg, dialog } from "../core/ui.js";
import { seg15 } from "./rows15.js";
import { demos17, demo17, row17, sec17 } from "./rows17.js";
import { t } from "../../i18n.js";

const C = { suites: [], suite: null, runs: [], savings: null, rounds: null };

export function sections17(lv, tab) {
  if (lv < 1) return "";
  let html = sec17(t("window.settings.p17-models.mixtures-and-savings"),
    row17(t("window.settings.p17-models.see-what-it-saved"), t("window.settings.p17-models.round-by-round-figures-for-fewer"), t("window.settings.p17-models.see-the-savings"), "savingsb17")
    + demos17(["localroute", "jev"]));
  if (tab === "second") html += sec17(t("window.settings.p17-models.second-opinion-more"), demo17("debate"));
  if (lv >= 2 && tab === "connections") html += sec17(t("window.settings.p17-models.connections-technical"), demos17(["provplug", "retired"]));
  if (lv >= 2 && tab === "media") html += sec17(t("window.settings.p17-models.media-technical"), demo17("mediapaths"));
  return html;
}

/* ---------- compare models ---------- */
/* The connections set up, without mixtures (GET /api/model-savings leaves those out). */
const presets = () => C.savings?.connections ?? [];
const nameOf = (id) => presets().find((p) => p.id === id)?.name ?? id;
const time = (ms) => { const s = Math.round((ms ?? 0) / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")} s`; };
function newestPerModel() {
  const seen = new Set();
  return C.runs.filter((run) => !seen.has(run.preset) && seen.add(run.preset));
}
function cmpDlg() {
  const rows = newestPerModel();
  const seg = `<div class="seg" role="group" aria-label="${t("window.settings.p17-models.test-suite")}">${C.suites.map((s) => `<button type="button" data-act="cmpsuiteb17" data-v="${esc(s.id)}" aria-pressed="${C.suite === s.id}">${esc(s.name)} · ${esc(s.tasks?.length ?? 0)}</button>`).join("")}</div>`;
  const table = `<table class="tbl-b17"><thead><tr><th>${t("coding.ci.model")}</th><th>${t("window.settings.p17-models.right")}</th><th>${t("window.settings.p17-models.cost")}</th><th>${t("comfort.status.item.time")}</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(nameOf(r.preset))}</td><td>${t("delight.ach.progress", { now: esc(r.summary.passed), goal: esc(r.summary.total) })}</td><td>${r.summary.dollars == null ? "" : `$${esc(r.summary.dollars.toFixed(2))}`}</td><td>${esc(time(r.summary.latencyMs?.mean))}</td></tr>`).join("")}</tbody></table>`;
  const last = C.runs[0] ? `<p class="hint" data-css="margin:0">${t("window.settings.p17-models.last-run-value-each-task-checked", { value: esc(new Date(C.runs[0].startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })) })}</p>` : "";
  openDlg({ title: t("window.settings.p17-models.compare-models"), wide: true, body: seg + table + last,
    foot: `<button class="btn ghost" type="button" data-act="cmpsideb17">${t("window.settings.p17-models.side-by-side")}</button><button class="btn pri" type="button" data-act="cmprunb17" ${presets().length >= 2 && C.suite ? "" : "disabled"}>${t("window.places.library17.run-again")}</button>` });
}
async function readRuns() {
  C.runs = C.suite ? (await api(`evaluation/history?suite=${encodeURIComponent(C.suite)}`)).runs ?? [] : [];
}
async function openCompare() {
  try {
    C.savings = await api("model-savings");
    C.suites = (await api("evaluation/suites")).suites ?? [];
    if (!C.suites.some((s) => s.id === C.suite)) C.suite = C.suites[0]?.id ?? null;
    await readRuns();
  } catch (error) { toast(error.message); return; }
  cmpDlg();
}
async function pickSuite(el) {
  C.suite = el.dataset.v;
  try { await readRuns(); } catch (error) { toast(error.message); }
  cmpDlg();
}
async function runCompare(el) {
  el.disabled = true;
  try {
    await api("evaluation/compare", { suite: C.suite, presets: presets().slice(0, 4).map((p) => p.id) });
    await readRuns();
  } catch (error) { toast(error.message); }
  if (dialog()) cmpDlg();
}

/* ---------- what it saved ---------- */
function cachedShare() {
  const rounds = C.rounds?.rounds ?? [];
  const sent = rounds.reduce((n, r) => n + (r.input ?? 0), 0);
  const cached = rounds.reduce((n, r) => n + (r.cached ?? 0), 0);
  return sent > 0 && rounds.some((r) => r.cached != null) ? Math.round((cached / sent) * 100) : null;
}
function savingsDlg() {
  const share = cachedShare();
  const tiles = share == null ? "" : `<div class="scope15 s3-b17"><div><small>${t("savings.chart.cached")}</small><b>${esc(share)}%</b></div></div>`;
  const mixing = (C.savings?.liveMixtures?.length ?? 0) > 0 ? "on" : C.savings ? "off" : null;
  openDlg({ title: t("window.settings.p17-models.what-it-saved"), wide: true, body: tiles + seg15(t("window.settings.p17-models.mix-models-on-hard-questions"), t("window.settings.p17-models.asks-two-models-and-merges-the"), [["off", t("accounts.switch.off")], ["on", t("accounts.switch.on")]], mixing, "mixb17"),
    foot: `<button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}
async function openSavings() {
  try {
    const [savings, rounds] = await Promise.all([api("model-savings"), S.chat ? api(`model-savings/rounds?session=${encodeURIComponent(S.chat)}`) : null]);
    Object.assign(C, { savings, rounds });
  } catch (error) { toast(error.message); return; }
  savingsDlg();
}

let started = false;
export function init17() {
  if (started) return;
  started = true;
  on("compareb17", () => openCompare());
  on("cmpsuiteb17", (el) => pickSuite(el));
  on("cmprunb17", (el) => runCompare(el));
  on("savingsb17", () => openSavings());
  markLive(["compareb17", "cmpsuiteb17", "cmprunb17", "savingsb17"]);
  render();
}
