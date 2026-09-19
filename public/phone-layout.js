/* Redesign phase 2 "everywhere" (critiques #44, #53): the window at phone and tablet widths, after the
   approved sample's phone and tablet frames. The phone app (apps/mobile) shows this same window, so it
   gets this layout too.

   - At phone width (560 px and under) a bar of places sits at the foot of the window, as in the sample:
     Conversation, Inbox (with its count), Automations, Library and Settings. The message box sits
     above it, never under it. Customize stays in the side list.
   - On a phone or tablet, a question the assistant stops on is scrolled into view above the message
     box when it arrives, so it can be answered without hunting for it.
   - The tablet layout (the side list kept as a column from 700 px) is CSS only (public/phone-layout.css).

   Layout only: nothing here decides anything, and every place opens through displayView, the same way
   the side list opens it. Colours come from public/tokens.css through the stylesheet. */
import { displayView } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const say = (key, english) => { const word = t(key); return word === key ? english : word; };
const SVG = "http://www.w3.org/2000/svg";
const ICONS = {
  chat: "M4 5h16v11H9l-5 4z",
  inbox: "M4 13l2.5-7h11L20 13v5H4zM4 13h4.5l1 2h5l1-2H20",
  automations: "M13 3 5 13h6l-1 8 8-10h-6z",
  library: "M5 4h9a4 4 0 014 4v12H9a4 4 0 01-4-4zM5 16a4 4 0 014-4h9",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1",
};
/** [where it opens, word key, English] in the sample's order. */
export const BAR = [
  ["chat", "nav.chat", "Conversation"],
  ["inbox", "place.inbox", "Inbox"],
  ["automations", "place.automations", "Automations"],
  ["library", "place.library", "Library"],
  ["settings", "settings.title", "Settings"],
];
const nearby = matchMedia("(max-width: 1024px)");

function icon(name) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}
function barButton([target, key, english]) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ew-place";
  button.dataset.place = target;
  const word = document.createElement("span");
  word.className = "ew-word";
  word.dataset.t = key;
  word.textContent = say(key, english);
  button.append(icon(target), word);
  if (target === "inbox") {
    const badge = document.createElement("span");
    badge.className = "ew-badge";
    badge.id = "ew-inbox-badge";
    badge.hidden = true;
    button.append(badge);
  }
  button.addEventListener("click", () => displayView(target));
  return button;
}

/** Which button is lit: Settings while its window is open, else the place on screen. */
export function currentOf(body = document.body) {
  if (body.classList.contains("lx-settings-open")) return "settings";
  return document.querySelector('.lx-place-link[aria-current="page"]')?.dataset.place || "chat";
}
function syncBar() {
  const current = currentOf();
  for (const button of document.querySelectorAll(".ew-place"))
    button.setAttribute("aria-current", button.dataset.place === current ? "page" : "false");
  const from = $("lx-inbox-badge"), to = $("ew-inbox-badge");
  if (from && to) {
    to.textContent = from.textContent;
    to.hidden = from.hidden || !from.textContent.trim();
  }
}
function buildBar() {
  const main = document.querySelector("body > main");
  if (!main || $("ew-places")) return;
  const nav = document.createElement("nav");
  nav.id = "ew-places";
  nav.className = "ew-places";
  nav.setAttribute("aria-label", say("ew.places", "Places"));
  nav.append(...BAR.map(barButton));
  main.append(nav);
  syncBar();
  document.addEventListener("branch-place", syncBar);
  new MutationObserver(syncBar).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  const badge = $("lx-inbox-badge");
  if (badge) new MutationObserver(syncBar).observe(badge, { attributes: true, childList: true, characterData: true, subtree: true });
}

/**
 * How far to scroll so a card's foot clears the message box (and its top stays under the title bar).
 * Its buttons are at its foot, so the foot wins when the card is taller than the room.
 */
export function scrollFor(card, dock, scroller, margin = 12) {
  const below = card.bottom - (dock.top - margin);
  if (below > 0) return below;
  const above = card.top - (scroller.top + margin);
  return above < 0 ? above : 0;
}
let shownQuestion = "";
function revealQuestion() {
  const card = $("live-ask");
  const question = card && !card.hidden ? card.textContent.trim() : "";
  if (question === shownQuestion) return;
  shownQuestion = question;
  if (!question || !nearby.matches) return;
  const scroller = $("workspace"), dock = document.querySelector(".composer-dock");
  if (!scroller || !dock) return;
  const by = scrollFor(card.getBoundingClientRect(), dock.getBoundingClientRect(), scroller.getBoundingClientRect());
  if (by) scroller.scrollTop += by;
}
function watchQuestions() {
  const chat = $("chat");
  if (!chat) return;
  new MutationObserver(() => requestAnimationFrame(revealQuestion)).observe(chat, { childList: true, subtree: true });
}

function start() {
  buildBar();
  watchQuestions();
}
if (document.body.classList.contains("lx-ready")) start();
else {
  const wait = new MutationObserver(() => {
    if (!document.body.classList.contains("lx-ready")) return;
    wait.disconnect();
    start();
  });
  wait.observe(document.body, { attributes: true, attributeFilter: ["class"] });
}
