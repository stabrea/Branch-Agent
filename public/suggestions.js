/* Redesign phase 1: one quiet bar at the top of the conversation pane that recommends a setting, the way the
   approved sample asks "Keep Branch up to date by itself? Recommended". One bar at a time, at most once
   each time the window opens, never before the first-run screen is done, only in the owner's window.
   Yes, Not now, Don't ask again; nothing changes unless Yes is pressed. The server says which bar
   applies (src/suggestions.ts); Yes goes through the same routes as the Settings switches. */
import { api, toast } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
let asked = false;

const BARS = {
  background: { words: "suggest.background", why: "suggest.backgroundWhy", yes: async () => {
    /* Integration review: the result is said as it is; a failure never reads as success. */
    const report = await api("deployment/daemon", { action: "install" })
      .catch((error) => ({ installed: false, message: error.message }));
    toast(report?.installed ? t("suggest.backgroundOn") : t("suggest.backgroundFailed", { why: report?.message || t("suggest.noReason") }));
  } },
  updates: { words: "suggest.updates", why: "suggest.updatesWhy", yes: async () => {
    await api("comfort", { card: "notify", values: { autoUpdate: "install" } });
    toast(t("suggest.updatesOn"));
  } },
};

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
/* Marked with its key, so the words follow the language even when it arrives after the bar. */
function worded(tag, key, className) {
  const node = el(tag, t(key), className);
  node.dataset.t = key;
  return node;
}
function button(key, className, onPress) {
  const node = worded("button", key, className);
  node.type = "button";
  node.addEventListener("click", onPress);
  return node;
}
function barFor(id) {
  const spec = BARS[id];
  const bar = el("div", undefined, "suggest-bar");
  bar.id = "suggest-bar";
  bar.dataset.suggestion = id;
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", t(spec.words));
  bar.dataset.tLabel = spec.words;
  /* The KeepOak mark, the light one on a dark theme and the dark one in Daylight (style.css swaps them). */
  const marks = [["oak-reversed", "/assets/keepoak-mark-reversed.png"], ["oak-normal", "/assets/keepoak-mark.png"]].map(([kind, src]) => {
    const mark = el("img", undefined, `suggest-mark ${kind}`);
    mark.src = src;
    mark.alt = "";
    return mark;
  });
  const words = el("span", undefined, "suggest-words");
  words.append(worded("span", spec.words), document.createTextNode(" "), worded("b", "suggest.recommended"), worded("small", spec.why));
  const close = () => { bar.remove(); $("prompt")?.focus(); };
  const yes = button("suggest.yes", "suggest-yes", async () => {
    close();
    try { await spec.yes(); } catch (error) { toast(error.message); }
  });
  const later = button("suggest.later", "suggest-later quiet-button", close);
  const never = button("suggest.never", "suggest-never text-button", async () => {
    close();
    try { await api("deployment/suggestion", { id, answer: "never" }); } catch (error) { toast(error.message); }
  });
  bar.append(...marks, words, yes, later, never);
  return bar;
}

/** Offers the bar that applies, once per launch, when nothing else is being offered there. */
export async function offerSuggestion() {
  if (asked || $("workspace")?.hidden !== false || !sessionStorage.getItem("branch-token")) return;
  if ($("first-run") && !$("first-run").hidden) return;
  /* The full window keeps its greeting in the page's flow, where a bar above it would push it under
     the message box on a short screen; there the bar waits for a conversation to be on screen. */
  if (document.documentElement.dataset.everything === "on" && !$("conversation")?.childElementCount) return;
  asked = true;
  const { bar } = await api("deployment/suggestion").catch(() => ({ bar: null }));
  if (!bar || !BARS[bar] || $("suggest-bar") || $("lx-tip")) return;
  /* At the top of the conversation, in its flow: it never covers anything, and the message box and
     the question over it do not move. */
  $("chat").prepend(barFor(bar));
}
/* Tried when the window unlocks, when the first-run screen closes and when a conversation shows. */
new MutationObserver(() => void offerSuggestion()).observe($("workspace"), { attributes: true, attributeFilter: ["hidden"] });
if ($("first-run")) new MutationObserver(() => void offerSuggestion()).observe($("first-run"), { attributes: true, attributeFilter: ["hidden"] });
new MutationObserver(() => void offerSuggestion()).observe($("conversation"), { childList: true });
void offerSuggestion();
globalThis.branchSuggestions = { offer: offerSuggestion, again: () => { asked = false; return offerSuggestion(); } };
