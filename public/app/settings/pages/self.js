/* Settings › Branch itself, 1:1 with the prototype. Check and fix (GET /api/deployment/doctor?fix=1) and Restart the
   engine (POST /api/dashboard/restart) are live. "Updating itself" is the engine's update setting
   (POST /api/comfort { card: "notify", values: { autoUpdate } }: install = Allowed, check = Ask me first, off = Never).
   What it may change about itself and the gateway's timings are rules in the approval policy (a deny rule for
   settings.* / gateway.propose); taking one back loosens approvals, so those show the engine's state and stay greyed.
   Every change is the settings history (GET /api/settings-kit/history); Roll back undoes one
   (POST /api/settings-kit/undo { record }), and the engine refuses one that would make Branch less careful. */
import { E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { esc, render } from "../../core/dom.js";
import { markLive } from "../../core/features.js";
import { on } from "../../core/actions.js";
import { toast, ic } from "../../core/ui.js";
import { seg15 } from "../rows15.js";

const D = { history: [], names: {}, gw: null, policy: null, comfort: null };

async function loadData() {
  const [hist, kit, gw, pol, comfort] = await Promise.all(["settings-kit/history", "settings-kit", "never-break", "policy", "comfort"]
    .map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  D.history = hist?.records ?? [];
  D.names = Object.fromEntries((kit?.settings ?? []).map((s) => [s.key, s.name]));
  Object.assign(D, { gw, policy: pol?.policy ?? null, comfort: comfort?.values ?? null });
  render();
}

async function rollBack(id) {
  try { await api("settings-kit/undo", { record: id }); toast("Rolled back to before that change."); } catch (error) { toast(error.message); }
  await loadData();
}

async function setUpdating(v) {
  try { await api("comfort", { card: "notify", values: { autoUpdate: v } }); } catch (error) { toast(error.message); }
  await loadData();
}

export function init() {
  loadData();
  on("doctor", () => {
    api("deployment/doctor?fix=1").then(() => loadData(), (e) => toast(e.message));
  });
  on("gw-restart", () => {
    api("dashboard/restart", {}).then(() => loadData(), (e) => toast(e.message));
  });
  on("self-rollback", (el) => rollBack(el.dataset.id));
  on("self-upd", (el) => setUpdating(el.dataset.v));
  markLive(["doctor", "gw-restart", "self-rollback", "self-upd"]);
}

export async function load() {
  await loadData();
}

export const live = {
  "doctor": true,
  "gw-restart": true,
  "self-rollback": true,
  "self-upd": true,
};

function statusSection() {
  const version = E.state?.version;
  let html = "<div class=\"status\"><span class=\"sdot \"></span><div>";
  html += "<b>Running</b>";
  if (version) html += "<p>Engine " + esc(version) + " · the gateway watches it and starts it again if it stops.</p>";
  html += "</div></div>";
  html += `<div class="acts" data-css="margin-top:12px"><button class="btn" type="button" data-act="doctor">${ic("check", "s")}Check and fix</button><button class="btn" type="button" data-act="gw-restart">${ic("retry", "s")}Restart the engine</button><button class="btn ghost" type="button" data-act="soon">Reload without dropping work</button></div>`;
  return html;
}

const denied = (tool) => (D.policy?.rules ?? []).some((r) => r.decision === "deny" && (r.tool === tool || r.tool === tool.split(".")[0] + ".*"));

function policySection() {
  const own = D.policy ? (denied("settings.change") ? "never" : "ask") : null;
  const timings = D.policy ? (denied("gateway.propose") ? "never" : "suggest") : null;
  const upd = D.comfort?.notify?.autoUpdate ?? null;
  // Loosening always asks: the engine takes no standing yes for it, so its one choice is the engine's own rule.
  const loosen = D.policy ? "ask" : null;
  return "<div class=\"sec\"><h2>What Branch may change about itself</h2>"
    + seg15("Its own settings", "It shows you the change first, tried on a throwaway copy.", [["ask", "Ask me first"], ["never", "Never"]], own)
    + seg15("Loosening what it may do", "Asked every time; the answer is never kept.", [["ask", "Ask every time"]], loosen)
    + seg15("The gateway’s timings", "It can suggest; you decide.", [["suggest", "Suggest"], ["never", "Never"]], timings)
    + seg15("Restarting its own engine", "When it’s stuck. Safe steps carry on after.", [["allowed", "Allowed"], ["ask", "Ask me first"]], null)
    + seg15("Updating itself", "Only when nothing is working, with a safety copy.", [["install", "Allowed"], ["check", "Ask me first"], ["off", "Never"]], upd, "self-upd")
    + "<div class=\"ctl\"><b>Its own program and your saved work</b><span class=\"right\"><span class=\"pill idle\">Never, by itself</span></span><small>This one can’t be switched on.</small></div>"
    + "<div class=\"ctl\"><b>Work on its own code in a separate copy</b><input class=\"sw\" type=\"checkbox\" id=\"self-dev\" aria-label=\"Work on its own code in a separate copy\" data-sw=\"set\"><small>A private copy of Branch’s source. The installed app is never touched. Off until you switch it on.</small></div></div>";
}

function neverDiesSection() {
  const c = D.gw?.config;
  const hold = c ? `The gateway starts it again, holding messages for up to ${esc(c.holdSeconds)} seconds` : "The gateway starts it again";
  const crash = c ? `<dt>If it keeps crashing</dt><dd>After ${esc(c.maxQuickCrashes)} quick crashes it rolls back to the last good settings and tells you</dd>` : "";
  return `<div class="sec"><h2>Never dies</h2><dl class="kv"><dt>If the engine stops</dt><dd>${hold}</dd>${crash}<dt>Interrupted work</dt><dd>Safe steps carry on by themselves; anything that sends or changes something asks first</dd></dl></div>`;
}

function timelineSection() {
  const items = D.history.slice(0, 3).map((r) => {
    const when = new Date(r.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
    const back = r.undoneBy || r.undoes ? "" : `<button class="btn ghost sm" type="button" data-act="self-rollback" data-id="${esc(r.id)}">Roll back</button>`;
    return `<li class="">${ic("info", "s")}<span>${esc(D.names[r.detail] ?? r.detail)}<small>${esc(when)}</small></span>${back}</li>`;
  }).join("");
  return `<div class="sec"><h2>Every change</h2><ol class="tl">${items}</ol></div>`;
}

export function draw() {
  let html = `<h1>Branch itself</h1><p class="lede">What Branch may change about itself, how it stays running, and every change it made, each one reversible.</p>`;
  html += statusSection();
  html += policySection();
  html += neverDiesSection();
  html += timelineSection();
  return html;
}
