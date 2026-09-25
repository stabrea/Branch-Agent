/* The walkthrough (design doc 6.2), 1:1 with the prototype's: a spotlight on one part of the window, a card beside it
   with the guide's pose, "n of N", dots, Back, Skip and Next. A stop whose part is not on screen is passed over, so the
   tour only ever shows what this window has. */

import { $, esc, renderNow } from "../core/dom.js";
import { app, closePop, closeDlg } from "../core/ui.js";
import { S } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

const chat = () => { S.view = "chat"; };
const TOUR = [
  { sel: ".list", prep: chat, title: "Your Trunks are contacts", text: "Each Trunk is an assistant with one job. Message it like a teammate. A moving ring means it’s working; a dot means it needs you." },
  { sel: ".ask", prep: chat, title: "It asks before it acts", text: "Anything that sends, deletes, spends or installs waits for your yes: Send it, Always allow, or Don’t. The Inbox collects them all." },
  { sel: '[data-act="modelmenu2"]', prep: chat, title: "Model and thinking", text: "GPT-6 Sol, Opus 5.5 or the model on this computer, and how long it thinks. The choices change with the model." },
  { sel: '[data-act="modemenu2"]', prep: chat, title: "How much it may do", text: "Auto, Ask first, Plan first or Full access, per conversation. Shift+Tab switches; Lockdown stops everything." },
  { sel: '[data-act="plusmenu"]', prep: chat, title: "Everything else is in +", text: "Attach files, @mention a Trunk, use a skill, go Temporary, have it ask questions first, or choose who answers." },
  { sel: "#pane", title: "The side panel", text: "Activity, Plan, Files and Memory beside the conversation. Drag its edge to any width; double-click to reset. The browser and computer open full size instead." },
  { sel: '[data-act="gwpop"]', title: "The gateway", text: "Keeps your Trunks running when Branch is closed, and starts Branch again if it ever stops." },
  { sel: ".side-nav", title: "Five places", text: "Overview at a glance, Inbox for what needs you, Automations for work on its own, Library for what it remembers and made, Customize for Trunks, skills and chat apps." },
  { sel: "#side-q", title: "Find anything", text: "Ctrl K opens every conversation, place, setting and command." },
  { sel: '[aria-label="Settings"][data-act="view"]', title: "Settings, your way", text: "Regular, Advanced or Technical: just the essentials, or every file, port and raw key." },
  { sel: ".lm-grid12", prep: () => { S.view = "settings"; S.setPage = "local"; }, title: "Models on this computer", text: "Branch looks at your memory and graphics card and only offers what fits. One click installs it; it runs free and private." },
  { sel: ".ch-wrap12", prep: () => { S.view = "customize"; S.tabs.customize = "channels"; }, title: "Every chat app", text: "55 of them, each with its real recipe: make the bot, paste what it gives you, Branch checks it, you approve a six-digit code, save." },
  { sel: ".titlebar [data-act=\"side-toggle\"]", prep: chat, title: "Your layout", text: "Ctrl B hides the list. Drag any edge: narrow the list to icons, widen the side panel, or give the computer more room. Double-click an edge to reset." },
  { sel: null, prep: chat, title: "That’s Branch", text: "Explore freely." },
];

const T = { on: false, i: 0, dir: 1 };

export function startTour() {
  closePop();
  closeDlg();
  Object.assign(T, { on: true, i: 0, dir: 1 });
  go(0);
}

function end() {
  T.on = false;
  $(".tour-layer")?.remove();
  renderNow();
}

function go(i) {
  if (i >= TOUR.length) return end();
  T.i = Math.max(0, i);
  closePop();
  try { TOUR[T.i].prep?.(); } catch { /* a stop that cannot be prepared is passed over below */ }
  renderNow();
  requestAnimationFrame(() => requestAnimationFrame(place));
}

function layer() {
  let el = $(".tour-layer");
  if (!el) {
    el = document.createElement("div");
    el.className = "tour-layer";
    el.innerHTML = '<div class="tour-spot"></div><div class="tour-card" role="dialog" aria-live="polite" aria-label="Tour"></div>';
    app().appendChild(el);
  }
  return el;
}

function cardHtml(st) {
  const last = T.i === TOUR.length - 1;
  const pose = last ? "yay" : T.i === 0 ? "wave" : "point";
  return `<img class="pose11 tour-pt11" src="/art/branch-${pose}.webp" alt="" loading="lazy" decoding="async" draggable="false"><span class="n">${T.i + 1} of ${TOUR.length}</span><b>${esc(st.title)}</b><p>${esc(st.text)}</p><div class="tour-dots" aria-hidden="true">${TOUR.map((_, j) => `<i class="${j === T.i ? "on" : ""}"></i>`).join("")}</div><div class="acts">${T.i > 0 ? '<button class="btn ghost sm" type="button" data-act="tour-back">Back</button>' : ""}<span class="tb-grow"></span><button class="btn ghost sm" type="button" data-act="tour-end">${last ? "Close" : "Skip the tour"}</button>${last ? "" : '<button class="btn pri sm" type="button" data-act="tour-next">Next</button>'}</div>`;
}

function place() {
  if (!T.on) return;
  const st = TOUR[T.i], a = app().getBoundingClientRect();
  let el = st.sel ? document.querySelector(st.sel) : null;
  let r = el?.getBoundingClientRect();
  if (st.sel && (!el || !el.getClientRects().length || r.width < 2)) {
    const next = T.i + T.dir;
    if (next >= 0 && next < TOUR.length) return go(next);
    el = null;
  }
  const root = layer(), spot = root.querySelector(".tour-spot"), card = root.querySelector(".tour-card");
  card.innerHTML = cardHtml(st);
  const cw = card.offsetWidth, ch = card.offsetHeight;
  if (!el) {
    spot.className = "tour-spot none";
    Object.assign(card.style, { left: (a.width - cw) / 2 + "px", top: Math.max(60, (a.height - ch) / 2) + "px" });
    card.querySelector(".btn.pri,.btn")?.focus({ preventScroll: true });
    return;
  }
  spot.className = "tour-spot";
  const pad = 6, x = Math.max(4, r.left - a.left - pad), y = Math.max(4, r.top - a.top - pad);
  const w = Math.min(a.width - x - 4, r.width + pad * 2), h = Math.min(a.height - y - 4, r.height + pad * 2);
  Object.assign(spot.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
  let top = y + h + 12;
  if (top + ch > a.height - 8) top = y - ch - 12;
  if (top < 8) top = Math.max(8, Math.min(a.height - ch - 8, y + 12));
  let left = Math.min(Math.max(x, 12), a.width - cw - 12);
  if (top < y + h && top + ch > y && w < a.width - cw - 40) left = x + w + 12 + cw < a.width ? x + w + 12 : Math.max(12, x - cw - 12);
  Object.assign(card.style, { left: left + "px", top: top + "px" });
  card.querySelector('[data-act="tour-next"]')?.focus({ preventScroll: true });
}

export function init() {
  markLive(["tour", "tour-next", "tour-back", "tour-end"]);
  on("tour", () => startTour());
  on("tour-next", () => { T.dir = 1; go(T.i + 1); });
  on("tour-back", () => { T.dir = -1; go(T.i - 1); });
  on("tour-end", () => end());
  document.addEventListener("keydown", (e) => {
    if (!T.on) return;
    if (e.key === "Escape") end();
    else if (e.key === "ArrowRight") { T.dir = 1; go(T.i + 1); }
    else if (e.key === "ArrowLeft" && T.i > 0) { T.dir = -1; go(T.i - 1); }
  });
  window.addEventListener("resize", () => { if (T.on) place(); });
}
