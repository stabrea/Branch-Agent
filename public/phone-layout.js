/* Redesign phase 2 "everywhere" (critiques #44, #53): the window at phone and tablet widths, after the
   approved sample's phone and tablet frames. The phone app (apps/mobile) shows this same window, so it
   gets this layout too.

   - At phone width (560 px and under) a bar of places sits at the foot of the window, as in the sample:
     Conversation, Inbox (with its count), Automations, Library and Customize (DG-143). The message box
     sits above it, never under it. Settings stays behind the gear in the side list and in More.
   - On a phone or tablet (900 px and under), a question the assistant stops on is scrolled into view above the message
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
  customize: "M4 7h10M18 7h2M4 17h4M12 17h8M16 5a2 2 0 110 4 2 2 0 010-4zM10 15a2 2 0 110 4 2 2 0 010-4z",
};
/** [where it opens, word key, English] in the sample's order. */
const BAR = [
  ["chat", "nav.chat", "Conversation"],
  ["inbox", "place.inbox", "Inbox"],
  ["automations", "place.automations", "Automations"],
  ["library", "place.library", "Library"],
  ["customize", "place.customize", "Customize"],
];
const nearby = matchMedia("(max-width: 900px)");

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

/** Which button is lit: the place on screen. */
function currentOf() {
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
  /* Only once connected: the sign-in screen shares the window and has no places to open. */
  const workspace = $("workspace");
  const showWhenConnected = () => { nav.hidden = !workspace || workspace.hidden; };
  showWhenConnected();
  if (workspace) new MutationObserver(showWhenConnected).observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
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
function revealQuestion() {
  const card = $("live-ask");
  const question = card && !card.hidden ? card.textContent.trim() : "";
  if (!question || !nearby.matches) return;
  const scroller = $("workspace"), dock = document.querySelector(".composer-dock");
  if (!scroller || !dock) return;
  const by = scrollFor(card.getBoundingClientRect(), dock.getBoundingClientRect(), scroller.getBoundingClientRect());
  if (by) scroller.scrollTop += by;
}
let revealFrame = 0;
/** Coalesces a redraw into one settled-layout measurement. */
function scheduleRevealQuestion() {
  if (revealFrame) return;
  revealFrame = requestAnimationFrame(() => {
    revealFrame = 0;
    revealQuestion();
  });
}
function watchQuestions() {
  const chat = $("chat");
  if (!chat) return;
  new MutationObserver(scheduleRevealQuestion).observe(chat, { childList: true, subtree: true });
  /* The question's choices and the fixed composer can finish laying out after their text arrives.
     Recheck their real boxes whenever either size changes, instead of trusting one early frame. */
  const sizes = new ResizeObserver(scheduleRevealQuestion);
  const card = $("live-ask"), dock = document.querySelector(".composer-dock");
  if (card) sizes.observe(card);
  if (dock) sizes.observe(dock);
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
