/* Library: memory, documents, generated files. */

import { esc } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { ic } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { tabBar } from "./parts.js";

const tabs = [["memory", `Memory ${E.state?.memory?.length || 0}`], ["documents", "Documents"], ["made", "Made for you"]];
const tab = S.tabs.library || "memory";

export function draw() {
  if (!E.state) return `<div class="scroll"><div class="place"></div></div>`;

  let html = `<div class="scroll"><div class="place">
    <h1>Library</h1><p class="lede">What your Trunks remember, the documents they read, and everything they made.</p>
    ${tabBar(tabs, "library", tab)}<div class="rows">`;

  if (tab === "memory") {
    const mem = E.state.memory || [];
    html += `<div class="status" data-css="margin:6px 0 10px"><span class="sdot"></span><div>
      <b>${mem.length} things remembered</b>
      <p>Trunks suggest what to remember and you decide. Nothing here leaves this computer.</p></div></div>`;
    if (mem.length) {
      html += mem.map((m, i) => `<div class="prow"><span class="ico-tile">${ic('star', 's')}</span>
        <span class="grow"><b>${esc(m.title || m)}</b><small>${esc(m.source || 'Trunk')}</small></span>
        <button class="btn ghost sm" data-act="forget" data-i="${i}">Forget</button></div>`).join('');
    } else {
      html += `<p>No memories yet.</p>`;
    }
  } else if (tab === "documents") {
    html += `<div class="acts" data-css="margin:6px 0"><button class="btn" data-act="toast" data-msg="Opens a blank document.">
      ${ic('file', 's')}Write a new document</button></div><p>No documents yet.</p>`;
  } else if (tab === "made") {
    html += `<p>Nothing made yet.</p>`;
  }

  html += `</div></div></div>`;
  return html;
}

export function init() {
  markLive(["ptab", "forget", "toast"]);
}
