/* Pictures, documents, sound and material in the conversation (design doc 4.3, pass 6 and 15).
   - Make a picture and Write a file ask the engine in the conversation (POST /api/run through the composer): the model
     answers with media.image or documents.write when a connection can. The picture card (pick, make again, use as
     background) stays greyed until the window can show a picture the engine kept.
   - Sound and video a person attached play inside the thread: the file comes from GET /api/attachments/file, the length
     from the file itself and the waveform from its own samples.
   - @ references in the draft show as chips over the box; x takes one out of the draft. "read as material, not
     instructions" shows only while the engine reads them that way (GET /api/coding, mentions). */

import { $, $$, esc, onRender, applyCss } from "../core/dom.js";
import { S } from "../core/state.js";
import { api, token } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, mi, openDlg, closeDlg, closePop, toast, dialog } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { bgMenuItem } from "./bg.js";

/* ---------- the + menu's extra rows, 1:1 with the prototype (pass 6 and 15) ---------- */
export function plusMore() {
  return "<hr>" + mi("imagine", "image", "Make a picture") + "<hr>" + bgMenuItem() + mi("office15", "doc", "Write a document, spreadsheet or slides");
}

/* Sends words as the next message, through the composer, so the thread shows it like anything typed. */
function sendAsMessage(words) {
  const box = $("#prompt");
  const form = $("#composer");
  if (!box || !form) return;
  box.value = words;
  box.dispatchEvent(new Event("input", { bubbles: true }));
  form.requestSubmit();
}

function needWords(input) {
  input?.setAttribute("aria-invalid", "true");
  input?.focus();
}

