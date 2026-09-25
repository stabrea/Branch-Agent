/* Boots the window: saved choices, the engine's state, the live event stream, and the first draw. Each area draws its own
   view into #main; the shell draws the sidebar, title-bar actions and status bar. */

import { $, onRender, render, renderNow, paint } from "./core/dom.js";
import { S, E, loadSaved, refresh } from "./core/state.js";
import { stream } from "./core/api.js";
import { listen, on } from "./core/actions.js";
import { listenTips, closePop, closeDlg } from "./core/ui.js";
import { greyOut } from "./core/features.js";
import { VIEWS } from "./views.js";
import { drawShell, initShell } from "./shell/shell.js";

function drawMain() {
  const main = $("#main");
  const draw = VIEWS[S.view] ?? VIEWS.chat;
  paint(main, draw());
  greyOut(main);
  VIEWS.after?.[S.view]?.(main);
}

on("dlg-close", () => closeDlg());
on("view", (el) => { S.view = el.dataset.v; if (el.dataset.tab) S.tabs[el.dataset.v] = el.dataset.tab; closePop(); renderNow(); });
on("ptab", (el) => { S.view = el.dataset.place; S.tabs[el.dataset.place] = el.dataset.v; closePop(); renderNow(); });

async function boot() {
  loadSaved();
  if (S.theme) document.documentElement.dataset.theme = S.theme;
  listen();
  listenTips();
  initShell();
  onRender(drawShell);
  onRender(drawMain);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closePop(); closeDlg(); } });
  try { await refresh(); } catch (error) { E.error = error; render(); return; }
  stream(["run", "approval", "message", "trunk"], () => refresh().catch(() => {}));
}

boot();
