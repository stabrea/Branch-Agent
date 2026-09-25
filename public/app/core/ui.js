/* Shared pieces every area draws with: icons, avatars, menus, dialogs, toasts and tooltips. Behaviour and classes match
   the prototype (design doc 2 and 5.3). */

import { ICONS } from "./icons.js";
import { $, esc, applyCss } from "./dom.js";
import { greyOut } from "./features.js";

export const app = () => document.getElementById("app");

export const ic = (name, cls = "") => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

/* A Trunk's face: its character still if it has a look, its emoji on a pebble, else the pebble with eyes. */
export function av(trunk, size = 40) {
  if (!trunk) return "";
  const wanted = String(trunk.color || trunk.colour || "");
  const colour = /^#[0-9a-f]{3,8}$/i.test(wanted) ? wanted : "#2F6F5E";
  const css = `--s:${size}px;--c:${colour}`;
  if (trunk.kind === "main" || trunk.isBranch) return `<span class="av brand" data-css="--s:${size}px;--r:30%" aria-hidden="true"><span class="peb"></span><span class="mark mark-face"></span></span>`;
  if (trunk.lookStill) return `<span class="av look12" data-css="${css}" aria-hidden="true"><img src="${esc(trunk.lookStill)}" alt="" draggable="false"></span>`;
  if (trunk.emoji) return `<span class="av emoji15" data-css="${css}" aria-hidden="true"><span class="peb"></span><i data-css="font-size:${Math.round(size * 0.56)}px">${esc(trunk.emoji)}</i></span>`;
  return `<span class="av" data-css="${css}" aria-hidden="true"><span class="peb"></span><span class="eye l"></span><span class="eye r"></span></span>`;
}

export const mi = (act, icon, text, extra = "", attrs = "") =>
  `<button class="mi" type="button" role="menuitem" data-act="${act}" ${attrs}>${icon ? `<span class="ico">${ic(icon, "s")}</span>` : ""}<span class="mi-t">${text}</span>${extra ? `<span class="r">${extra}</span>` : ""}</button>`;
export const radio = (act, value, text, sub, on) =>
  `<button class="mi" type="button" role="menuitemradio" aria-checked="${on}" data-act="${act}" data-v="${esc(value)}"><span class="tick">${ic("check", "s")}</span><span><span class="mi-t">${text}</span>${sub ? `<span class="mi-s">${sub}</span>` : ""}</span></button>`;

/* ---------- popovers ---------- */
let popEl = null;
let popAnchor = null;
export function closePop() {
  popEl?.remove();
  popAnchor?.setAttribute("aria-expanded", "false");
  popEl = popAnchor = null;
}
export function openPop(anchor, html, opt = {}) {
  const same = popAnchor === anchor;
  closePop();
  if (same && !opt.force) return;
  const root = app();
  popEl = document.createElement("div");
  popEl.className = "pop";
  popEl.setAttribute("role", "menu");
  popEl.innerHTML = html;
  applyCss(popEl);
  greyOut(popEl);
  root.appendChild(popEl);
  popAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  place(popEl, root.getBoundingClientRect(), anchor.getBoundingClientRect(), opt.right);
  popEl.querySelector("button:not([aria-disabled='true']),input")?.focus({ preventScroll: true });
}
function place(el, a, r, right) {
  if (a.width <= 480) Object.assign(el.style, { left: "8px", right: "8px", maxWidth: "none" });
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  if (a.width > 480) el.style.left = Math.min(Math.max((right ? r.right - a.left - w : r.left - a.left), 8), a.width - w - 8) + "px";
  const below = r.bottom - a.top + 6;
  const above = r.top - a.top - h - 6;
  el.style.top = (below + h > a.height - 8 && above > 8 ? above : Math.max(8, Math.min(below, a.height - h - 8))) + "px";
}

/* ---------- dialogs ---------- */
let dlgEl = null;
export const dialog = () => dlgEl;
export function closeDlg() { dlgEl?.remove(); dlgEl = null; }
export function openDlg({ title, body, foot = "", wide = false }) {
  closePop();
  closeDlg();
  dlgEl = document.createElement("div");
  dlgEl.className = "scrim";
  dlgEl.innerHTML = `<div class="dlg ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="dlg-h"><h2>${esc(title)}</h2><button class="icon-btn" type="button" aria-label="Close" data-act="dlg-close">${ic("x")}</button></div><div class="dlg-b">${body}</div>${foot ? `<div class="dlg-f">${foot}</div>` : ""}</div>`;
  applyCss(dlgEl);
  greyOut(dlgEl);
  app().appendChild(dlgEl);
  const first = [".dlg-b input:not([type=checkbox])", ".dlg-b textarea", ".dlg-f .btn.pri:not(:disabled)", ".dlg-f .btn"].map((q) => dlgEl.querySelector(q)).find(Boolean);
  first?.focus({ preventScroll: true });
  return dlgEl;
}

/* ---------- toasts ---------- */
let toastTimer;
export function toast(message) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(message)}</span>`;
  app().appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2600);
}

/* ---------- tooltips (data-tip, or an icon button's label) ---------- */
const TIP_SEL = "[data-tip],.icon-btn[aria-label],.c-btn[aria-label],.tb-btn[aria-label],.win button[aria-label]";
let tipEl = null;
let tipTimer;
function showTip(el) {
  clearTimeout(tipTimer);
  tipEl?.remove();
  tipEl = null;
  const text = el && (el.dataset.tip || el.getAttribute("aria-label"));
  if (!text) return;
  tipTimer = setTimeout(() => {
    if (!document.body.contains(el)) return;
    const root = app();
    tipEl = document.createElement("div");
    tipEl.className = "tipx";
    tipEl.textContent = text;
    root.appendChild(tipEl);
    const a = root.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    tipEl.style.left = Math.min(Math.max(r.left - a.left + r.width / 2 - tipEl.offsetWidth / 2, 6), a.width - tipEl.offsetWidth - 6) + "px";
    tipEl.style.top = (r.top - a.top - tipEl.offsetHeight - 6 < 4 ? r.bottom - a.top + 6 : r.top - a.top - tipEl.offsetHeight - 6) + "px";
  }, 450);
}
export function listenTips() {
  let current = null;
  document.addEventListener("pointerover", (e) => { const el = e.target.closest(TIP_SEL); if (el !== current) { current = el; showTip(el); } });
  document.addEventListener("focusin", (e) => { const el = e.target.closest(TIP_SEL); if (el) showTip(el); });
  document.addEventListener("pointerdown", () => { clearTimeout(tipTimer); tipEl?.remove(); tipEl = null; }, true);
}

export { $ };