function openImagine() {
  closePop();
  openDlg({ title: "Make a picture", body: '<label class="fld"><span>Describe it</span><input class="inp" id="img-q" placeholder="A quiet valley at dawn, soft light" maxlength="120"></label>',
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="img-go">Make it</button>' });
}
function makePicture() {
  const input = $("#img-q");
  const words = (input?.value ?? "").trim();
  if (!words) return needWords(input);
  closeDlg();
  sendAsMessage(`Make a picture: ${words}`);
}

const KINDS = [["docx", "Document", "Word · .docx"], ["xlsx", "Spreadsheet", "Excel · .xlsx"], ["pptx", "Slides", "PowerPoint · .pptx"]];
function openOffice() {
  closePop();
  const kinds = KINDS.map(([k, t, s], i) => `<button type="button" role="radio" aria-checked="${i === 0}" data-act="offk15" data-v="${k}"><span class="fi">${k}</span><b>${t}</b><small>${s}</small></button>`).join("");
  openDlg({ title: "Write a file", body: `<div class="office15" role="radiogroup" aria-label="Kind of file">${kinds}</div><label class="fld"><span>What should it be?</span><input class="inp" id="off-in15" placeholder="A one-page summary"></label>`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="offgo15">Write it</button>' });
}
function pickKind(el) {
  dialog()?.querySelectorAll(".office15 button").forEach((b) => b.setAttribute("aria-checked", String(b === el)));
}
function writeFile() {
  const input = $("#off-in15");
  const words = (input?.value ?? "").trim();
  if (!words) return needWords(input);
  const k = dialog()?.querySelector('.office15 [aria-checked="true"]')?.dataset.v ?? "docx"; // state: a selector that reads the chosen kind, not markup
  const [, t, s] = KINDS.find(([key]) => key === k) ?? KINDS[0];
  closeDlg();
  sendAsMessage(`${t} (${s}): ${words}`);
}

/* ---------- sound and video attached to a message ---------- */
const M = new Map(); // "<session>/<id>" -> { name, kind, session, id, url, el, dur, peaks, loading }
const BARS = 38;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const playable = (a) => a && (a.kind === "sound" || a.kind === "video" || /^(audio|video)\//.test(a.mediaType ?? ""));

/* The rows under a message for each sound or video it carries; `session` is the conversation it belongs to. */
export function mediaRows(m, session = S.chat) {
  if (!session || !Array.isArray(m.attachments)) return "";
  return m.attachments.filter(playable).map((a) => {
    const key = `${session}/${a.id}`;
    if (!M.has(key)) M.set(key, { name: a.name ?? "", kind: /^video\//.test(a.mediaType ?? "") || a.kind === "video" ? "video" : "audio", session, id: a.id });
    return `<div class="u umedia15">${mediaCard(key)}</div>`;
  }).join("");
}

function bar(key, st) {
  const at = st.el?.currentTime ?? 0;
  const pct = st.dur ? Math.min(100, (at / st.dur) * 100) : 0;
  const slider = `data-act="mseek15" data-id="${esc(key)}" role="slider" aria-label="Position" aria-valuemin="0" aria-valuemax="${Math.round(st.dur ?? 0)}" aria-valuenow="${Math.round(at)}" tabindex="0"`;
  if (st.kind === "audio") return `<div class="m-wave15" ${slider}>${(st.peaks ?? []).map((h, i) => `<i data-css="height:${h}%" class="${(i / BARS) * 100 < pct ? "on" : ""}"></i>`).join("")}</div>`;
  return `<div class="m-track15" ${slider}><u data-css="width:${pct}%"></u></div>`;
}
function mediaCard(key) {
  const st = M.get(key);
  const playing = st.el && !st.el.paused;
  const glyph = ic(playing ? "pause15" : "play15");
  const ctl = `<button type="button" class="m-play15" data-act="mplay15" data-id="${esc(key)}" aria-label="${playing ? "Pause" : "Play"} ${esc(st.name)}">${glyph}</button>`;
  const time = st.dur ? `<span class="m-time15">${mmss(st.el?.currentTime ?? 0)} / ${mmss(st.dur)}</span>` : "";
  const poster = st.kind === "video" ? `<div class="m-poster15" data-act="mplay15" data-id="${esc(key)}"><span class="m-big15">${glyph}</span></div>` : "";
  return `<div class="media15 ${st.kind} mine15" data-m15="${esc(key)}">${poster}<div class="m-row15">${ctl}${bar(key, st)}${time}</div><div class="m-name15">${ic("chip15", "s")}${esc(st.name)}</div></div>`;
}

/* Redraws one card where it stands; a video keeps its own element, moved back into the new poster. */
function repaint(key) {
  const st = M.get(key);
  for (const node of $$(`[data-m15="${CSS.escape(key)}"]`)) {
    const focused = node.contains(document.activeElement) ? document.activeElement.dataset.act : null;
    const holder = document.createElement("div");
    holder.innerHTML = mediaCard(key);
    applyCss(holder);
    const fresh = holder.firstElementChild;
    node.replaceWith(fresh);
    mountVideo(fresh, st);
    if (focused) fresh.querySelector(`[data-act="${focused}"]`)?.focus();
  }
}
function mountVideo(card, st) {
  if (st.kind !== "video" || !st.el) return;
  const poster = card.querySelector(".m-poster15");
  if (poster && st.el.parentNode !== poster) poster.prepend(st.el);
}

async function fileOf(st) {
  const auth = token.get();
  const response = await fetch(`/api/attachments/file?session=${encodeURIComponent(st.session)}&id=${encodeURIComponent(st.id)}`, { cache: "no-store", headers: auth ? { authorization: "Bearer " + auth } : {} });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || String(response.status));
  return response.blob();
}
async function peaksOf(blob) {
  const context = new AudioContext();
  try {
    const sound = await context.decodeAudioData(await blob.arrayBuffer());
    const samples = sound.getChannelData(0);
    const size = Math.max(1, Math.floor(samples.length / BARS));
    const loud = Array.from({ length: BARS }, (_, i) => { let top = 0; for (let j = i * size; j < (i + 1) * size && j < samples.length; j++) top = Math.max(top, Math.abs(samples[j])); return top; });
    const most = Math.max(...loud) || 1;
    return loud.map((v) => Math.round(12 + (v / most) * 88));
  } finally { context.close(); }
}

/* Fetches the file once, reads its length (and, for sound, its waveform), and redraws the card. */
async function load(key) {
  const st = M.get(key);
  if (!st || st.el || st.loading) return st?.loading;
  st.loading = (async () => {
    const blob = await fileOf(st);
    st.url = URL.createObjectURL(blob);
    if (st.kind === "audio") st.peaks = await peaksOf(blob);
    const el = document.createElement(st.kind === "video" ? "video" : "audio");
    el.preload = "metadata";
    el.playsInline = true;
    el.src = st.url;
    await new Promise((done, fail) => { el.addEventListener("loadedmetadata", done, { once: true }); el.addEventListener("error", () => fail(new Error(el.error?.message || "error")), { once: true }); });
    st.dur = el.duration;
    st.el = el;
    for (const kind of ["play", "pause", "timeupdate", "ended"]) el.addEventListener(kind, () => repaint(key));
    repaint(key);
  })();
  try { await st.loading; } catch (error) { toast(error.message); } finally { st.loading = null; }
}

async function playPause(el) {
  const key = el.dataset.id;
  if (!M.get(key)?.el) await load(key);
  const media = M.get(key)?.el;
  if (!media) return;
  if (media.paused) media.play().catch((error) => toast(error.message));
  else media.pause();
}
function seekTo(key, seconds) {
  const st = M.get(key);
  if (!st?.el || !st.dur) return;
  st.el.currentTime = Math.max(0, Math.min(st.dur, seconds));
  repaint(key);
}
async function seek(el, event) {
  const key = el.dataset.id;
  if (!M.get(key)?.el) await load(key);
  const r = el.getBoundingClientRect();
  const x = (event?.clientX ?? r.left) - r.left;
  seekTo(key, (x / r.width) * (M.get(key)?.dur ?? 0));
}

/* After a draw, cards not yet read fetch their file so they can show their length and waveform. */
function mountMedia() {
  for (const card of $$("[data-m15]")) {
    const st = M.get(card.dataset.m15);
    if (!st) continue;
    if (st.el) mountVideo(card, st);
    else load(card.dataset.m15);
  }
}

/* ---------- @ references in the draft ---------- */
const R = { mentions: null, checked: 0 };
const matOf = (t) => [...new Set(((t || "").match(/@(\S+)/g) || []).map((x) => x.slice(1)).filter((x) => x === "diff" || /[./]/.test(x)))];
async function mentionsOn() {
  if (Date.now() - R.checked < 15000) return R.mentions;
  R.checked = Date.now();
  try { R.mentions = (await api("coding")).modes?.mentions ?? "off"; } catch (error) { toast(error.message); }
  return R.mentions;
}
/* The material chips for what the draft points at; drawn into the dock row. */
export function materials(draft = S.drafts[S.chat ?? "new"]) {
  const mats = matOf(draft);
  if (!mats.length) return "";
  if (Date.now() - R.checked >= 15000) mentionsOn().then((was) => { if (was !== R.mentions) document.dispatchEvent(new Event("branch-dock")); });
  const chips = mats.map((m) => `<span class="mat15">${ic(m === "diff" ? "branch" : m.startsWith("http") ? "globe" : "doc", "s")}<span>${esc(m === "diff" ? "Changes" : m.split("/").pop() || m)}</span><button type="button" aria-label="Remove ${esc(m)}" data-act="matrm15" data-v="${esc(m)}">${ic("x", "s")}</button></span>`).join("");
  return chips + (R.mentions && R.mentions !== "off" ? '<small class="mat-n15">read as material, not instructions</small>' : "");
}
function removeMaterial(el) {
  const box = $("#prompt");
  if (!box) return;
  box.value = box.value.replace("@" + el.dataset.v, "").replace(/\s{2,}/g, " ");
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

export function initMedia() {
  markLive(["sw:img-q", "sw:off-in15", "imagine", "img-go", "office15", "offk15", "offgo15", "mplay15", "mseek15", "matrm15"]);
  on("imagine", () => openImagine());
  on("img-go", () => makePicture());
  on("office15", () => openOffice());
  on("offk15", (el) => pickKind(el));
  on("offgo15", () => writeFile());
  on("mplay15", (el) => playPause(el));
  on("mseek15", (el, event) => seek(el, event));
  on("matrm15", (el) => removeMaterial(el));
  onRender(() => queueMicrotask(mountMedia));
  document.addEventListener("keydown", (e) => {
    const t = e.target.closest?.(".m-wave15, .m-track15");
    if (!t || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    const st = M.get(t.dataset.id);
    if (st?.el) seekTo(t.dataset.id, st.el.currentTime + (e.key === "ArrowRight" ? 5 : -5));
  });
}
