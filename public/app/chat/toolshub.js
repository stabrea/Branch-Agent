/* The composer's Tools button, 1:1 with the prototype's hub: the connectors (GET /api/mcp/connections) and skills
   (state.skills) this conversation can use, a search, and Manage tools, which opens Customize › Tools. Switching one off
   for a single conversation stays greyed until the engine keeps that choice. */

import { $, esc, applyCss, renderNow } from "../core/dom.js";
import { ic, openPop, closePop } from "../core/ui.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";

const T = { q: "", servers: [] };

function list() {
  const q = T.q.toLowerCase();
  const kinds = [["mcp", "Connectors", T.servers.map((s) => ({ id: s.id ?? s.name, name: s.name ?? s.id, desc: s.description ?? "" }))],
    ["skills", "Skills", (E.state?.skills ?? []).map((s) => ({ id: s.id ?? s.name, name: s.name ?? s.id, desc: s.description ?? "" }))]];
  const sec = ([k, label, items]) => {
    const shown = items.filter((x) => !q || `${x.name} ${x.desc}`.toLowerCase().includes(q));
    return shown.length ? `<div class="th9-h">${label}<span>${shown.length} on</span></div>${shown.map((x) => `<div class="th9-row"><span class="ico-tile">${ic(k === "mcp" ? "plug" : "bolt", "s")}</span><span class="grow"><b>${esc(x.name)}</b><small>${esc(x.desc)}</small></span><input type="checkbox" class="sw" data-sw="tool9" id="tool9-${esc(x.id)}" aria-label="${esc(x.name)} in this conversation"></div>`).join("")}` : "";
  };
  return kinds.map(sec).join("") || (q ? '<p class="hint" data-css="margin:10px 4px">No tool by that name.</p>' : "");
}

function hub() {
  const trunk = E.trunks.find((t) => t.id === E.sessions.find((s) => (s.sessionId ?? s.id) === S.chat)?.trunkId);
  return `<div class="th9"><div class="th9-top"><b>Tools for ${esc(trunk?.name ?? "Branch")}</b><small>Switch one off for this conversation only.</small></div>
    <label class="th9-q">${ic("search", "s")}<input id="tool9-q" placeholder="Search tools" value="${esc(T.q)}" autocomplete="off" aria-label="Search tools"></label>
    <div class="th9-list">${list()}</div>
    <div class="th9-add">${[["mcp", "plug", "Server"], ["skills", "bolt", "Skill"], ["clis", "term", "CLI"], ["plugins", "puzzle", "Plugin"]].map(([k, i, l]) => `<button type="button" data-act="tool-add" data-v="${k}">${ic(i, "s")}<span>${l}</span></button>`).join("")}</div>
    <button type="button" class="th9-manage" data-act="tools-manage">Manage tools${ic("chev", "s")}</button></div>`;
}

async function open(el) {
  T.q = "";
  T.servers = (await api("mcp/connections").catch(() => null))?.servers ?? [];
  openPop(el, hub());
  document.querySelector(".pop")?.classList.add("pop9");
}

export function initToolsHub() {
  markLive(["tools9", "tools-manage"]);
  on("tools9", (el) => open(el));
  on("tools-manage", () => { closePop(); S.view = "customize"; S.tabs.customize = "tools"; renderNow(); });
  document.addEventListener("input", (e) => {
    if (e.target.id !== "tool9-q") return;
    T.q = e.target.value;
    const box = $(".th9-list");
    if (box) { box.innerHTML = list(); applyCss(box); greyOut(box); }
  });
}
