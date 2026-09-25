/* The status bar's usage popover, 1:1 with the prototype's "What each connection has left": one row per connection from
   GET /api/usage/glance, a bar only where the service gave a limit, and the engine's own sentence when it gave none.
   Accounts are shown side by side, never added together. */

import { esc } from "../core/dom.js";
import { openPop } from "../core/ui.js";
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

export function initUsage() {
  markLive(["usagepop"]);
  on("usagepop", async (el) => openPop(el, popHTML(await api("usage/glance").catch(() => null)), { right: true }));
}
