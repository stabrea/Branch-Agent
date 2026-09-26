/* Boots the window: saved choices, the engine's state, the live event stream, and the first draw. Each area draws its own
   view into #main; the shell draws the sidebar, title-bar actions and status bar. */

import { $, onRender, render, renderNow, paint } from "./core/dom.js";
import { S, E, loadSaved, refresh } from "./core/state.js";
import { stream, link } from "./core/api.js";
import { listen, on } from "./core/actions.js";
import { listenTips, closePop, closeDlg } from "./core/ui.js";
import { greyOut } from "./core/features.js";
import { VIEWS } from "./views.js";
import { drawShell, initShell } from "./shell/shell.js";
import { showSignIn } from "./shell/signin.js";

/* The focused control, and a text field's caret, are kept across redraws by core/dom.js for every region. */
function drawMain() {
  const main = $("#main");
  const draw = VIEWS[S.view] ?? VIEWS.chat;
  paint(main, draw());
  greyOut(main);
  VIEWS.after?.[S.view]?.(main);
}

/* The conversation's width, from the owner's saved preference (the prototype's three: comfortable, wide, full). */
const THREAD_W = { comfortable: "720px", wide: "clamp(860px,52vw,1180px)", full: "100%" };
function drawWidth() {
  const width = THREAD_W[E.state?.preferences?.conversationWidth] ?? THREAD_W.wide;
  $("#app")?.style.setProperty("--thread-w", width);
}

on("dlg-close", () => closeDlg());
on("view", (el) => { S.view = el.dataset.v; if (el.dataset.tab) S.tabs[el.dataset.v] = el.dataset.tab; $("#app")?.classList.remove("side-open"); closePop(); renderNow(); });
on("ptab", (el) => { S.view = el.dataset.place; S.tabs[el.dataset.place] = el.dataset.v; closePop(); renderNow(); });

async function boot() {
  loadSaved();
  if (S.theme) document.documentElement.dataset.theme = S.theme;
  listen();
  listenTips();
  initShell();
  onRender(drawShell);
  onRender(drawMain);
  onRender(drawWidth);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closePop(); closeDlg(); } });
  await connect();
}

/* First load; a browser without a valid session token is asked for one (the engine's words say why it refused). */
async function connect(refusal = "") {
  try { await refresh(); }
  catch (error) {
    if (error.status === 401 || error.status === 429) { showSignIn(() => connect(true), refusal || error.status === 429 ? error.message : ""); return; }
    E.error = error; render(); return;
  }
  link.onChange = () => renderNow();
  let queued = null;
  stream([], () => {
    clearTimeout(queued);
    queued = setTimeout(() => refresh().then(render, () => {}), 250);
  });
}

boot();
