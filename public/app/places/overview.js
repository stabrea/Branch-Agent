/* Overview: status dashboard and controls. */

import { esc } from "../core/dom.js";
import { S, E, activeId, ownerHere } from "../core/state.js";
import { face, nameOf } from "../core/faces.js"; // your-profile
import { ic, av } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { api } from "../core/api.js";
import { renderNow } from "../core/dom.js";
import { recBar } from "../chat/rec.js";
import { allPaused } from "../flows/pause.js";
import { look17, figure17 } from "../core/art17.js";
import { agentState } from "../chat/agent17.js";
import { t, language } from "../../i18n.js";
import { say } from "../core/words.js";

let lastHealthCheck = 0;
let cachedHealth = null;
let conversationMode = null;
let achievements = null;
let achievementsIn = "";
let approvals = 0;

function formatSpend(amount) {
  return "$" + (amount ?? 0).toFixed(2);
}

/* Pass 17: a running task in a Trunk's own conversation shows the character it wears, at work (chat/agent17.js). */
function liveFace(run) {
  const trunk = E.trunks.find((t) => t.chatSessionId === run.sessionId), look = look17(trunk?.character);
  if (!look) return av({}, 34);
  const st = agentState(trunk) === "idle" ? "work" : agentState(trunk);
  return `<span class="live-fig12">${figure17(look, st)}</span>`;
}

function nowTile() {
  const running = E.state.runs?.filter(r => r.status === "running" || r.status === "needs_input") || [];
  const waiting = (E.state.trunkWaiting?.length || 0) + (E.state.attention ?? []).filter((w) => !w.parentRunId).length + approvals;
  let html = `<div class="tile"><h2>${t("dashboard.area.now")}</h2>`;
  if (!running.length) html += `<p>${t("ov.now.none")}</p>`;
  else running.slice(0, 3).forEach(r => html += `<div class="row" data-act="chat" data-id="${esc(r.sessionId || "")}"><span class="avw">${liveFace(r)}</span><div class="inf"><b>${esc(r.prompt?.split("\n")[0]?.slice(0, 40) ?? "")}</b></div></div>`);
  html += `<div class="acts">${waiting ? `<button class="btn pri sm" type="button" data-act="view" data-v="inbox">${t("window.places.overview.answer-waiting-waiting", { waiting })}</button>` : `<span class="pill done"><i></i>${t("ov.calm")}</span>`}</div></div>`;
  return html;
}

function healthTile() {
  if (!cachedHealth || !cachedHealth.items) return "";
  let html = `<div class="tile"><h2>${t("dashboard.area.health")}</h2>`;
  cachedHealth.items.forEach(item => {
    const dotClass = item.ok ? "" : "bad";
    html += `<div data-css="display:flex;align-items:center;gap:8px;font-size:13px"><span class="dot ${dotClass}"></span><span>${esc(say(item.name || ""))}</span><span data-css="color:var(--ink-3);margin-left:auto;text-align:right">${esc(item.summary || "")}</span></div>`;
  });
  html += `</div>`;
  return html;
}

function spendTile() {
  const runs = E.state.runs || [];
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const week = runs.filter(r => new Date(r.createdAt).getTime() > weekAgo);
  const byTrunk = {};
  let total = 0;
  const priced = week.filter((r) => typeof r.cost?.amount === "number");
  priced.forEach(r => {
    const cost = r.cost.amount;
    total += cost;
    const firstLine = r.prompt?.split("\n")[0]?.slice(0, 30) ?? "";
    byTrunk[firstLine] = (byTrunk[firstLine] || 0) + cost;
  });
  const sorted = Object.entries(byTrunk).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const maxCost = Math.max(...sorted.map(e => e[1]), 0.01);
  let html = `<div class="tile"><h2>${t("window.places.overview.spend-this-week")}</h2><div class="big-n">${priced.length ? formatSpend(total) : esc(say(week.find((r) => r.cost?.display)?.cost.display ?? ""))}</div><div class="bars" data-css="margin:0">`;
  sorted.forEach(([trunk, cost]) => {
    const pct = (cost / maxCost) * 100;
    html += `<div class="brow"><span>${esc(trunk)}</span><span class="track"><u data-css="width:${pct}%"></u></span><span class="v">${formatSpend(cost)}</span></div>`;
  });
  html += `</div></div>`;
  return html;
}

function recentTile() {
  const recent = E.state.runs?.slice(0, 4) || [];
  let html = `<div class="tile"><h2>${t("window.places.overview.recent-activity")}</h2>`;
  recent.forEach(r => {
    const duration = r.updatedAt && r.createdAt ? Math.round((new Date(r.updatedAt).getTime() - new Date(r.createdAt).getTime()) / 1000) : 0;
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const durationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    html += `<div data-css="display:flex;align-items:center;gap:8px;font-size:13px">${av({}, 20)}<span data-css="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.prompt?.split("\n")[0]?.slice(0, 50) ?? "")}</span><span data-css="font:12px var(--mono);color:var(--ink-3)">${durationStr}</span></div>`;
  });
  html += `<div class="acts"><button class="btn sm" type="button" data-act="ptab" data-place="inbox" data-v="history">${t("window.places.overview.all-history")}</button></div></div>`;
  return html;
}

