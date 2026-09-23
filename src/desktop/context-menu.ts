import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from "electron";

/**
 * Owner-reported 2026-09-23: "no copy and paste". A desktop app built on Electron has no right-click menu of its
 * own, so right-clicking text or the message box did nothing. This gives what every desktop app gives, where it
 * applies: Cut, Copy, Paste and Select all in a field; Copy on selected text. A right-click the page handles
 * itself (the strip, hiding a part of the window) never reaches here.
 */
export function editMenuFor(params: Pick<ContextMenuParams, "isEditable" | "selectionText" | "editFlags">): MenuItemConstructorOptions[] {
  const { isEditable, selectionText, editFlags } = params;
  if (isEditable) return [
    { role: "cut", enabled: editFlags.canCut },
    { role: "copy", enabled: editFlags.canCopy },
    { role: "paste", enabled: editFlags.canPaste },
    { type: "separator" },
    { role: "selectAll", enabled: editFlags.canSelectAll },
  ];
  if (selectionText.trim()) return [{ role: "copy" }];
  return [];
}

export function registerEditMenu(window: BrowserWindow, build: (template: MenuItemConstructorOptions[]) => { popup(options: { window: BrowserWindow }): void }): void {
  window.webContents.on("context-menu", (_event, params) => {
    const template = editMenuFor(params);
    if (template.length) build(template).popup({ window });
  });
}
