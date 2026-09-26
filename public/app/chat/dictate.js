/* Dictate into the box with the engine's own dictation (mac7/live-voice), drawn 1:1 with the prototype's composer:
   the mic (data-act="dict") starts it with POST /api/voice/dictation/listen { on: true }, which opens the microphone on
   this computer; while it listens the box gives way to "Listening… speak naturally" and Done. Done stops it
   ({ on: false }) and the words GET /api/voice/dictation settled on go in the box; the engine stopping by itself after a
   silence ends it the same way. Where the engine says it cannot dictate (canDictate false), the mic is greyed and
   carries the engine's own words for why. */

import { $, esc, renderNow } from "../core/dom.js";
import { E } from "../core/state.js";
import { toast, ic } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

const D = { state: null, reading: false, on: false, timer: null };

/* The engine's picture of dictation, read once the window is signed in (and again on each press). */
async function read() {
  try { D.state = await api("voice/dictation"); } catch (error) { toast(error.message); }
  return D.state;
}
export function loadDictation() {
  if (D.state || D.reading || !E.loaded) return;
  D.reading = true;
  read().finally(() => { D.reading = false; redrawMic(); });
}
/* Only the mic changes with what the engine said, so only the mic is drawn again (the rest of the view is left as is). */
function redrawMic() {
  const mic = document.querySelector('.composer button[aria-label="Dictate into the box"]');
  if (!mic) return;
  mic.outerHTML = micButton();
}

export const dictating = () => D.on;

export function micButton() {
  if (D.state?.canDictate === false) {
    const why = D.state.refusal || D.state.engine?.how || "";
    return `<button class="c-btn soon" type="button" aria-label="Dictate into the box" aria-disabled="true" tabindex="-1" data-tip="${esc(why)}">${ic("mic")}</button>`;
  }
  return `<button class="c-btn" type="button" aria-label="Dictate into the box" data-act="dict">${ic("mic")}</button>`;
}

export const dictRow = () => `<div class="dict"><span class="wave" aria-hidden="true">${"<i></i>".repeat(9)}</span><span>Listening… speak naturally</span><span class="tb-grow"></span><button class="btn sm" type="button" data-act="dict-done">Done</button></div>`;

/* The words go after what is already in the box, as typed words would; the box tells the conversation it changed. */
function insert(text) {
  const box = $("#prompt");
  if (!box || !text) return;
  box.value = (box.value.trim() ? box.value.replace(/\s*$/, " ") : "") + text;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

function finish(words) {
  clearInterval(D.timer);
  D.timer = null;
  D.on = false;
  renderNow();
  insert(String(words ?? "").trim());
  $("#prompt")?.focus();
}

async function start() {
  const state = await read();
  if (!state || state.canDictate === false) { renderNow(); return; }
  let said;
  try { said = await api("voice/dictation/listen", { on: true }); } catch (error) { toast(error.message); return; }
  if (said.state) D.state = said.state;
  if (said.refusal) toast(said.refusal);
  if (!said.open) { renderNow(); return; }
  D.on = true;
  renderNow();
  D.timer = setInterval(async () => {
    let now;
    try { now = await api("voice/dictation"); } catch (error) { toast(error.message); finish(""); return; }
    if (!now.open && D.on) finish(now.words);
  }, 500);
}

async function done() {
  if (!D.on) return;
  clearInterval(D.timer);
  try { await api("voice/dictation/listen", { on: false }); } catch (error) { toast(error.message); }
  let now = null;
  try { now = await api("voice/dictation"); } catch (error) { toast(error.message); }
  finish(now?.words);
}

export function initDictate() {
  markLive(["dict", "dict-done"]);
  on("dict", () => { if (!D.on) start(); });
  on("dict-done", () => done());
}
