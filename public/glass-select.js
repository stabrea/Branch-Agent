/* Redesign phase 1: every list of choices opens as a sheet of glass, and every owner-facing control
   explains what changing it means on hover or keyboard focus, in the same glass (the approved sample's
   "one dropdown, hover help everywhere"). Both only dress what is there:
   - The native <select> stays in the page and stays the source of truth. It keeps its label, its value,
     its change event and its place for a screen reader; only the list it opens is Branch's own, a
     listbox with arrows, Enter, Escape and type-ahead that closes when the select is pressed again.
     A phone with only a touch screen keeps its own picker.
   - A tooltip reuses a control's accessible description after a short hover pause or immediately on keyboard
     focus, never on touch. Icon-only buttons use their label; a title moves into the tooltip so two never show. */
import { trackPopover } from "/popover.js";

const touchOnly = matchMedia("(hover: none) and (pointer: coarse)");
const panel = document.createElement("div");
panel.className = "glass-list";
panel.id = "glass-list";
panel.setAttribute("role", "listbox");
panel.hidden = true;
document.body.append(panel);
let openFor = null;
let entry = null;
/* Integration review: a list whose choices change while it is open closes, so a press never picks by a stale position.
   mac7/ci-flakes-2: the window's refresh every 3 s writes some selects' choices again, the same ones; that is not a
   change, and closing on it shut an open list under the person's pointer. Only different choices close it. */
let shownChoices = "";
const choicesOf = (select) => [select.disabled, ...[...select.options].map((option) =>
  [option.value, option.label, option.disabled, option.parentElement?.label ?? "", option.parentElement?.disabled ?? ""].join("\u0000"))].join("\n");
const changed = new MutationObserver(() => { if (openFor && choicesOf(openFor) !== shownChoices) close(); });
let typed = "", typedAt = 0;

/* ---------- the list ---------- */

function optionNode(option, index, select) {
  const node = document.createElement("div");
  node.className = "glass-option";
  node.id = `glass-option-${index}`;
  node.setAttribute("role", "option");
  node.tabIndex = -1;
  node.dataset.index = String(index);
  node.textContent = option.textContent.trim() || option.value;
  node.setAttribute("aria-selected", String(select.selectedIndex === index));
  if (option.disabled) node.setAttribute("aria-disabled", "true");
  return node;
}
function fill(select) {
  panel.replaceChildren();
  let group = null;
  [...select.options].forEach((option, index) => {
    const parent = option.parentElement?.tagName === "OPTGROUP" ? option.parentElement : null;
    if (parent && group?.dataset.label !== parent.label) {
      group = document.createElement("div");
      group.className = "glass-group";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", parent.label);
      group.dataset.label = parent.label;
      const heading = document.createElement("div");
      heading.className = "glass-group-label";
      heading.textContent = parent.label;
      heading.setAttribute("aria-hidden", "true");
      group.append(heading);
      panel.append(group);
    }
    if (!parent) group = null;
    (group ?? panel).append(optionNode(option, index, select));
  });
  const label = select.labels?.[0]?.textContent?.trim() || select.getAttribute("aria-label") || "";
  panel.setAttribute("aria-label", label);
}
/** Under the select, or over it when there is more room above; never wider than the window. */
function place(select) {
  const box = select.getBoundingClientRect();
  const width = Math.min(Math.max(box.width, 200), innerWidth - 16);
  panel.style.width = `${width}px`;
  panel.style.left = `${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px`;
  const below = innerHeight - box.bottom - 12, above = box.top - 12;
  const room = Math.max(120, Math.min(360, below >= 200 || below >= above ? below : above));
  panel.style.maxHeight = `${room}px`;
  /* Integration review: flush against the select, so no half line of the help under it shows between the two. */
  if (below >= 200 || below >= above) { panel.style.top = `${box.bottom}px`; panel.style.bottom = ""; }
  else { panel.style.top = ""; panel.style.bottom = `${innerHeight - box.top}px`; }
}
const options = () => [...panel.querySelectorAll(".glass-option:not([aria-disabled='true'])")];

function close({ focus = false } = {}) {
  if (!openFor) return;
  const select = openFor;
  openFor = null;
  changed.disconnect();
  panel.hidden = true;
  select.setAttribute("aria-expanded", "false");
  entry?.close();
  entry = null;
  if (focus) select.focus();
}
/**
 * phase2/settings integration: a select inside something still moving into place (the Settings window rises
 * for a fifth of a second) keeps its list with it, frame by frame, until nothing around it moves; so the list
 * never stays where the select was. At most a second and a half of frames.
 */
