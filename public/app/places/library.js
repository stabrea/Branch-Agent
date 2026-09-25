/* Library: memory, documents, generated files. */

import { esc, renderNow } from "../core/dom.js";
import { S, E, refresh } from "../core/state.js";
import { ic, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";

function tabBar(tabs, place, current) {
  return `<div class="tabs" role="tablist">${tabs.map(([id, label, count]) =>
    `<button class="tab" role="tab" type="button" aria-selected="${id === current ? 'true' : 'false'}" data-act="ptab" data-place="${place}" data-v="${id}">${esc(label)}${count > 0 ? `<span class="n">${count}</span>` : ''}</button>`
  ).join('')}</div>`;
}

let docsKey = "";
let docsList = [];
let artsKey = "";
let artsList = [];

export function draw() {
  const tab = S.tabs.library || "memory";
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;

  const mem = E.state.memory || [];
  const tabs = [
    ["memory", "Memory", mem.length],
    ["documents", "Documents", docsList.length],
    ["made", "Made for you", artsList.length]
  ];

  const lockBanner = E.state.lock ? `<div class="lock-banner">${ic('lock', 's')}Lockdown is on. Trunks can read, but nothing leaves this computer and nothing is changed.<button type="button" data-act="lock">Turn it off</button></div>` : "";

  let html = `<main class="main enter11" id="main">${lockBanner}<div class="scroll"><div class="place">
    <h1>Library</h1><p class="lede">What your Trunks remember, the documents they read, and everything they made.</p>
    ${tabBar(tabs, "library", tab)}<div class="rows">`;

  if (tab === "memory") {
    html += `<div class="status" data-css="margin:6px 0 10px"><span class="sdot"></span><div>
      <b>${mem.length} things remembered</b>
      <p>Trunks suggest what to remember and you decide. Nothing here leaves this computer.</p></div></div>`;
    if (mem.length) {
      html += mem.map((m, i) => `<div class="prow"><span class="ico-tile">${ic('star', 's')}</span>
        <span class="grow"><b>${esc(m.title || m)}</b><small>${esc(m.source || 'Trunk')}</small></span>
        <button class="btn ghost sm" type="button" data-act="forget" data-i="${i}" data-id="${esc(m.id || '')}">Forget</button></div>`).join('');
    }
  } else if (tab === "documents") {
    html += `<div class="acts" data-css="margin:6px 0"><button class="btn" type="button" data-act="toast" data-msg="Opens a blank document.">
      ${ic('file', 's')}Write a new document</button></div>`;
    if (docsList.length) {
      html += docsList.map((d) => `<div class="prow"><span class="fi">${esc((d.name || '').split('.').pop() || 'txt')}</span>
        <span class="grow"><b>${esc(d.name)}</b><small>${esc(d.source || '')}</small></span>
        <button class="btn sm" type="button" data-act="toast" data-msg="Opens in its own app.">Open</button></div>`).join('');
    }
  } else if (tab === "made") {
    if (artsList.length) {
      html += artsList.map((a) => `<div class="prow"><span class="fi">${esc((a.name || '').split('.').pop() || 'bin')}</span>
        <span class="grow"><b>${esc(a.name)}</b><small>${esc(a.source || '')}</small></span>
        <button class="btn sm" type="button" data-act="toast" data-msg="Opens in its own app.">Open</button></div>`).join('');
    }
  }

  html += `</div></div></div></main>`;
  return html;
}

export async function after() {
  const tab = S.tabs.library || "memory";
  if (tab === "documents") {
    try {
      const fresh = await api("documents").catch(() => []);
      const key = JSON.stringify(fresh);
      if (key !== docsKey) { docsKey = key; docsList = Array.isArray(fresh) ? fresh : []; renderNow(); }
    } catch (e) { /* silently fail */ }
  } else if (tab === "made") {
    try {
      const fresh = await api("artifacts").catch(() => []);
      const key = JSON.stringify(fresh);
      if (key !== artsKey) { artsKey = key; artsList = Array.isArray(fresh) ? fresh : []; renderNow(); }
    } catch (e) { /* silently fail */ }
  }
}

export function init() {
  markLive(["ptab", "forget"]);
  /* One memory, by its id, through the engine's own memory.delete (POST /api/action); nothing else is forgotten. */
  on("forget", async (el) => {
    const id = el.dataset.id;
    if (!id) return;
    try { await api("action", { tool: "memory.delete", args: { id } }); } catch (error) { toast(error.message); return; }
    await refresh().catch(() => {});
    renderNow();
  });}
