/* Find in this conversation (Ctrl+F), 1:1 with the prototype's: a bar above the thread, every match marked, the current
   one scrolled to, "n of N", and Enter or the arrows to step. It only reads what is already drawn. */

import { $, esc, render } from "../core/dom.js";
import { ic } from "../core/ui.js";
import { S } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

export const FIND = { on: false, q: "", i: 0, n: 0 };

export function findBar() {
  if (!FIND.on) return "";
  return `<div class="find9" role="search"><span class="find9-i">${ic("search", "s")}</span><input id="find9-q" value="${esc(FIND.q)}" placeholder="Find in this conversation" autocomplete="off" aria-label="Find in this conversation"><span id="find9-n" class="find9-n"></span><button type="button" class="icon-btn" data-act="find-step" data-v="-1" aria-label="Previous">${ic("up", "s")}</button><button type="button" class="icon-btn flip9" data-act="find-step" data-v="1" aria-label="Next">${ic("up", "s")}</button><button type="button" class="icon-btn" data-act="find-close" aria-label="Close find">${ic("x", "s")}</button></div>`;
}

function mark(thread, q) {
  const walker = document.createTreeWalker(thread, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.parentElement.closest("button,textarea") ? 2 : t.nodeValue.toLowerCase().includes(q) ? 1 : 2) });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let n = 0;
  for (const t of nodes) {
    const frag = document.createDocumentFragment();
    let s = t.nodeValue, i;
    while ((i = s.toLowerCase().indexOf(q)) >= 0) {
      frag.append(s.slice(0, i));
      frag.append(Object.assign(document.createElement("mark"), { className: "hit9", textContent: s.slice(i, i + q.length) }));
      s = s.slice(i + q.length);
      n++;
    }
    frag.append(s);
    t.replaceWith(frag);
  }
  return n;
}

function show() {
  const hits = document.querySelectorAll("#conversation mark.hit9");
  hits.forEach((m, k) => m.classList.toggle("cur9", k === FIND.i));
  hits[FIND.i]?.scrollIntoView({ block: "center" });
  const count = $("#find9-n");
  if (count) count.textContent = FIND.q.trim() ? (FIND.n ? `${FIND.i + 1} of ${FIND.n}` : "No matches") : "";
}

/* After the thread is drawn: mark the matches of what is being looked for. */
export function applyFind() {
  const thread = $("#conversation");
  if (!FIND.on || !thread) return;
  const q = FIND.q.trim().toLowerCase();
  FIND.n = q ? mark(thread, q) : 0;
  if (FIND.i >= FIND.n) FIND.i = Math.max(0, FIND.n - 1);
  show();
}

function step(by) {
  if (!FIND.n) return;
  FIND.i = (FIND.i + by + FIND.n) % FIND.n;
  show();
}

function open() {
  FIND.on = true;
  render();
  requestAnimationFrame(() => $("#find9-q")?.focus());
}

export function initFind() {
  markLive(["find-open", "find-close", "find-step"]);
  on("find-open", () => (FIND.on ? (FIND.on = false, render()) : open()));
  on("find-close", () => { FIND.on = false; render(); });
  on("find-step", (el) => step(+el.dataset.v));
  document.addEventListener("input", (e) => { if (e.target.id === "find9-q") { FIND.q = e.target.value; FIND.i = 0; render(); } });
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "f" && S.view === "chat") { e.preventDefault(); if (!FIND.on) open(); else $("#find9-q")?.focus(); }
    else if (e.target.id === "find9-q" && e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.target.id === "find9-q" && e.key === "Escape") { e.stopPropagation(); FIND.on = false; render(); }
  });
}
