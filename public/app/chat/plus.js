/* The composer's + menu, 1:1 with the prototype's. Attach files reads the picked files in this window and sends them with
   the next message (POST /api/run attachments, within the engine's limits); Mention and Use a skill type @ or / into the box;
   Temporary conversation starts the next conversation as one the engine never keeps (POST /api/run temporary). Folders,
   screenshots, asking questions first and the thinking row stay greyed until the engine can do them. */

import { $, esc, applyCss } from "../core/dom.js";
import { ic, openPop, closePop, mi, toast } from "../core/ui.js";
import { S } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { plusMore } from "./media.js";

const MAX_FILES = 6, MAX_BYTES = 32 * 1024 * 1024;
const Q = { files: [], temporary: false };

function menu() {
  return mi("attach", "clip", "Attach files") + mi("add-folder", "folder", "Add a folder") + mi("shot", "camera", "Take a screenshot") + "<hr>"
    + mi("insert", "at", "Mention a Trunk", "<kbd>@</kbd>", 'data-v="@"') + mi("insert", "slash", "Use a skill", "<kbd>/</kbd>", 'data-v="/"') + "<hr>"
    + `<div class="row-in"><span>${ic("ghost", "s")} Temporary conversation</span><input class="sw" type="checkbox" id="pm-temp" data-sw="temp" ${Q.temporary ? "checked" : ""} ${S.chat ? "disabled" : ""} aria-label="Temporary conversation"></div><div class="row-in"><span>${ic("help", "s")} Ask me questions first</span><input class="sw" type="checkbox" id="pm-ask" data-sw="askqs" aria-label="Ask me questions first"></div><div class="row-in"><span>Thinking</span><span class="seg">${["Quick", "Normal", "Deep"].map((t) => `<button type="button" data-act="think" data-v="${t}" aria-pressed="false">${t}</button>`).join("")}</span></div>`
    + "<hr>" + mi("prompts-fill", "star", "Saved prompts", "<kbd>/</kbd>"); // handled in messages.js
}

/* The files waiting to go with the next message, in the design's file chip; clicking one takes it off. */
export function attached() {
  if (!Q.files.length) return "";
  return `<div class="acts" data-css="margin:0 0 6px;flex-wrap:wrap">${Q.files.map((f, i) => `<button class="file" type="button" data-act="unattach" data-i="${i}" aria-label="Remove ${esc(f.name)}"><span class="fi">${esc(f.name.split(".").pop())}</span><span><b>${esc(f.name)}</b><small>${Math.max(1, Math.round(f.size / 1024))} KB</small></span></button>`).join("")}</div>`;
}

/* What the next message carries; handed over once, then cleared. */
export function takePending(isNew) {
  const out = {};
  if (Q.files.length) out.attachments = Q.files.map(({ mediaType, name, data }) => ({ mediaType, name, data }));
  if (isNew && Q.temporary) out.temporary = true;
  Q.files = [];
  Q.temporary = false;
  return out;
}

const read = (file) => new Promise((done, fail) => {
  const r = new FileReader();
  r.onload = () => done(String(r.result).replace(/^data:[^,]*,/, ""));
  r.onerror = () => fail(r.error);
  r.readAsDataURL(file);
});

async function pick() {
  closePop();
  const input = Object.assign(document.createElement("input"), { type: "file", multiple: true });
  input.addEventListener("change", async () => {
    for (const file of input.files) {
      const total = Q.files.reduce((n, f) => n + f.size, 0) + file.size;
      if (Q.files.length >= MAX_FILES || total > MAX_BYTES) { toast(`At most ${MAX_FILES} files and ${MAX_BYTES / 1048576} MB with one message.`); break; }
      Q.files.push({ name: file.name, size: file.size, mediaType: file.type || "application/octet-stream", data: await read(file) });
    }
    redraw();
  });
  input.click();
}

function redraw() {
  const box = $("#attached");
  if (!box) return;
  box.innerHTML = attached();
  applyCss(box);
}

function insert(text) {
  closePop();
  const box = $("#prompt");
  if (!box) return;
  const at = box.selectionStart ?? box.value.length;
  box.value = box.value.slice(0, at) + text + box.value.slice(box.selectionEnd ?? at);
  box.focus();
  box.setSelectionRange(at + text.length, at + text.length);
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

export function initPlus() {
  markLive(["plusmenu", "attach", "unattach", "insert", "sw:pm-temp"]);
  on("plusmenu", (el) => openPop(el, menu() + plusMore()));
  on("attach", () => pick());
  on("unattach", (el) => { Q.files.splice(+el.dataset.i, 1); redraw(); });
  on("insert", (el) => insert(el.dataset.v));
  document.addEventListener("change", (e) => { if (e.target.id === "pm-temp") Q.temporary = e.target.checked; });
}
