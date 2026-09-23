/* DG-096: along the bottom of the reading pane, the conversations open in this window, one click apart, as the
   approved sample's "Open" strip: the one on screen is marked, each can be closed off the strip (the conversation
   itself stays in Recents), and more than fit scroll sideways. It is not on a phone, and it is hidden while nothing
   but the conversation on screen is open, so it never repeats what the sidebar already shows.
   Words have data-t keys; no colour is written here. */
import { displayView, openConversation } from "/app.js";
import { say } from "/strip.js";

const $ = (id) => document.getElementById(id);
const KEY = "branch-open-conversations";
const MOST = 8;

/** What this window has open, newest first: [{ id, title }]. */
function load() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list.filter((item) => item && typeof item.id === "string").slice(0, MOST) : [];
  } catch { return []; }
}
function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MOST))); } catch { /* private window: kept for this visit only */ }
}
let open = load();
const current = () => $("conversation")?.dataset.sessionId || "";
const titleOnScreen = () => $("thread-name")?.textContent.trim() || "";

function build() {
  const strip = Object.assign(document.createElement("div"), { id: "lx-open-strip", className: "lx-open-strip", hidden: true });
  strip.setAttribute("role", "navigation");
  strip.setAttribute("data-t-label", "openStrip.label");
  strip.setAttribute("aria-label", say("openStrip.label", "Open conversations"));
  const label = Object.assign(document.createElement("span"), { className: "lx-open-label", textContent: say("openStrip.open", "Open") });
  label.dataset.t = "openStrip.open";
  label.setAttribute("aria-hidden", "true");
  const list = Object.assign(document.createElement("div"), { id: "lx-open-list", className: "lx-open-list" });
  strip.append(label, list);
  document.querySelector("body > main")?.append(strip);
}

function entry(item) {
  const here = item.id === current();
  const wrap = Object.assign(document.createElement("span"), { className: `lx-open-item${here ? " on" : ""}` });
  wrap.dataset.session = item.id;
  const go = Object.assign(document.createElement("button"), { type: "button", className: "lx-open-go" });
  const words = item.title || say("openStrip.untitled", "Conversation");
  go.append(Object.assign(document.createElement("span"), { textContent: words }));
  go.title = words;
  if (here) go.setAttribute("aria-current", "page");
  go.addEventListener("click", () => { displayView("chat"); void openConversation(item.id); });
  const close = Object.assign(document.createElement("button"), { type: "button", className: "lx-open-close", textContent: "×" });
  close.setAttribute("aria-label", say("openStrip.close", "Close {name} here", { name: words }));
  close.title = close.getAttribute("aria-label");
  close.addEventListener("click", () => { open = open.filter((other) => other.id !== item.id); save(open); paint(); });
  wrap.append(go, close);
  return wrap;
}

function paint() {
  const strip = $("lx-open-strip");
  if (!strip) return;
  $("lx-open-list").replaceChildren(...open.map(entry));
  /* one open conversation that is already on screen is not worth a strip of its own */
  strip.hidden = open.length === 0 || (open.length === 1 && open[0].id === current());
  strip.querySelector(".lx-open-item.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** The conversation on screen joins the strip (or moves to its front), under the title it shows. */
function follow() {
  const id = current();
  if (id) {
    const known = open.find((item) => item.id === id);
    const title = titleOnScreen() || known?.title || "";
    if (!known) open = [{ id, title }, ...open].slice(0, MOST);
    else known.title = title;
    save(open);
  }
  paint();
}

build();
follow();
const conversation = $("conversation"), thread = $("thread-name");
if (conversation) new MutationObserver(follow).observe(conversation, { attributes: true, attributeFilter: ["data-session-id"] });
if (thread) new MutationObserver(follow).observe(thread, { childList: true, characterData: true, subtree: true });
document.addEventListener("branch-language", () => {
  const strip = $("lx-open-strip");
  if (strip) strip.setAttribute("aria-label", say("openStrip.label", "Open conversations"));
  paint();
});
