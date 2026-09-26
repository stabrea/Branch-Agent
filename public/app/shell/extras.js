/* The smaller pieces around the window, 1:1 with the prototype's: the gateway popover in the status bar (GET/POST
   /api/never-break), the keyboard shortcuts list, and the conversation menu, whose export writes the engine's own copy
   of the conversation (GET /api/sessions/<id>/export) to a file. The shortcuts the engine keeps (its "keys" card,
   shell/keys.js) are set by pressing the keys (#179); the fixed ones are only the keys this window answers to. */

import { esc, renderNow } from "../core/dom.js";
import { openPop, closePop, openDlg, mi, toast, ic } from "../core/ui.js";
import { S } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { chatMenuTop } from "../chat/beside.js";
import { trunkMenu, trunkMenuEnd } from "../flows/trunk.js";
import { binding, defaultOf, pressed, comboOf, kbd, spoken, saveKey } from "./keys.js";
import { initMachines } from "./machines.js";
import { initFileView } from "./fileview.js";
import { t } from "../../i18n.js";
import { say } from "../core/words.js";

const MODES = [["off", "Off"], ["when-needed", "When needed"], ["on", "On"]];
const SAID = { off: "Off. When you close Branch, your Trunks stop, and Telegram and automations go quiet until you open it again.", "when-needed": "Starts by itself when a chat app, your phone or an automation needs Branch, and rests otherwise.", on: "On. Telegram, your phone and automations keep working when the window is closed." };
let gw = null;

function gatewayPop() {
  const mode = gw?.mode ?? "off";
  const line = gw?.problem ? String(gw.problem) : say(SAID[mode]) ?? "";
  const note = gw?.note ? `<p class="pp">${esc(gw.note)}</p>` : "";
  return `<div class="pt">${t("window.settings.gateway.gateway")}</div><p class="pp">${esc(line)}</p>${note}<div class="row-in"><span>${t("field.never-break-mode")}</span><span class="seg">${MODES.map(([v, l]) => `<button type="button" data-act="gwpop-mode" data-v="${v}" aria-pressed="${mode === v}">${say(l)}</button>`).join("")}</span></div><hr>${mi("setgo", "sliders", t("window.shell.extras.gateway-settings"), "", 'data-v="gateway"')}`;
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

/* ---------- keyboard shortcuts ---------- */
/* The engine's changeable shortcuts this window answers to, by the engine's names, with the prototype's words. */
const KEYS = [["palette", "Find anything"], ["newConversation", "New conversation"], ["appearance", "Settings"], ["sideList", "Show or hide the list"], ["sidePane", "Show or hide the side panel"], ["quickAsk", "Quick ask, from any app"]];
const FIXED = [["Focus mode", "Ctrl+."], ["New line in a message", "Shift+Enter"], ["This list", "?"], ["Close anything", "Esc"]];
let listening = null;
const nameOf = (action) => KEYS.find(([a]) => a === action)?.[1] ?? "";

function keyRow([action, words]) {
  const now = binding(action), was = defaultOf(action);
  const set = `<button type="button" class="k-set15 ${listening === action ? "listen15" : ""}" data-act="key15" data-v="${action}" aria-label="${esc(t("window.shell.extras.action-keys-change", { action: say(words), keys: spoken(now) }))}">${listening === action ? `<em>${t("window.shell.extras.press-the-keys")}</em>` : kbd(now, esc)}</button>`;
  const back = now !== was ? `<button type="button" class="icon-btn" aria-label="${t("activityLog.action.putBack")} ${esc(spoken(was))}" data-act="keyreset15" data-v="${action}">${ic("x", "s")}</button>` : "<span></span>";
  return `<div class="k-row15"><span>${esc(say(words))}</span>${set}${back}</div>`;
}
function showShortcuts() {
  closePop();
  openDlg({ title: t("comfort.keys.title"), body: `<p class="hint" data-css="margin:0 0 10px">${t("window.shell.extras.click-a-shortcut-then-press-the")}</p><div class="keys15">${KEYS.map(keyRow).join("")}</div><div class="shortcuts" data-css="margin-top:14px">${FIXED.map(([a, b]) => `<span>${esc(say(a))}</span><span>${kbd(b, esc)}</span>`).join("")}</div>` });
  document.querySelector(".listen15")?.focus();
}
/* The next keys pressed while a shortcut listens become its keys, kept by the engine. Ctrl or Alt is needed so typing
   never sets one off; keys another shortcut here already has are refused, as the prototype does. */
async function takeKeys(e) {
  if (!listening || !document.querySelector(".scrim .keys15")) return;
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const action = listening, combo = comboOf(e);
  listening = null;
  if (e.key === "Escape") { showShortcuts(); return; }
  if (!/^(Ctrl|Control|Alt)\+/.test(combo)) { showShortcuts(); toast(t("window.shell.extras.use-ctrl-or-alt-with-it")); return; }
  const clash = KEYS.find(([a]) => a !== action && spoken(binding(a)).toLowerCase() === spoken(combo).toLowerCase());
  if (clash) { showShortcuts(); toast(t("window.shell.extras.combo-already-does-value", { combo: spoken(combo), value: clash[1] })); return; }
  try {
    await saveKey(action, combo);
    showShortcuts();
    toast(`${nameOf(action)}: ${spoken(binding(action))}.`);
  } catch (error) { showShortcuts(); toast(error.message); }
}
async function putBack(action) {
  try { await saveKey(action, defaultOf(action)); } catch (error) { toast(error.message); }
  showShortcuts();
}

/* A Trunk's or a room's own conversation gets its items from flows/trunk.js; pinning any other conversation stays greyed. */
function chatMenu() {
  return chatMenuTop() + (trunkMenu() || mi("pin-conv", "pin", t("window.shell.extras.pin-to-top"))) + mi("call", "wave", t("window.shell.extras.talk-out-loud")) + mi("inspect", "eye", t("window.shell.extras.look-inside-the-last-reply")) + mi("export-conv", "copy", t("window.shell.extras.export-conversation")) + trunkMenuEnd();
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
  markLive(["gwpop", "gwpop-mode", "shortcuts", "chatmenu", "export-conv", "key15", "keyreset15"]);
  initMachines();
  initFileView();
  on("gwpop", (el) => openGateway(el));
  on("gwpop-mode", (el) => setGateway(el.dataset.v));
  on("shortcuts", () => showShortcuts());
  on("key15", (el) => { listening = el.dataset.v; showShortcuts(); });
  on("keyreset15", (el) => putBack(el.dataset.v));
  on("chatmenu", (el) => (S.chat ? openPop(el, chatMenu(), { right: true }) : null));
  on("export-conv", () => exportConversation());
  document.addEventListener("keydown", takeKeys, true);
  document.addEventListener("keydown", (e) => {
    if (pressed(e, "appearance")) { e.preventDefault(); S.view = "settings"; closePop(); renderNow(); }
    else if (e.key === "?" && !typing(e) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); showShortcuts(); }
  });
}
