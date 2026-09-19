/* 0.18.1: one way every small menu and popover in the window opens and closes. Its own button opens
   it and closes it again; Escape and a click anywhere else close it; the button says whether it is
   open (aria-expanded); Escape gives the keyboard back to the button; and opening one closes any
   other that is open. Used by More, the "+" in the message box, the Lockdown shield, the workspace
   and project menus, the room meter and the label picker. */

const openNow = new Set();

/** Closes every open popover except `keep`. */
export function closePopovers(keep = null) {
  for (const entry of [...openNow]) if (entry !== keep) entry.close();
}

/**
 * Keeps track of a popover drawn some other way (the label picker is built on each open). `close`
 * must hide it; the entry is forgotten once closed.
 */
export function trackPopover(trigger, panel, close) {
  const entry = { trigger, panel, close: () => { openNow.delete(entry); close(); } };
  closePopovers(entry);
  openNow.add(entry);
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
