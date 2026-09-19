/* Redesign phase 1: every list of choices opens as a sheet of glass, and every button that is only an
   icon says what it does on hover, in the same glass (the approved sample's "one dropdown, hover help
   everywhere"). Both only dress what is there:
   - The native <select> stays in the page and stays the source of truth. It keeps its label, its value,
     its change event and its place for a screen reader; only the list it opens is Branch's own, a
     listbox with arrows, Enter, Escape and type-ahead that closes when the select is pressed again.
     A phone with only a touch screen keeps its own picker.
   - A tooltip is shown for an icon-only button (from its aria-label or title) after a short pause, on
     mouse hover or keyboard focus, never on touch; the title moves into the tooltip so two never show. */
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
/* Integration review: a list whose choices change while it is open closes, so a press never picks by a stale position. */
const changed = new MutationObserver(() => close());
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
function open(select) {
  fill(select);
  place(select);
  panel.hidden = false;
  openFor = select;
  select.setAttribute("aria-expanded", "true");
  select.setAttribute("aria-controls", panel.id);
  entry = trackPopover(select, panel, () => { if (openFor === select) close(); });
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

/* ---------- hover help for buttons that are only an icon ---------- */

const tip = document.createElement("div");
tip.className = "glass-tip";
tip.id = "glass-tip";
tip.setAttribute("role", "tooltip");
tip.hidden = true;
document.body.append(tip);
let tipFor = null, tipTimer = null;

/** Only a button with no words of its own, which says what it does in aria-label or title. */
function iconOnly(node) {
  const button = node?.closest?.("button, [role=button], a[href]");
  if (!button || button.closest("#glass-list, #glass-tip")) return null;
  if (button.textContent.trim()) return null;
  return button.getAttribute("aria-label") || button.title || button.dataset.tip ? button : null;
}
function tipWords(button) {
  if (button.title) { button.dataset.tip = button.title; button.removeAttribute("title"); }
  return button.dataset.tip || button.getAttribute("aria-label") || "";
}
function showTip(button) {
  const words = tipWords(button);
  if (!words || !button.isConnected) return;
  tip.textContent = words;
  tip.hidden = false;
  const box = button.getBoundingClientRect(), width = tip.offsetWidth, height = tip.offsetHeight;
  let top = box.bottom + 8;
  if (top + height > innerHeight - 6) top = box.top - height - 8;
  tip.style.left = `${Math.max(6, Math.min(innerWidth - width - 6, box.left + box.width / 2 - width / 2))}px`;
  tip.style.top = `${Math.max(6, top)}px`;
  /* Joined to whatever already describes the button, and put back exactly as it was afterwards. */
  const before = button.getAttribute("aria-describedby");
  button.dataset.tipBefore = before ?? "";
  button.setAttribute("aria-describedby", before ? `${before} ${tip.id}` : tip.id);
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
function soon(button) {
  hideTip();
  if (!button) return;
  tipWords(button);
  tipFor = button;
  tipTimer = setTimeout(() => showTip(button), 400);
}
document.addEventListener("pointerover", (event) => {
  if (event.pointerType !== "mouse") return;
  const button = iconOnly(event.target);
  if (button !== tipFor) soon(button);
});
document.addEventListener("focusin", (event) => {
  const button = iconOnly(event.target);
  if (button?.matches(":focus-visible")) soon(button); else hideTip();
});
document.addEventListener("pointerdown", hideTip, true);
document.addEventListener("focusout", hideTip);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") hideTip(); });
addEventListener("scroll", hideTip, true);

dressSelects();
/* Lists drawn later by the page's own modules are dressed as they arrive. */
new MutationObserver((changes) => {
  if (changes.some((change) => [...change.addedNodes].some((node) => node.nodeType === 1 && (node.tagName === "SELECT" || node.querySelector?.("select")))))
    dressSelects();
}).observe(document.body, { childList: true, subtree: true });
globalThis.branchGlass = { dressSelects, close: () => close() };
