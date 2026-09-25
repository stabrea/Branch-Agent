/* Walkthrough: 28-card guided tour of Branch features. */

import { $, esc } from "../core/dom.js";
import { openDlg, closeDlg } from "../core/ui.js";
import { S } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

const TOUR = [
  { sel: ".list", title: "Your Trunks are contacts", text: "Each Trunk is an assistant with one job. Message it like a teammate." },
  { sel: ".agent12", title: "Your Trunks, in person", text: "Each Trunk can have a character. It shows what the Trunk is doing." },
  { sel: "[data-note='computer']", title: "Watch it work", text: "When a Trunk uses the browser you see it live, with Take over one click away." },
  { sel: ".ask", title: "It asks before it acts", text: "Anything that sends, deletes, spends or installs waits for your yes." },
  { sel: ".side-nav", title: "Five places", text: "Overview, Inbox, Automations, Library, Customize." },
  { sel: ".sq9", title: "Search everything", text: "Chats, Trunk names, words inside messages and past sessions." },
  { sel: "[data-note='gear']", title: "Settings, your way", text: "Regular, Advanced or Technical: just the essentials, or every detail." },
  { sel: null, title: "That's Branch", text: "" }
];

export function init() {
  markLive(["tour", "tour-next", "tour-back", "tour-end"]);
  on("tour", () => startTour());
  on("tour-next", () => goTour((S.tourI || 0) + 1));
  on("tour-back", () => goTour((S.tourI || 0) - 1));
  on("tour-end", () => endTour());
}

export function startTour() {
  S.tourI = 0;
  goTour(0);
}

function goTour(i) {
  S.tourI = Math.max(0, Math.min(i, TOUR.length - 1));
  drawTour();
}

function drawTour() {
  const card = TOUR[S.tourI];
  if (!card) return endTour();

  const el = card.sel ? document.querySelector(card.sel) : null;
  const rect = el?.getBoundingClientRect();

  const html = `<div class="tour-layer" role="dialog" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:2000">
    <div class="tour-card" style="position:absolute;background:var(--raise);border-radius:12px;padding:16px;max-width:400px;box-shadow:0 10px 40px rgba(0,0,0,0.3)">
      <div style="margin-bottom:16px">
        <h3 style="margin:0 0 8px;font-size:16px;font-weight:600">${esc(card.title)}</h3>
        <p style="margin:0;color:var(--ink-2);font-size:14px">${esc(card.text)}</p>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        ${S.tourI > 0 ? '<button class="btn ghost" type="button" data-act="tour-back">Back</button>' : ''}
        ${S.tourI < TOUR.length - 1 ? '<button class="btn pri" type="button" data-act="tour-next">Next</button>' : '<button class="btn pri" type="button" data-act="tour-end">Done</button>'}
      </div>
    </div>
  </div>`;

  const existing = document.querySelector(".tour-layer");
  if (existing) existing.remove();
  document.getElementById("app").appendChild((() => {
    const div = document.createElement("div");
    div.innerHTML = html;
    return div.firstElementChild;
  })());

  if (rect) {
    const card = document.querySelector(".tour-card");
    const x = Math.max(8, Math.min(rect.left, window.innerWidth - 408));
    const y = Math.max(8, rect.bottom + 16);
    card.style.left = x + "px";
    card.style.top = Math.min(y, window.innerHeight - 200) + "px";
  }
}

function endTour() {
  document.querySelector(".tour-layer")?.remove();
  S.tourI = null;
}
