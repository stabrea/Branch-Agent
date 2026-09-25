/* Settings › Achievements, from GET /api/delight/achievements: how many are earned of how many, each tier's share, and
   every achievement as the engine shows it (the higher the tier, the less a locked one gives away). The category tabs are
   the engine's own kinds; picking one only filters the list. With achievements switched off the engine says so and no
   list is drawn. */
import { esc, renderNow } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { toast } from "../../core/ui.js";

const TIERS = [["Bronze", "#A86A3D"], ["Silver", "#8C959E"], ["Gold", "#C9982E"], ["Diamond", "#4F8FB8"], ["Godly", "#8A5AA8"], ["SSS+", "#C2412D"]];
const COLOUR = Object.fromEntries(TIERS);
const MEDAL = `<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="14" r="5.5"></circle><path d="M8.5 9.5L6 3h4l2 4 2-4h4l-2.5 6.5"></path></svg>`;
const LOCK = `<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2"></rect><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"></path></svg>`;

let view = null;
let category = "All";

async function loadAchievements() {
  try { view = await api("delight/achievements"); } catch (error) { toast(error.message); }
  renderNow();
}

export function init() {
  on("achcat", (el) => { category = el.dataset.v; renderNow(); });
  loadAchievements();
}
export async function load() { await loadAchievements(); }

function tierChips(list) {
  return TIERS.map(([tier, colour]) => {
    const all = list.filter((a) => a.tier === tier);
    return all.length ? `<span class="tierc"><i data-css="background:${colour}"></i>${tier} · ${all.filter((a) => a.got).length}/${all.length}</span>` : "";
  }).join("");
}

function card(a) {
  return `<div class="ach ${a.got ? "" : "locked"}" title="${esc(a.tier)}"><span class="medal" data-css="background:${COLOUR[a.tier] ?? "var(--ink-3)"}">${a.got ? MEDAL : LOCK}</span><b>${esc(a.name)}</b><small>${esc(a.desc)}</small></div>`;
}

export function draw() {
  let html = "<h1>Achievements</h1>";
  if (!view?.on) return html + (view ? `<p class="lede">Private to you, never nagging.</p>` : "");
  const list = view.list ?? [];
  const kinds = ["All", ...new Set(list.map((a) => a.kind))];
  if (!kinds.includes(category)) category = "All";
  const shown = category === "All" ? list : list.filter((a) => a.kind === category);
  html += `<p class="lede">Private to you, never nagging. ${esc(view.earned)} of ${esc(view.total)} unlocked.</p>`;
  html += `<div class="ach-sum">${tierChips(list)}</div>`;
  html += `<div class="tabs" role="tablist" data-css="margin-top:6px">${kinds.map((k) => `<button class="tab" role="tab" type="button" aria-selected="${category === k}" data-act="achcat" data-v="${esc(k)}">${esc(k)}</button>`).join("")}</div>`;
  html += `<div class="achs">${shown.map(card).join("")}</div>`;
  html += `<div class="sec"><h2>Settings</h2><div class="ctl"><b>Keep achievements quiet</b><input class="sw" type="checkbox" id="ach-q" ${view.quiet ? "checked" : ""} aria-label="Keep achievements quiet" data-sw="achquiet"><small>No pop-ups. They still unlock. Bronze and Silver pop small for 7 seconds; Gold and up get the big one with confetti.</small></div><p class="hint">Hints: Bronze and Silver get a pet hint at most once an hour; Gold and up get none.</p></div>`;
  return html;
}

export const live = { achcat: true };
