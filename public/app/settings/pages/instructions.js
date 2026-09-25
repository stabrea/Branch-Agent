/* Settings › Instructions & personality: the owner's instruction files as the engine keeps them
   (GET /api/settings-kit/files and /files/<slot>), edited in the prototype's editor: Save writes the whole file
   (POST /api/settings-kit/files { slot, text }), and the engine keeps the one version before the last save made here,
   which "Put this back" writes back (POST /api/settings-kit/files/undo { slot }). "Write it for me" runs a tool by hand
   (POST /api/tools/try), so it stays greyed for its own review. */
import { E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { esc, render, $ } from "../../core/dom.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { ic, toast, openDlg, closeDlg } from "../../core/ui.js";

/* The prototype's line for each file, by the engine's slot. */
const ABOUT = {
  soul: "Who your assistant is: tone and boundaries", identity: "Its name and how it introduces itself", user: "Who you are and what you prefer",
  agents: "House rules for every Trunk (also reads CLAUDE.md, .hermes.md)", tools: "Notes on the tools it has", sop: "Your standing steps, read before each task",
  memory: "Notes you wrote for it", heartbeat: "What it checks on when it wakes on a schedule",
};
/* The engine's list, and each file as opened (text, lastSave, setting), by slot. */
let files = null;
const opened = {};

const lines = (text) => (text ? text.trim().split("\n").length : 0);
const nameOf = (f) => f.name ?? f.names?.[0] ?? f.slot;

async function loadFiles() {
  try {
    files = (await api("settings-kit/files")).files ?? [];
    const each = await Promise.all(files.map((f) => api(`settings-kit/files/${encodeURIComponent(f.slot)}`)));
    for (const one of each) opened[one.slot] = one;
  } catch (error) { toast(error.message); }
  render();
}

function fileRow(f) {
  const one = opened[f.slot], n = lines(one?.text), h = one?.lastSave ? 1 : 0;
  return `<div class="prow"><code class="if-name">${esc(nameOf(f))}</code><span class="grow"><b data-css="font-weight:500">${esc(ABOUT[f.slot] ?? f.about)}</b><small>${n ? `${n} lines` : "Empty"}${h ? ` · ${h} earlier version` : ""}</small></span><button class="btn sm" type="button" data-act="if-open" data-f="${esc(f.slot)}">${n ? "Edit" : "Write"}</button></div>`;
}

export function draw() {
  const everyone = true; // state: this window edits the files every Trunk reads; a Trunk's own copy is not offered yet
  const owners = `<button class="chip6" type="button" data-act="if-owner" data-v="branch" aria-pressed="${everyone}">Every Trunk</button>${E.trunks.map((t) => `<button class="chip6" type="button" data-act="if-owner" data-v="${esc(t.id)}" aria-pressed="false">${esc(t.name)}</button>`).join("")}`;
  return `<h1>Instructions &amp; personality</h1><p class="lede">Plain files every Trunk reads before it works. They work the same as in other agents, so a file written for one of them works here.</p>
  <div class="fld" data-css="margin-top:6px"><span>Whose files</span><span class="acts" data-css="gap:6px">${owners}</span></div>
  <div class="rows" data-css="margin-top:8px">${(files ?? []).map(fileRow).join("")}</div>
  <p class="hint">A file can’t widen what Branch may do; Permissions still decides. A Trunk’s own copy replaces the shared one for that Trunk only.</p>`;
}

function versions(one) {
  if (!one.lastSave) return '<p class="hint" data-css="margin:4px 0">None yet. Each save keeps the one before.</p>';
  const when = new Date(one.lastSave).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return `<div class="ifed-v"><span>${esc(when)}</span><button class="btn ghost sm" type="button" data-act="if-back" data-f="${esc(one.slot)}" data-i="0">Put this back</button></div>`;
}

function openEditor(slot, text) {
  const one = opened[slot];
  if (!one) return;
  openDlg({ title: `${one.name} · every Trunk`, wide: true, body: `<div class="ifed"><textarea class="inp code6 ifed-t" id="if-text" rows="14" spellcheck="false" aria-label="${esc(one.name)}" ${one.editable ? "" : "readonly"}>${esc(text ?? one.text)}</textarea>
    <aside class="ifed-h"><b>Earlier versions</b>${versions(one)}
    <button class="btn sm" type="button" data-act="if-write" data-f="${esc(slot)}">${ic("spark", "s")}Write it for me</button><p class="hint" data-css="margin:0">Looks around this workspace and writes a first version, like /init. Read it before you save.</p></aside></div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="if-save" data-f="${esc(slot)}">Save</button>` });
}

async function openFile(slot) {
  try { opened[slot] = await api(`settings-kit/files/${encodeURIComponent(slot)}`); } catch (error) { toast(error.message); return; }
  openEditor(slot);
}

async function save(slot) {
  const text = $("#if-text")?.value ?? "";
  try {
    const saved = await api("settings-kit/files", { slot, text });
    closeDlg();
    toast(saved.setting === "off" ? "Saved." : "Saved. The next task reads it.");
  } catch (error) { toast(error.message); return; }
  await loadFiles();
}

/* The engine writes the version before the last save back at once; the editor then shows what the file holds now. */
async function putBack(slot) {
  try {
    await api("settings-kit/files/undo", { slot });
    opened[slot] = await api(`settings-kit/files/${encodeURIComponent(slot)}`);
    openEditor(slot);
  } catch (error) { toast(error.message); }
  loadFiles();
}

export function load() { return loadFiles(); }

export function init() {
  loadFiles();
  on("if-open", (el) => openFile(el.dataset.f));
  on("if-save", (el) => save(el.dataset.f));
  on("if-back", (el) => putBack(el.dataset.f));
  markLive(["if-open", "if-save", "if-back"]);
}

export const live = { "if-open": true, "if-save": true, "if-back": true };
