/* The status bar's version popover says what the engine plans to do about updates (POST /api/comfort/update-plan);
   installing goes through the desktop app's updater, so Install stays greyed here. Its usage popover is 1:1 with the
   prototype's "What each connection has left": one row per connection from GET /api/usage/glance, a bar only where the service gave a limit, and the engine's own sentence when it gave none.
   Accounts are shown side by side, never added together. */

import { esc } from "../core/dom.js";
import { openPop, mi } from "../core/ui.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { logo } from "../core/logos.js";

const CHIP = { measured: '<span class="pill ok">Measured</span>', estimated: '<span class="pill warn">Estimate</span>', not_published: '<span class="pill idle">Not published</span>' };
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function windowRow(w, estimated) {
  if (w.kind === "money" || !w.limit || w.remaining == null) return `<div class="lim-w"><span>${esc(w.title)}</span><span></span><span>${w.remaining == null ? "" : esc(String(w.remaining))}</span></div>`;
  const pct = Math.max(0, Math.min(100, Math.round((w.remaining / w.limit) * 100)));
  return `<div class="lim-w"><span>${esc(w.title)}</span><span class="lim-bar ${estimated ? "est" : ""}"><i data-css="width:${pct}%;${pct < 15 ? "background:var(--warn)" : ""}"></i></span><span>${pct}% left${w.resetAt ? " · resets " + esc(clock(w.resetAt)) : ""}</span></div>`;
}

function limitRow(r) {
  const body = r.windows?.length
    ? r.windows.map((w) => windowRow(w, w.state === "estimated")).join("") + `<small>${esc(r.note)}</small>`
    : `<small>${esc(r.note)}</small>`;
  return `<div class="lim">${logo(r.connection, r.connectionName, 28)}<div><div class="lim-h"><b>${esc(r.connectionName)}</b><span class="muted">${esc(r.accountLabel ?? "")}</span>${CHIP[r.state] ?? ""}${r.inUse ? '<span class="pill ok">used next</span>' : ""}</div>${body}</div></div>`;
}

function popHTML(g) {
  const month = g?.month?.pricedRuns ? `<span>This month: <b>$${Number(g.month.cost).toFixed(2)}</b></span>` : "";
  return `<div class="lims"><div class="ph" data-css="padding:4px 6px 6px">What each connection has left</div>${(g?.rows ?? []).map(limitRow).join("")}
    <p data-css="font-size:12px;color:var(--ink-3);margin:8px 6px 4px">${esc(g?.summary ?? "")}</p>
    <div class="lim-foot">${month}<span class="tb-grow"></span><button class="btn sm" type="button" data-act="setgo" data-v="usage">Open Usage</button></div></div>`;
}

function updatePop(plan) {
  const version = E.state?.version ?? "";
  return `<div class="pt">Branch ${esc(version)}</div><p class="pp">${esc(plan?.reason ?? "")}</p>${mi("install", "check", "Install when nothing is running")}${mi("closepop", "clock", "Remind me tomorrow")}`;
}

function taskRow(r) {
  const icon = r.status === "running" ? "spin" : r.status === "needs_input" ? "alert" : "clock";
  const iconClass = icon === "spin" ? " spin" : "";
  const name = esc(r.prompt?.split("\n")[0]?.slice(0, 40) || "Task");
  const status = esc(r.status || "");
  return `<div class="mi" role="menuitem"><span class="ico">${icon === "spin" ? '<svg class="i s spin" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a10 10 0 0 1 10 10"/></svg>' : icon === "alert" ? '<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l10 18H2l10-18z" fill="none" stroke="currentColor" stroke-width="2"/><text x="12" y="16" text-anchor="middle" fill="currentColor">!</text></svg>' : '<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2" stroke="currentColor" stroke-width="2"/></svg>'}</span><span><span class="mi-t">${name}</span><span class="mi-s">${status}</span></span></div>`;
}

function tasksPop(activity) {
  const running = (activity?.runs ?? []).filter(r => r.status === "running" || r.status === "needs_input") || [];
  return `<div class="ph">Running in the background</div>${running.length ? running.map(taskRow).join("") : '<p class="hint" data-css="margin:8px 6px;font-size:12px">Nothing running.</p>'}<hr>${mi("bg-new", "plus", "Start something in the background", "<kbd>/bg</kbd>")}`;
}

export function initUsage() {
  markLive(["usagepop", "updmenu", "tasks10"]);
  on("updmenu", async (el) => openPop(el, updatePop(await api("comfort/update-plan", {}).catch(() => null)), { right: true }));
  on("usagepop", async (el) => openPop(el, popHTML(await api("usage/glance").catch(() => null)), { right: true }));
  on("tasks10", async (el) => openPop(el, tasksPop(await api("activity").catch(() => null)), { right: true }));
}
