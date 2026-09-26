/* The one recommendation bar (prototype recBar), drawn above the conversation and at the top of Inbox and Overview only
   while the engine suggests it: GET /api/deployment/suggestion answers "background", "updates" or nothing, one at a time
   and only in the owner's window after the first run. Don't ask again is kept by the engine (POST
   /api/deployment/suggestion {id, answer: "never"}); Not now is this window's until it next opens. Yes for updates turns
   on installing updates when idle (POST /api/comfort, card notify). Yes for background installs a system service, so it
   stays greyed (its act has no handler) until that can be proved safe. */

import { render } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { toast } from "../core/ui.js";
import { markLive } from "../core/features.js";

const R = { bar: null, asked: false, later: new Set() };
const WORDS = {
  background: ["Keep your Trunks running when Branch is closed?", "The gateway keeps Telegram, your phone and automations working, and restarts Branch if it ever stops."],
  updates: ["Keep Branch up to date by itself?", "It waits until no task is working, checks the download and keeps a safety copy first."],
};

/* Draws again only when the answer changes what is shown. */
async function readBar() {
  const before = R.bar;
  try { R.bar = (await api("deployment/suggestion")).bar ?? null; } catch (error) { toast(error.message); R.bar = null; }
  if (R.bar !== before) render();
}

/* Read once the engine has let the window in; after that only an answer here re-reads it. */
export function recBar() {
  if (!R.asked && E.loaded) { R.asked = true; readBar(); }
  const id = R.bar, words = WORDS[id];
  if (!words || R.later.has(id)) return "";
  const yes = id === "updates" ? "rec" : "rec-install";
  return `<div class="recbar"><span class="mark mark-face rec-mark" aria-hidden="true"></span><span class="rec-t"><b>${words[0]}</b><span class="rec">Recommended</span><small>${words[1]}</small></span>
    <button class="btn pri sm" type="button" data-act="${yes}" data-k="${id}" data-v="yes">Yes</button><button class="btn sm" type="button" data-act="rec" data-k="${id}" data-v="later">Not now</button><button class="btn ghost sm" type="button" data-act="rec" data-k="${id}" data-v="never">Don’t ask again</button></div>`;
}

async function answer(el) {
  const id = el.dataset.k, v = el.dataset.v;
  if (v === "later") { R.later.add(id); render(); return; }
  try {
    if (v === "never") await api("deployment/suggestion", { id, answer: "never" });
    else if (v === "yes" && id === "updates") { await api("comfort", { card: "notify", values: { autoUpdate: "install" } }); toast("Branch keeps itself up to date."); }
    else return;
  } catch (error) { toast(error.message); return; }
  await readBar();
}

export function initRec() {
  markLive(["rec"]);
  on("rec", (el) => answer(el));
}
