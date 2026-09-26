/* Shared pieces every area draws with: icons, avatars, menus, dialogs, toasts and tooltips. Behaviour and classes match
   the prototype (design doc 2 and 5.3). */

import { ICONS } from "./icons.js";
import { $, esc, applyCss } from "./dom.js";
import { greyOut } from "./features.js";
import { look17 } from "./art17.js";
import { t } from "../../i18n.js";

export const app = () => document.getElementById("app");

export const ic = (name, cls = "") => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

/* The prototype's eight Trunk colours and five shapes (prototype.html COLOURS, SHAPES). The engine names seven shapes
   (src/trunks/look.ts); shape i is saved as SHAPE_NAMES[i]. */
export const COLOURS = ["#2F8C86", "#D8612A", "#8A5AA8", "#5E8C4A", "#4F6FA8", "#C9982E", "#B84A6B", "#56616B"];
export const SHAPES = ["50%", "58% 42% 54% 46% / 52% 56% 44% 48%", "46% 54% 42% 58% / 60% 44% 56% 40%", "62% 38% 50% 50% / 45% 55% 45% 55%", "42% 58% 58% 42% / 50% 42% 58% 50%"];
export const SHAPE_NAMES = ["circle", "pebble", "leaf", "acorn", "shield"];
export const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v ?? "")) ? String(v).toLowerCase() : null);
/* A colour or shape left empty is the one its name gives (src/trunks/look.ts), picked from the eight colours and five
   shapes with the prototype's own name hash (prototype.html logo, wave15). */