function placeWhenSettled(select, frames = 90) {
  requestAnimationFrame(() => {
    if (openFor !== select || frames <= 0) return;
    place(select);
    const moving = document.getAnimations().some((animation) => animation.playState === "running" && animation.effect?.target?.contains?.(select));
    if (moving) placeWhenSettled(select, frames - 1);
  });
}
function open(select) {
  fill(select);
  place(select);
  placeWhenSettled(select);
  panel.hidden = false;
  openFor = select;
  select.setAttribute("aria-expanded", "true");
  select.setAttribute("aria-controls", panel.id);
  entry = trackPopover(select, panel, () => { if (openFor === select) close(); });
  shownChoices = choicesOf(select);
  changed.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "label"] });
  (panel.querySelector(".glass-option[aria-selected='true']:not([aria-disabled='true'])") ?? options()[0])?.focus();
}
/** Picks through the select itself, so its own input and change events are what everything hears. */
function pick(node) {
  const select = openFor;
  if (!select || !node || node.getAttribute("aria-disabled") === "true") return;
  const index = Number(node.dataset.index);
  close({ focus: true });
  if (select.selectedIndex === index) return;
  select.selectedIndex = index;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
function typeAhead(key) {
  const now = Date.now();
  typed = now - typedAt > 700 ? key : typed + key;
  typedAt = now;
  const list = options(), at = list.indexOf(document.activeElement);
  const order = [...list.slice(at + 1), ...list.slice(0, at + 1)];
  order.find((node) => node.textContent.toLowerCase().startsWith(typed.toLowerCase()))?.focus();
}
panel.addEventListener("keydown", (event) => {
  const list = options(), at = list.indexOf(document.activeElement);
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1, PageDown: at + 8, PageUp: at - 8 }[event.key];
  if (to !== undefined) { event.preventDefault(); list[Math.max(0, Math.min(list.length - 1, to))]?.focus(); return; }
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick(document.activeElement.closest(".glass-option")); return; }
  if (event.key === "Tab") { close({ focus: true }); return; }
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); typeAhead(event.key); }
});
panel.addEventListener("click", (event) => pick(event.target.closest(".glass-option")));
/* Integration review: pressing a greyed choice leaves the keyboard where it was, so the arrows carry on from there. */
panel.addEventListener("mousedown", (event) => event.preventDefault());
panel.addEventListener("mousemove", (event) => {
  const node = event.target.closest(".glass-option:not([aria-disabled='true'])");
  if (node && document.activeElement !== node) node.focus({ preventScroll: true });
});
addEventListener("resize", () => close());
document.addEventListener("scroll", (event) => { if (openFor && !panel.contains(event.target)) close(); }, true);

/* ---------- the select ---------- */

const glassy = (target) => target instanceof HTMLSelectElement && target.classList.contains("glass")
  && !target.multiple && target.size <= 1 && !target.disabled && !touchOnly.matches;
/* The select's own list never opens: the press opens (or closes) the glass one instead. */
document.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || !glassy(event.target)) return;
  event.preventDefault();
  const select = event.target;
  if (openFor === select) { close({ focus: true }); return; }
  close();
  select.focus();
  open(select);
});
document.addEventListener("keydown", (event) => {
  if (!glassy(event.target) || openFor === event.target) return;
  const opens = event.key === "Enter" || event.key === " " || event.key === "F4" || (event.altKey && /^Arrow(Down|Up)$/.test(event.key));
  if (!opens) return;
  event.preventDefault();
  open(event.target);
});

/** Dresses every single-choice select in the page as it is now. Safe to call again. */
export function dressSelects(root = document) {
  for (const select of root.querySelectorAll("select:not([multiple]):not(.glass)")) {
    if (select.size > 1 || select.dataset.native === "keep") continue;
    select.classList.add("glass");
    select.setAttribute("aria-haspopup", "listbox");
    select.setAttribute("aria-expanded", "false");
  }
}

/* ---------- hover help ---------- */

const tip = document.createElement("div");
tip.className = "glass-tip";
tip.id = "glass-tip";
tip.setAttribute("role", "tooltip");
tip.hidden = true;
document.body.append(tip);
let tipFor = null, tipTimer = null;
let keyboardMode = false;

