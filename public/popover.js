/* 0.18.1: one way every small menu and popover in the window opens and closes. Its own button opens
   it and closes it again; Escape and a click anywhere else close it; the button says whether it is
   open (aria-expanded); Escape gives the keyboard back to the button; and opening one closes any
   other that is open. Used by More, the "+" in the message box, the Lockdown shield, the workspace
   and project menus, the room meter and the label picker. */

const openNow = new Set();

/*
 * Q34: `main` is its own stacking context (z-index 1 and a backdrop filter), so a menu drawn inside it
 * stays under anything fixed over the conversation, such as the side-panel card, whatever its own z-index.
 * While open, a menu from a part of `main` that never scrolls (its top bar, its message box) is shown in the
 * page's top layer instead, pinned where and as it was drawn in its own place. It is not moved in the page,
 * so its keys, focus and inherited styles stay as they were.
 */
const lifted = new Map();
/* What the browser's own popover style sets, kept as the menu had it in its place. */
const kept = ["color", "background-color", "border-top", "border-right", "border-bottom", "border-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left", "overflow-x", "overflow-y", "width"];
function lift(panel) {
  const main = panel.closest("body > main");
  if (!main || lifted.has(panel) || typeof panel.showPopover !== "function") return;
  for (let node = panel.parentElement; node && node !== main; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/auto|scroll/.test(`${style.overflowX} ${style.overflowY}`)) return; // it would not follow a scroll
  }
  const box = panel.getBoundingClientRect(), style = getComputedStyle(panel);
  const values = kept.map((name) => [name, style.getPropertyValue(name)]);
  lifted.set(panel, panel.style.cssText);
  panel.setAttribute("popover", "manual");
  for (const [name, value] of values) panel.style.setProperty(name, value);
  for (const [name, value] of [["position", "fixed"], ["inset", "auto"], ["margin", "0"], ["height", "auto"],
    ["left", `${box.left}px`], ["top", `${box.top}px`]]) panel.style.setProperty(name, value);
  try { panel.showPopover(); } catch { lower(panel); }
}
function lower(panel) {
  if (!lifted.has(panel)) return;
  const before = lifted.get(panel);
  lifted.delete(panel);
  if (panel.matches(":popover-open")) panel.hidePopover();
  panel.removeAttribute("popover");
  panel.style.cssText = before;
}

/** Closes every open popover except `keep`. */
export function closePopovers(keep = null) {
  for (const entry of [...openNow]) if (entry !== keep) entry.close();
}

/**
 * Keeps track of a popover drawn some other way (the label picker is built on each open). `close`
 * must hide it; the entry is forgotten once closed.
 */
export function trackPopover(trigger, panel, close) {
  const entry = { trigger, panel, close: () => { openNow.delete(entry); lower(panel); close(); } };
  closePopovers(entry);
  openNow.add(entry);
  lift(panel);
  return entry;
}

/**
 * Wires `trigger` to show and hide `panel`. Options: `onOpen(panel)` fills it before it shows,
 * `afterOpen(panel)` runs once it is on screen (to put the keyboard in it), `onClose()` after it
 * hides, and `closeOnPick` closes it when anything inside it is clicked.
 */
export function popover(trigger, panel, { onOpen, afterOpen, onClose, closeOnPick = false } = {}) {
  const entry = {
    trigger,
    panel,
    close: ({ focus = false } = {}) => {
      openNow.delete(entry);
      lower(panel);
      if (panel.hidden) return;
      panel.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      onClose?.();
      if (focus) trigger.focus();
    },
  };
  const open = () => {
    closePopovers(entry);
    onOpen?.(panel);
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    openNow.add(entry);
    afterOpen?.(panel);
    lift(panel);
  };
  trigger.setAttribute("aria-expanded", String(!panel.hidden));
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    if (panel.hidden) open();
    else entry.close();
  });
  panel.addEventListener("click", (event) => {
    event.stopPropagation();
    if (closeOnPick && event.target !== panel) entry.close();
  });
  return { open, close: entry.close, isOpen: () => !panel.hidden };
}

if (typeof document !== "undefined") {
  document.addEventListener("click", (event) => {
    for (const entry of [...openNow])
      if (!entry.panel.contains(event.target) && !entry.trigger.contains(event.target)) entry.close();
  });
  /* A menu pinned in the top layer would stay put while the window changes size around it. */
  addEventListener("resize", () => { for (const entry of [...openNow]) if (lifted.has(entry.panel)) entry.close(); });
  /* Escape closes the one opened last and puts the keyboard back on its button. */
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !openNow.size) return;
    const last = [...openNow].pop();
    last.close({ focus: true });
    last.trigger.focus();
    /* One Escape closes one thing: the window behind it (Settings, the side pane) stays. */
    event.stopImmediatePropagation();
  });
}