const nameHash = (name) => { let h = 0; for (const ch of String(name ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
const shapeIndex = (t) => {
  const named = SHAPE_NAMES.indexOf(t.look ? t.look.shape : t.shape);
  if (named >= 0) return named;
  return Number.isInteger(t.shape) && SHAPES[t.shape] ? t.shape : nameHash(t.name) % SHAPES.length;
};
/* What a Trunk's face is drawn from, the same everywhere: the engine keeps the colour as chosenColour and the emoji and
   shape inside look (GET /api/trunks); a face already drawn from (color, emoji, shape) passes through. */
export function faceOf(t) {
  const look = t?.look ?? {};
  const emoji = t?.look ? (look.face === "emoji" ? look.emoji || "" : "") : t?.emoji || "";
  return { name: t?.name, color: hex(t?.chosenColour) ?? hex(t?.color) ?? COLOURS[nameHash(t?.name) % COLOURS.length].toLowerCase(),
    shape: SHAPE_NAMES[shapeIndex(t ?? {})], emoji, paused: !!t?.paused, character: t?.character ?? null, lookStill: t?.lookStill };
}

/* A Trunk's face: its character still if it has a look, its emoji on a pebble, else the pebble with eyes. */
export function av(trunk, size = 40) {
  if (!trunk) return "";
  if (trunk.kind === "main" || trunk.isBranch) return `<span class="av brand" data-css="--s:${size}px;--r:30%" aria-hidden="true"><span class="peb"></span><span class="mark mark-face"></span></span>`;
  const f = faceOf(trunk);
  const css = `--s:${size}px;--c:${f.color};--r:${SHAPES[SHAPE_NAMES.indexOf(f.shape)]}`;
  const paused = f.paused ? " paused" : ""; // a paused Trunk's face is drawn grey (GET /api/trunks `paused`)
  const still = f.lookStill || look17(f.character)?.still; // pass 17: the character the engine says it wears
  if (still) return `<span class="av look12${paused}" data-css="${css}" aria-hidden="true"><img src="${esc(still)}" alt="" loading="lazy" draggable="false"></span>`;
  if (f.emoji) return `<span class="av emoji15${paused}" data-css="${css}" aria-hidden="true"><span class="peb"></span><i data-css="font-size:${Math.round(size * 0.56)}px">${esc(f.emoji)}</i></span>`;
  return `<span class="av${paused}" data-css="${css}" aria-hidden="true"><span class="peb"></span><span class="eye l"></span><span class="eye r"></span></span>`;
}

export const mi = (act, icon, text, extra = "", attrs = "") =>
  `<button class="mi" type="button" role="menuitem" data-act="${act}" ${attrs}>${icon ? `<span class="ico">${ic(icon, "s")}</span>` : ""}<span class="mi-t">${text}</span>${extra ? `<span class="r">${extra}</span>` : ""}</button>`;
export const radio = (act, value, text, sub, on) =>
  `<button class="mi" type="button" role="menuitemradio" aria-checked="${on}" data-act="${act}" data-v="${esc(value)}"><span class="tick">${ic("check", "s")}</span><span><span class="mi-t">${text}</span>${sub ? `<span class="mi-s">${sub}</span>` : ""}</span></button>`;

/* ---------- popovers ---------- */
let popEl = null;
let popAnchor = null;
/* Escape hands the keyboard back to the button that opened it ({ refocus: true }); a redraw may have replaced that
   button, so then the one drawn in its place (same data-act, data-v and data-id) is used. A click outside leaves the
   keyboard where the click put it, as the browser does. */
export function closePop(opt = {}) {
  const anchor = popAnchor, open = !!popEl;
  popEl?.remove();
  popAnchor?.setAttribute("aria-expanded", "false");
  popEl = popAnchor = null;
  if (opt.refocus && open && anchor) openerOf(anchor)?.focus({ preventScroll: true });
}
function openerOf(anchor) {
  if (anchor.isConnected) return anchor;
  const { act, v, id } = anchor.dataset;
  if (!act) return null;
  const same = (el) => el.dataset.v === v && el.dataset.id === id && el.getClientRects().length > 0;
  return [...document.querySelectorAll(`[data-act="${CSS.escape(act)}"]`)].find(same) ?? null;
}
export function openPop(anchor, html, opt = {}) {
  const same = popAnchor === anchor, fresh = !popEl || (!same && !opt.force);
  closePop();
  hideTip();
  if (same && !opt.force) return;
  const root = app();
  popEl = document.createElement("div");
  popEl.className = "pop";
  popEl.setAttribute("role", "menu");
  if (opt.label) popEl.setAttribute("aria-label", opt.label); /* a menu that is someone's says whose, to a screen reader */
  popEl.innerHTML = html;
  applyCss(popEl);
  greyOut(popEl);
  root.appendChild(popEl);
  popAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  place(popEl, root.getBoundingClientRect(), anchor.getBoundingClientRect(), opt.right);
  offComposer(popEl, root.getBoundingClientRect(), anchor);
  if (fresh) popEl.classList.add("in17"); /* pass 17: a popover that opens fresh eases in once; a redraw does not replay it */
  popEl.querySelector("button:not([aria-disabled='true']),input")?.focus({ preventScroll: true });
}
/* A click anywhere outside the open popover and its button closes it. */
document.addEventListener("pointerdown", (e) => {
  if (popEl && !popEl.contains(e.target) && !popAnchor?.contains(e.target)) closePop();
}, true);

/* A popover opened from outside the message box (the status bar's usage, tasks or version) never sits over it: when it
   would, it goes above the box, still inside the window. */
function offComposer(el, a, anchor) {
  const box = document.getElementById("composer");
  if (!box || box.contains(anchor)) return;
  const c = box.getBoundingClientRect(), p = el.getBoundingClientRect();
  if (anchor.getBoundingClientRect().top < c.bottom) return;
  if (!(p.left < c.right && p.right > c.left && p.top < c.bottom && p.bottom > c.top)) return;
  const above = c.top - a.top - p.height - 6;
  if (above >= 8) el.style.top = above + "px";
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
  const fresh = !dlgEl;
  closePop();
  closeDlg();
  dlgEl = document.createElement("div");
  dlgEl.className = fresh ? "scrim in17" : "scrim"; /* pass 17: a fresh dialog eases in once */
  dlgEl.innerHTML = `<div class="dlg ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="dlg-h"><h2>${esc(title)}</h2><button class="icon-btn" type="button" aria-label="${t("delight.ach.close")}" data-act="dlg-close">${ic("x")}</button></div><div class="dlg-b">${body}</div>${foot ? `<div class="dlg-f">${foot}</div>` : ""}</div>`;
  applyCss(dlgEl);
  greyOut(dlgEl);
  app().appendChild(dlgEl);
  const first = [".dlg-b input:not([type=checkbox])", ".dlg-b textarea", ".dlg-f .btn.pri:not(:disabled)", ".dlg-f .btn"].map((q) => dlgEl.querySelector(q)).find(Boolean);
  first?.focus({ preventScroll: true });
  return dlgEl;
}

/* ---------- toasts ---------- */
let toastTimer;
/* With `undo`, the toast carries an Undo button (data-act="undo", handled in chat/messages.js) that calls it. */
export function toast(message, undo) {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(message)}</span>${undo ? `<button type="button" data-act="undo">${t("strip.undo")}</button>` : ""}`;
  toast.undo = undo ?? null;
  app().appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), undo ? 5000 : 2600);
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
function hideTip() { clearTimeout(tipTimer); tipEl?.remove(); tipEl = null; }
export function listenTips() {
  let current = null;
  document.addEventListener("pointerover", (e) => { const el = e.target.closest(TIP_SEL); if (el !== current) { current = el; showTip(el); } });
  document.addEventListener("focusin", (e) => { const el = e.target.closest(TIP_SEL); if (el) showTip(el); });
  document.addEventListener("pointerdown", hideTip, true);
}

export { $ };
