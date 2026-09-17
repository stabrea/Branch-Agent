/**
 * R17-S06: what comes straight after first run. First run already ends in the conversation with
 * the message box ready (`public/app.js`, "Done, start chatting"). This card sits above that
 * conversation and offers three things, none of which happens without a click:
 *
 *   Say hello          sends a first message, so the first thing seen is a real answer
 *   Watch me once      switches on recording each task ("only when it is needed"), so the next
 *                      task can be saved as a workflow from Inbox › History
 *   Suggested automations  put a ready-made request in the message box to read and send
 *
 * "Not now" closes it. It is shown once per browser.
 */
import { api } from "/app.js";
import { t } from "/i18n.js";

const SEEN = "branch-first-run-next";
const say = (key, english) => { const words = t(key); return words === key ? english : words; };
function el(tag, key, english, className) {
  const node = document.createElement(tag);
  if (key) node.dataset.t = key;
  if (english !== undefined) node.textContent = key ? say(key, english) : english;
  if (className) node.className = className;
  return node;
}
function action(key, english, onClick, filled = false) {
  const node = el("button", key, english, filled ? "" : "quiet-button");
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

const SUGGESTIONS = [
  ["first-run-next.suggest.brief", "Every weekday at 8 in the morning, give me a short summary of what changed in my workspace."],
  ["first-run-next.suggest.tidy", "Once a week, look through my Downloads folder and suggest what I can delete. Do not delete anything yourself."],
  ["first-run-next.suggest.watch", "Check this page every day and tell me when it changes: "],
];

/** Puts words in the message box and, when asked, sends them. */
function compose(words, send) {
  const prompt = document.getElementById("prompt");
  if (!prompt) return;
  prompt.value = words;
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  prompt.focus();
  if (send) document.getElementById("chat-form")?.requestSubmit();
}

async function watchMeOnce(status) {
  status.textContent = say("first-run-next.watch-working", "Switching on…");
  try {
    const plan = { source: "set", key: "run-recording", field: "mode", value: "when-needed" };
    await api("settings-kit/apply", { plan, accept: ["run-recording.mode"], confirmLoosening: false });
    status.textContent = say("first-run-next.watch-done",
      "Recording is on. Do the task once in this conversation, then open it in Inbox › History and choose to save it as a workflow.");
  } catch (error) { status.textContent = error.message; }
}

function build() {
  const card = el("section", undefined, undefined, "card first-run-next");
  card.id = "first-run-next";
  const status = el("p", undefined, undefined, "meta");
  status.setAttribute("role", "status");
  const close = () => { card.remove(); try { localStorage.setItem(SEEN, "1"); } catch { /* forgotten in a private window */ } };
  const chips = el("div", undefined, undefined, "first-run-next-chips");
  chips.append(...SUGGESTIONS.map(([key, english]) => action(key, english, () => compose(say(key, english), false))));
  card.append(
    el("h2", "first-run-next.title", "You're ready"),
    el("p", "first-run-next.purpose", "Your assistant is answering. Say hello to see it work, or pick something to try."),
    action("first-run-next.hello", "Say hello", () => { compose(say("first-run-next.hello-words", "Hello! In two sentences, what can you help me with?"), true); close(); }, true),
    el("h3", "first-run-next.watch-title", "Show it once"),
    el("p", "first-run-next.watch-purpose", "Do a task yourself in a conversation and it can be saved as a workflow to run again.", "subtle"),
    action("first-run-next.watch", "Watch me once", () => watchMeOnce(status)),
    el("h3", "first-run-next.suggest-title", "Suggested automations"),
    el("p", "first-run-next.suggest-purpose", "Each one only fills in the message box. Read it, change it, and send it if you want it.", "subtle"),
    chips, status,
    action("first-run-next.later", "Not now", close),
  );
  return card;
}

export function showFirstRunNext() {
  if (document.getElementById("first-run-next")) return;
  const firstRun = document.getElementById("first-run");
  if (!firstRun) return;
  firstRun.after(build());
}

if (typeof document !== "undefined") {
  globalThis.branchFirstRunDone = () => {
    let seen = false;
    try { seen = localStorage.getItem(SEEN) === "1"; } catch { /* show it */ }
    if (!seen) showFirstRunNext();
  };
}
