/* The smaller pieces around the window, 1:1 with the prototype's: the gateway popover in the status bar (GET/POST
   /api/never-break), the keyboard shortcuts list (only the keys this window answers to), and the conversation menu, whose
   export writes the engine's own copy of the conversation (GET /api/sessions/<id>/export) to a file. */

import { esc, renderNow } from "../core/dom.js";
import { openPop, closePop, openDlg, mi, toast } from "../core/ui.js";
import { S } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

const MODES = [["off", "Off"], ["when-needed", "When needed"], ["on", "On"]];
const SAID = { off: "Off. When you close Branch, your Trunks stop, and Telegram and automations go quiet until you open it again.", "when-needed": "Starts by itself when a chat app, your phone or an automation needs Branch, and rests otherwise.", on: "On. Telegram, your phone and automations keep working when the window is closed." };
let gw = null;

function gatewayPop() {
  const mode = gw?.mode ?? "off";
  const line = gw?.problem ? String(gw.problem) : SAID[mode] ?? "";
  const note = gw?.note ? `<p class="pp">${esc(gw.note)}</p>` : "";
  return `<div class="pt">Gateway</div><p class="pp">${esc(line)}</p>${note}<div class="row-in"><span>Keep Branch running</span><span class="seg">${MODES.map(([v, l]) => `<button type="button" data-act="gwpop-mode" data-v="${v}" aria-pressed="${mode === v}">${l}</button>`).join("")}</span></div><hr>${mi("setgo", "sliders", "Gateway settings…", "", 'data-v="gateway"')}`;
}

async function openGateway(el) {
  gw = await api("never-break").catch(() => gw);
  openPop(el, gatewayPop(), { right: true });
}

async function setGateway(v) {
  try { gw = await api("never-break", { mode: v }); } catch (error) { toast(error.message); }
  const anchor = document.querySelector('[data-act="gwpop"]');
  if (anchor) openPop(anchor, gatewayPop(), { right: true, force: true });
}

const KEYS = [["Find anything", "Ctrl K"], ["New conversation", "Ctrl N"], ["Settings", "Ctrl ,"], ["Show or hide the list", "Ctrl B"], ["New line in a message", "Shift Enter"], ["This list", "?"], ["Close anything", "Esc"]];
function showShortcuts() {
  closePop();
  openDlg({ title: "Keyboard shortcuts", body: `<div class="shortcuts">${KEYS.map(([a, b]) => `<span>${a}</span><span>${b.split(" ").map((x) => `<kbd>${x}</kbd>`).join(" ")}</span>`).join("")}</div>` });
}

function chatMenu() {
  return mi("pin", "pin", "Pin to top") + mi("call", "wave", "Talk out loud") + mi("inspect", "eye", "Look inside the last reply") + mi("export-conv", "copy", "Export conversation");
}

async function exportConversation() {
  closePop();
  if (!S.chat) return;
  try {
    const data = await api(`sessions/${encodeURIComponent(S.chat)}/export`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `conversation-${S.chat.slice(0, 8)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { toast(error.message); }
}

const typing = (e) => e.target.closest?.("input, textarea, select, [contenteditable]");

export function initExtras() {
  markLive(["gwpop", "gwpop-mode", "shortcuts", "chatmenu", "export-conv"]);
  on("gwpop", (el) => openGateway(el));
  on("gwpop-mode", (el) => setGateway(el.dataset.v));
  on("shortcuts", () => showShortcuts());
  on("chatmenu", (el) => (S.chat ? openPop(el, chatMenu(), { right: true }) : null));
  on("export-conv", () => exportConversation());
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === ",") { e.preventDefault(); S.view = "settings"; closePop(); renderNow(); }
    else if (e.key === "?" && !typing(e) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); showShortcuts(); }
  });
}

