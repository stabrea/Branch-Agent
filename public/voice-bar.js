/* Redesign phase 2 "rooms" (critique #33): dictation, surfaced. Dictate becomes a microphone in the
   message box, and while it listens a bar sits on top of the box: that it is listening, for how long,
   that nothing leaves this computer, and two ways to stop: keep the words, or throw them away.

   Nothing here opens a microphone or decides anything: public/dictation.js still does all of it, and
   the bar is shown for exactly as long as its button says the microphone is open (which it reads from
   the app, not from what was last pressed). Colours only through tokens (public/rooms.css). */
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const say = (key, english) => { const word = t(key); return word === key ? english : word; };
const SVG = "http://www.w3.org/2000/svg";
function mic() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ["M9 5a3 3 0 016 0v6a3 3 0 01-6 0z", "M5 11a7 7 0 0014 0", "M12 18v3"]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The Dictate button, as a microphone with its name kept for screen readers and the tooltip. */
function dressButton(button) {
  if (button.dataset.dressed) return;
  button.dataset.dressed = "1";
  button.removeAttribute("data-t");
  button.dataset.tLabel = "action.dictate";
  button.classList.add("composer-icon", "voice-dictate-icon");
  button.setAttribute("aria-label", say("action.dictate", "Dictate"));
  button.replaceChildren(mic());
}

let started = 0;
let clock = null;
function elapsed() {
  const seconds = Math.floor((Date.now() - started) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function stopButton(keep) {
  const button = el("button", `dictation-stop ${keep ? "keep" : "discard"}`, keep ? "✓" : "✕");
  button.type = "button";
  const label = keep ? say("dictation.keep", "Stop and keep the words") : say("dictation.discard", "Stop and throw the words away");
  button.setAttribute("aria-label", label);
  button.title = label;
  button.addEventListener("click", () => void globalThis.branchDictation?.stop(keep));
  return button;
}
function openBar() {
  if ($("dictation-bar")) return;
  const bar = el("div", "dictation-bar");
  bar.id = "dictation-bar";
  bar.setAttribute("role", "status");
  const time = el("span", "dictation-time", "0:00");
  bar.append(el("span", "dictation-pulse"), el("b", "", say("dictation.listening", "Listening")), time,
    el("span", "dictation-note", say("dictation.local", "On this computer. Nothing leaves it.")), stopButton(true), stopButton(false));
  ($("composer-dock") ?? $("chat-form")?.parentElement)?.prepend(bar);
  started = Date.now();
  clock = setInterval(() => { time.textContent = elapsed(); }, 500);
}
function closeBar() {
  clearInterval(clock);
  clock = null;
  $("dictation-bar")?.remove();
}

const button = $("voice-dictate");
if (button) {
  dressButton(button);
  const follow = () => (button.getAttribute("aria-pressed") === "true" && !button.hidden ? openBar() : closeBar());
  new MutationObserver(follow).observe(button, { attributes: true, attributeFilter: ["aria-pressed", "hidden"] });
  follow();
}