function controlsTile() {
  const mode = conversationMode?.following?.label ?? "";
  return `<div class="tile"><h2>${t("dashboard.area.controls")}</h2><p>${t("window.places.overview.mode")} <b data-css="font-weight:600">${esc(mode)}</b> · <button class="link" type="button" data-act="setgo" data-v="permissions">${t("window.places.overview.change")}</button></p><div class="acts"><button class="btn bad sm" type="button" data-act="lock">${t("lockdown.label")}</button><button class="btn sm" type="button" data-act="pauseall">${allPaused() ? t("window.places.overview.resume-all-trunks") : t("window.places.overview.pause-all-trunks")}</button></div></div>`;
}

/* Everyone on this computer (GET /api/profiles: the owner, then each profile), as the prototype's tile lists them; the
   person here now is marked so. Switching person stays in the person menu, greyed. */
function usersTile() {
  const everyone = [null, ...(E.profiles?.profiles ?? []).map((p) => p.id)]; // your-profile: each person's own face and name
  const rows = everyone.map((id) => `<div data-css="display:flex;align-items:center;gap:10px;font-size:13px">${face(id, { css: "width:26px;height:26px;font-size:11px" })}<span data-css="flex:1">${esc(nameOf(id))}</span>${activeId() === id ? `<span data-css="color:var(--ink-3)">${t("window.places.overview.here-now")}</span>` : ""}</div>`).join("");
  return `<div class="tile"><h2>${t("strip.who")}</h2>${rows}${ownerHere() ? `<div class="acts"><button class="btn sm" type="button" data-act="invite">${t("household.invite")}</button></div>` : ""}</div>`;
}

function milestonesTile() {
  /* GET /api/delight/achievements: the ones earned first, then the next ones it names, four in all. */
  const list = (achievements?.list ?? []).filter((a) => a.name && a.name !== "???");
  const shown = [...list.filter((a) => a.got), ...list.filter((a) => !a.got)].slice(0, 4);
  if (!shown.length) return "";
  const count = shown.filter((a) => a.got).length;
  let html = `<div class="tile"><h2>${t("window.places.overview.milestones")}</h2><div class="badges">`;
  shown.forEach((a) => {
    const tip = a.got ?? (typeof a.now === "number" ? t("delight.ach.progress", { now: a.now, goal: a.goal }) : "");
    html += `<span class="badge ${a.got ? "" : "locked"}" title="${esc(tip)}"><span class="bi">${ic(a.got ? "star" : "lock", "s")}</span>${esc(a.name)}</span>`;
  });
  html += `</div><p>${t("window.places.overview.count-of-count2-just-for-fun", { count, count2: shown.length })}</p></div>`;
  return html;
}

export function draw() {
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;

  let html = `<main class="main enter11" id="main"><div class="lock-banner"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z"></path></svg>${t("window.places.automations.lockdown-is-on-trunks-can-read")}<button type="button" data-act="lock">${t("lockdown.turnOff")}</button></div><div class="scroll"><div class="place" data-css="max-width:1000px">
    ${recBar()}
    <h1>${t("strip.menu.overview")}</h1><p class="lede">${t("window.places.overview.whats-happening-across-your-trunks-at")}</p>
    <div class="ov">`;

  html += nowTile();
  html += healthTile();
  html += spendTile();
  html += recentTile();
  html += controlsTile();
  html += usersTile();
  const milestonesHtml = milestonesTile();
  if (milestonesHtml) html += milestonesHtml;

  html += `</div></div></div></main>`;
  return html;
}

export function init() {
  markLive(["ptab", "chat"]);
}

export async function after() {
  let needsRender = false;
  const now = Date.now();

  // Health check: at most every 30 seconds
  if (now - lastHealthCheck > 30000) {
    lastHealthCheck = now;
    const health = await api("health").catch(() => null);
    if (health && JSON.stringify(health?.items) !== JSON.stringify(cachedHealth?.items)) {
      cachedHealth = health;
      needsRender = true;
    }
  }

  // Tasks waiting for a yes (GET /api/policy), so Answer N waiting counts what the Inbox asks about: not a helper's
  // question (parentRunId), which is answered in its task's Activity › Helpers
  const policy = await api("policy").catch(() => null);
  const asked = (policy?.waiting ?? []).filter((q) => !q.parentRunId).length;
  if (policy && asked !== approvals) { approvals = asked; needsRender = true; }

  // Fetch conversation mode if not yet cached
  if (!conversationMode) {
    conversationMode = await api("conversation-mode").catch(() => null);
    if (conversationMode) needsRender = true;
  }

  // Fetch achievements if not yet cached, or cached in another language (their names are the engine's words)
  if (!achievements || achievementsIn !== language()) {
    achievementsIn = language();
    achievements = await api(`delight/achievements?lang=${achievementsIn}`).catch(() => null);
    if (achievements) needsRender = true;
  }

  if (needsRender) renderNow();
}
