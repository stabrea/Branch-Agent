/* Dictate into the box: the microphone records while the button is pressed in, and the engine writes it out
   (POST /api/voice/transcribe, through whichever route its voice settings choose). The words go in at the caret. */

import { $ } from "../core/dom.js";
import { toast } from "../core/ui.js";
import { apiBytes } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

const R = { rec: null, chunks: [], started: 0 };

function insert(text) {
  const box = $("#prompt");
  if (!box || !text) return;
  const at = box.selectionStart ?? box.value.length;
  const spaced = (at && !/\s$/.test(box.value.slice(0, at)) ? " " : "") + text;
  box.value = box.value.slice(0, at) + spaced + box.value.slice(box.selectionEnd ?? at);
  box.focus();
  box.setSelectionRange(at + spaced.length, at + spaced.length);
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressed(on) {
  const btn = document.querySelector('[data-act="dict"]');
  btn?.setAttribute("aria-pressed", String(on));
}

async function start() {
  let media;
  try { media = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (error) { toast(error.message); return; }
  R.chunks = [];
  R.started = Date.now();
  R.rec = new MediaRecorder(media);
  R.rec.ondataavailable = (e) => { if (e.data.size) R.chunks.push(e.data); };
  R.rec.onstop = async () => {
    media.getTracks().forEach((t) => t.stop());
    const seconds = Math.max(1, Math.round((Date.now() - R.started) / 1000));
    const blob = new Blob(R.chunks, { type: R.rec.mimeType || "audio/webm" });
    R.rec = null;
    pressed(false);
    try { insert((await apiBytes(`voice/transcribe?seconds=${seconds}`, blob)).text); } catch (error) { toast(error.message); }
  };
  R.rec.start();
  pressed(true);
}

export function initDictate() {
  markLive(["dict"]);
  on("dict", () => (R.rec ? R.rec.stop() : start()));
}
