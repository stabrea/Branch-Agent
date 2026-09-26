/* The composer's Tools button, 1:1 with the prototype's hub: the connectors (GET /api/mcp/connections) and skills
   (state.skills) this conversation can use, a search, and Manage tools, which opens Customize › Tools. Switching one off
   for a single conversation stays greyed until the engine keeps that choice. */

import { $, esc, applyCss, renderNow } from "../core/dom.js";
import { ic, openPop, closePop } from "../core/ui.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { t } from "../../i18n.js";

const T = { q: "", servers: [] };

function list() {
  const q = T.q.toLowerCase();
  const kinds = [["mcp", t("window.chat.tools.connectors"), T.servers.map((s) => ({ id: s.id ?? s.name, name: s.name ?? s.id, desc: s.description ?? "" }))],
    ["skills", t("folder-trust.kind.skills"), (E.state?.skills ?? []).map((s) => ({ id: s.id ?? s.name, name: s.name ?? s.id, desc: s.description ?? "" }))]];
  const sec = ([k, label, items]) => {
    const shown = items.filter((x) => !q || `${x.name} ${x.desc}`.toLowerCase().includes(q));
    return shown.length ? `<div class="th9-h">${label}<span>${t("window.chat.tools.on", { count: shown.length })}</span></div>${shown.map((x) => `<div class="th9-row"><span class="ico-tile">${ic(k === "mcp" ? "plug" : "bolt", "s")}</span><span class="grow"><b>${esc(x.name)}</b><small>${esc(x.desc)}</small></span><input type="checkbox" class="sw" data-sw="tool9" id="tool9-${esc(x.id)}" aria-label="${t("window.chat.tools.in-conversation", { name: esc(x.name) })}"></div>`).join("")}` : "";
  };
  return kinds.map(sec).join("") || (q ? `<p class="hint" data-css="margin:10px 4px">${t("window.chat.tools.none")}</p>` : "");
}

function hub() {
  const trunk = E.trunks.find((tr) => tr.id === E.sessions.find((s) => (s.sessionId ?? s.id) === S.chat)?.trunkId);
  return `<div class="th9"><div class="th9-top"><b>${t("window.chat.tools.for", { name: esc(trunk?.name ?? "Branch") })}</b><small>${t("window.chat.tools.switch-off")}</small></div>
    <label class="th9-q">${ic("search", "s")}<input id="tool9-q" placeholder="${t("window.chat.tools.search")}" value="${esc(T.q)}" autocomplete="off" aria-label="${t("window.chat.tools.search")}"></label>
    <div class="th9-list">${list()}</div>
    <div class="th9-add">${[["mcp", "plug", t("window.chat.tools.server")], ["skills", "bolt", t("settings.learning-core.kind-skill")], ["clis", "term", t("window.chat.tools.cli")], ["plugins", "puzzle", t("window.chat.tools.plugin")]].map(([k, i, l]) => `<button type="button" data-act="tool-add" data-v="${k}">${ic(i, "s")}<span>${l}</span></button>`).join("")}</div>
    <button type="button" class="th9-manage" data-act="tools-manage">${t("window.chat.tools.manage")}${ic("chev", "s")}</button></div>`;
}

async function open(el) {
  T.q = "";
  T.servers = (await api("mcp/connections").catch(() => null))?.servers ?? [];
  openPop(el, hub());
  document.querySelector(".pop")?.classList.add("pop9");
}

export function initToolsHub() {
  markLive(["tools9", "tools-manage", "sw:tool9-q"]);
  on("tools9", (el) => open(el));
  on("tools-manage", () => { closePop(); S.view = "customize"; S.tabs.customize = "tools"; renderNow(); });
  document.addEventListener("input", (e) => {
    if (e.target.id !== "tool9-q") return;
    T.q = e.target.value;
    const box = $(".th9-list");
    if (box) { box.innerHTML = list(); applyCss(box); greyOut(box); }
  });
}