/** Only a button with no words of its own, which says what it does in aria-label or title. */
function iconOnly(node) {
  const button = node?.closest?.("button, [role=button], a[href]");
  if (!button || button.closest("#glass-list, #glass-tip")) return null;
  if (button.textContent.trim()) return null;
  return button.getAttribute("aria-label") || button.title || button.dataset.tip ? button : null;
}
function describedWords(control) {
  const ids = (control.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
  const words = ids.map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" ");
  return words || control.getAttribute("aria-description") || "";
}
function describedControl(node) {
  const control = node?.closest?.(".segmented-control, button, [role=button], a[href], input, select, textarea");
  if (!control || control.closest("#glass-list, #glass-tip") || control.matches(":disabled, [aria-disabled='true']")) return null;
  return describedWords(control) ? control : null;
}
function helpTarget(node) {
  return iconOnly(node) ?? describedControl(node);
}
function tipWords(control) {
  const icon = iconOnly(control);
  if (!icon) return describedWords(control);
  if (icon.title) { icon.dataset.tip = icon.title; icon.removeAttribute("title"); }
  return icon.dataset.tip || icon.getAttribute("aria-label") || "";
}
function showTip(control) {
  const words = tipWords(control);
  if (!words || !control.isConnected) return;
  tip.textContent = words;
  tip.hidden = false;
  const box = control.getBoundingClientRect(), width = tip.offsetWidth, height = tip.offsetHeight;
  let top = box.bottom + 8;
  if (top + height > innerHeight - 6) top = box.top - height - 8;
  tip.style.left = `${Math.max(6, Math.min(innerWidth - width - 6, box.left + box.width / 2 - width / 2))}px`;
  tip.style.top = `${Math.max(6, top)}px`;
  /* A described control already names the source sentence; only icon help needs this tooltip linked. */
  if (!iconOnly(control)) return;
  const before = control.getAttribute("aria-describedby");
  control.dataset.tipBefore = before ?? "";
  control.setAttribute("aria-describedby", before ? `${before} ${tip.id}` : tip.id);
}
function hideTip() {
  clearTimeout(tipTimer);
  if (tipFor && tipFor.dataset.tipBefore !== undefined) {
    if (tipFor.dataset.tipBefore) tipFor.setAttribute("aria-describedby", tipFor.dataset.tipBefore);
    else tipFor.removeAttribute("aria-describedby");
    delete tipFor.dataset.tipBefore;
  }
  tipFor = null;
  tip.hidden = true;
}
function soon(control) {
  hideTip();
  if (!control || touchOnly.matches) return;
  tipWords(control);
  tipFor = control;
  tipTimer = setTimeout(() => showTip(control), 400);
}
function now(control) {
  hideTip();
  if (!control || touchOnly.matches) return;
  tipWords(control);
  tipFor = control;
  showTip(control);
}
document.addEventListener("pointerover", (event) => {
  if (event.pointerType !== "mouse") return;
  const control = helpTarget(event.target);
  if (control !== tipFor) soon(control);
});
function focusHelp(target) {
  const control = helpTarget(target);
  if (control && (keyboardMode || control.matches(":focus-visible"))) { now(control); return true; }
  return false;
}
document.addEventListener("focusin", (event) => {
  const target = event.target;
  if (focusHelp(target)) return;
  requestAnimationFrame(() => { if (document.activeElement === target) focusHelp(target); });
}, true);
document.addEventListener("pointerdown", () => { keyboardMode = false; hideTip(); }, true);
document.addEventListener("focusout", hideTip);
document.addEventListener("keydown", (event) => { keyboardMode = true; if (event.key === "Escape") hideTip(); });
document.addEventListener("keyup", (event) => {
  if (event.key === "Tab") now(helpTarget(document.activeElement));
}, true);
addEventListener("scroll", hideTip, true);

dressSelects();
/* Lists drawn later by the page's own modules are dressed as they arrive. */
new MutationObserver((changes) => {
  if (changes.some((change) => [...change.addedNodes].some((node) => node.nodeType === 1 && (node.tagName === "SELECT" || node.querySelector?.("select")))))
    dressSelects();
}).observe(document.body, { childList: true, subtree: true });
globalThis.branchGlass = { dressSelects, close: () => close() };
