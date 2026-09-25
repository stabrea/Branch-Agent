/* A Trunk, changed from the window (design doc 5.7): the Trunk editor, the Trunk's own menu items (pin, rename, remove),
   starting a Trunk from a job, and a new room. Every change goes to the engine's Trunk routes (src/trunks/api.ts):
   POST /api/trunks/{id} merges the fields it is given, but `look` is replaced whole, so the full look is always sent.
   What it may do (the permission switches) stays greyed: loosening a Trunk is not done from here. */

import { $, esc, onRender } from "../core/dom.js";
import { openDlg, closeDlg, closePop, toast, ic, av, mi } from "../core/ui.js";
import { S, E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive } from "../core/features.js";

export const COLOURS = ["#2F8C86", "#D8612A", "#8A5AA8", "#5E8C4A", "#4F6FA8", "#C9982E", "#B84A6B", "#56616B"];
/* The prototype draws five shapes; the engine names seven (src/trunks/look.ts). Shape i is saved as SHAPE_NAMES[i]. */
const SHAPES = ["50%", "58% 42% 54% 46% / 52% 56% 44% 48%", "46% 54% 42% 58% / 60% 44% 56% 40%", "62% 38% 50% 50% / 45% 55% 45% 55%", "42% 58% 58% 42% / 50% 42% 58% 50%"];
const SHAPE_NAMES = ["circle", "pebble", "leaf", "acorn", "shield"];
/* The prototype's Bob is the engine's sway (the engine has no bob). */
const MOTIONS = [["none", "None"], ["breathe", "Breathe"], ["sway", "Bob"]];
const EMOJI = ["🦊", "🦉", "🐢", "🍄", "🌿", "🐝", "🦔", "🐙", "🌻", "🪴", "🐧", "🦜"];
const LOOK = { face: "pattern", letters: "", emoji: "", shuffle: 0, colour: null, shape: null, motion: "none", depth: "flat" };
/* The prototype's jobs: name, what it does, colour, shape. */
export const TEMPLATES = [["Inbox Manager", "Clears your inbox and drafts replies in your voice", "#4F6FA8", 0], ["Expense Manager", "Files receipts and builds monthly reports", "#D8612A", 2], ["Researcher", "Reads the web and writes short briefs with sources", "#2F8C86", 1], ["Chief of Staff", "Plans your week and chases loose ends", "#56616B", 3], ["Bug Reproduction", "Turns a bug report into exact steps", "#B84A6B", 4], ["Trip Planner", "Finds and books refundable travel", "#8A5AA8", 3]];

const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v ?? "")) ? String(v).toLowerCase() : null);
export const lookOf = (t) => ({ ...LOOK, ...(t?.look ?? {}) });
/* What av() draws from: the engine keeps the colour as chosenColour and the emoji inside look. */
export const face = (t) => ({ name: t?.name, color: hex(t?.chosenColour), emoji: lookOf(t).face === "emoji" ? lookOf(t).emoji : "" });
const trunkById = (id) => E.trunks.find((t) => t.id === id);
const trunkOfChat = (sid = S.chat) => E.trunks.find((t) => t.chatSessionId === sid);
let rooms = [];
const roomOfChat = (sid = S.chat) => rooms.find((r) => r.sessionId === sid);
/* The Trunk or room whose own conversation this is, for the list's row menu (shell/shell.js). */
export const chatOwner = (sid) => trunkOfChat(sid) ?? roomOfChat(sid) ?? null;

async function loadRooms() {
  const answer = await api("trunks");
  rooms = Array.isArray(answer?.rooms) ? answer.rooms : [];
}

function openChat(sessionId) {
  const el = document.createElement("button");
  el.dataset.id = sessionId;
  run("chat", el);
}

/* ---------- the editor ---------- */
let ed = null;

function keepFields() {
  const n = $("#st-name"), r = $("#st-role");
  if (n) ed.d.name = n.value;
  if (r) ed.d.title = r.value;
}

function lookTab(d) {
  const swatches = COLOURS.map((c) => `<button class="swatch" type="button" data-css="background:${c}" aria-label="Colour ${c}" aria-pressed="${hex(c) === d.colour}" data-act="st-colour" data-v="${c}"></button>`).join("");
  const shapes = SHAPES.map((sh, i) => `<button class="shape" type="button" aria-label="Shape ${i + 1}" aria-pressed="${SHAPE_NAMES[i] === d.shape}" data-act="st-shape" data-v="${i}"><span data-css="width:26px;height:26px;background:${d.colour ?? "var(--ink-3)"};border-radius:${sh};display:block"></span></button>`).join("");
  const moves = MOTIONS.map(([v, l]) => `<button type="button" data-act="st-anim" data-v="${v}" aria-pressed="${d.motion === v}">${l}</button>`).join("");
  const eyes = ["Round", "Wide", "Sleepy"].map((e) => `<button type="button" data-act="st-eyes" data-v="${e.toLowerCase()}" aria-pressed="false">${e}</button>`).join("");
  return `<div class="split" data-css="grid-template-columns:1fr 1fr"><div class="field"><label for="st-name">Name</label><input class="inp" id="st-name" value="${esc(d.name)}"></div><div class="field"><label for="st-role">What it’s for</label><input class="inp" id="st-role" value="${esc(d.title)}"></div></div>
    <div class="field"><label>Colour</label><div class="swatches">${swatches}</div></div>
    <div class="field"><label>Shape</label><div class="shapes">${shapes}</div></div>
    <div class="split" data-css="grid-template-columns:1fr 1fr"><div class="field"><label for="st-photo">A photo instead of a face</label><input type="file" id="st-photo" accept="image/*" data-sw="st-photo"></div><div class="field"><label>How it moves</label><span class="seg">${moves}</span></div></div>
    <div class="field"><label>Eyes</label><span class="seg">${eyes}</span></div>`;
}

function emojiRow(t) {
  const cur = face(t).emoji;
  return `<div class="emo15"><b>Or an emoji face</b><div class="emo-row15" role="radiogroup" aria-label="Emoji face">${EMOJI.map((e) => `<button type="button" role="radio" aria-checked="${cur === e}" data-act="emo15" data-v="${e}">${e}</button>`).join("")}${cur ? '<button type="button" class="emo-x15" data-act="emo15" data-v="">None</button>' : ""}</div></div>`;
}

const ctl = (id, title, sub) => `<div class="ctl"><b>${esc(title)}</b><input class="sw" type="checkbox" id="${id}" aria-label="${esc(title)}" data-sw="set"><small>${esc(sub)}</small></div>`;
const ctlSeg = (title, sub, opts) => `<div class="ctl"><b>${esc(title)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(title)}">${opts.map((o) => `<button type="button" aria-pressed="false" data-act="seg">${esc(o)}</button>`).join("")}</span></span><small>${esc(sub)}</small></div>`;

/* Drawn as the design has it and greyed: each of these loosens or changes what the Trunk may do. */
function mayTab() {
  return `<div>${ctl("tm-read", "Read files in Documents and Downloads", "Reading never changes a file.")}${ctl("tm-browse", "Use the browser", "With your saved sign-ins.")}${ctlSeg("Send email and messages", "Overrides the mode for this Trunk only.", ["Ask first", "Allowed"])}${ctlSeg("Spend money", "Never, whatever mode Branch is in.", ["Never"])}${ctlSeg("Which model", "Where this Trunk thinks.", ["This computer", "ChatGPT", "Claude"])}${ctl("tm-notes", "Keep its own notes", "Separate from other Trunks’ memory.")}</div>`;
}

function drawEditor() {
  const t = trunkById(ed.id);
  if (!t) { closeDlg(); ed = null; return; }
  const d = ed.d, prev = { name: d.name, color: d.colour, emoji: face(t).emoji };
  const tabs = [["look", "Look"], ["may", "What it may do"]].map(([k, l]) => `<button class="tab" role="tab" type="button" aria-selected="${ed.tab === k}" data-act="st-tab" data-v="${k}">${l}</button>`).join("");
  const body = ed.tab === "look" ? emojiRow(t) + lookTab(d) : mayTab();
  openDlg({ title: `Edit ${t.name}`, wide: true,
    body: `<div class="editor"><div class="big">${av(prev, 84)}<button class="btn sm" type="button" data-act="st-shuffle">Shuffle</button></div><div data-css="display:grid;gap:14px;min-width:0"><div class="tabs" data-css="margin:0" role="tablist">${tabs}</div>${body}</div></div>`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="st-save">Save</button>' });
}

function editTrunk(id) {
  closePop();
  const t = trunkById(id);
  if (!t) return;
  const look = lookOf(t);
  ed = { id, tab: "look", d: { name: t.name, title: t.title ?? "", colour: hex(t.chosenColour), shape: look.shape, motion: look.motion } };
  drawEditor();
}

/* The whole look, with this editor's shape and motion (and any extra change) over what is saved. */
function fullLook(t, change = {}) {
  return { ...lookOf(t), shape: ed?.d.shape ?? lookOf(t).shape, motion: ed?.d.motion ?? lookOf(t).motion, ...(ed?.d.colour ? { colour: null } : {}), ...change };
}

async function saveEditor() {
  keepFields();
  const t = trunkById(ed.id);
  const body = { name: ed.d.name.trim(), title: ed.d.title.trim(), look: fullLook(t), ...(ed.d.colour ? { chosenColour: ed.d.colour } : {}) };
  try {
    await api(`trunks/${encodeURIComponent(ed.id)}`, body);
    closeDlg();
    ed = null;
    await refresh();
    toast(`${body.name} saved.`);
  } catch (error) { toast(error.message); }
}

/* The prototype saves an emoji face at once, not on Save, and nothing else with it: the saved look gets only the new face,
   so an unsaved shape or motion stays a draft. None goes back to the face made from the name. */
async function setEmoji(v) {
  keepFields();
  const t = trunkById(ed.id);
  try {
    await api(`trunks/${encodeURIComponent(ed.id)}`, { look: { ...lookOf(t), ...(v ? { face: "emoji", emoji: v } : { face: "pattern", emoji: "" }) } });
    await refresh();
    drawEditor();
  } catch (error) { toast(error.message); }
}

function shuffle() {
  keepFields();
  ed.d.colour = hex(COLOURS[Math.floor(Math.random() * COLOURS.length)]);
  ed.d.shape = SHAPE_NAMES[Math.floor(Math.random() * SHAPE_NAMES.length)];
  drawEditor();
}

/* ---------- the Trunk's menu: pin, rename, remove ---------- */

/* The conversation menu's items for a Trunk's or a room's own conversation; "" for any other conversation. */
export function trunkMenu() {
  const t = trunkOfChat();
  if (t) return mi("pin", "pin", t.pinned ? "Unpin" : "Pin to top") + mi("pausetrunk", "pause", "Pause this Trunk", "", `data-id="${esc(t.id)}"`) + mi("rename", "edit", "Rename") + mi("edit", "sliders", "Edit Trunk…", "", `data-id="${esc(t.id)}"`) + mi("teach-start", "teach", "Show it how, once");
  const r = roomOfChat();
  if (r) return mi("pin", "pin", r.pinned ? "Unpin" : "Pin to top") + mi("rename", "edit", "Rename room");
  return "";
}
export function trunkMenuEnd() {
  const t = trunkOfChat();
  return t ? "<hr>" + mi("remove", "trash", "Remove Trunk…", "", `data-id="${esc(t.id)}"`) : "";
}

async function change(kind, id, body) {
  try {
    await api(kind === "room" ? `trunks/rooms/${encodeURIComponent(id)}` : `trunks/${encodeURIComponent(id)}`, body);
    await Promise.all([refresh(), loadRooms()]);
    return true;
  } catch (error) { toast(error.message); return false; }
}

export function pinChat(sid = S.chat) {
  closePop();
  const t = trunkOfChat(sid), r = roomOfChat(sid);
  if (t) change("trunk", t.id, { pinned: !t.pinned });
  else if (r) change("room", r.id, { pinned: !r.pinned });
}

export function renameDlg(sid = S.chat) {
  closePop();
  const t = trunkOfChat(sid), r = roomOfChat(sid), target = t ?? r;
  if (!target) return;
  openDlg({ title: t ? "Rename" : "Rename room", body: `<div class="field"><label for="rn-name">Name</label><input class="inp" id="rn-name" value="${esc(target.name)}"></div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="rename-save" data-k="${t ? "trunk" : "room"}" data-id="${esc(target.id)}">Save</button>` });
  setTimeout(() => $("#rn-name")?.select(), 0);
}

async function renameSave(el) {
  const name = ($("#rn-name")?.value ?? "").trim();
  if (!name) { $("#rn-name")?.setAttribute("aria-invalid", "true"); return; }
  if (await change(el.dataset.k, el.dataset.id, { name })) closeDlg();
}

/* The engine keeps no archive: it stops the Trunk's routines and gives its conversations back, so only that is said. */
function removeDlg(id) {
  closePop();
  const t = trunkById(id);
  if (!t) return;
  openDlg({ title: `Remove ${t.name}?`, body: '<p data-css="margin:0">Its automations stop.</p>',
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">Keep ${esc(t.name)}</button><button class="btn bad" type="button" data-act="trunk-remove-yes" data-id="${esc(t.id)}">Remove</button>` });
}

async function removeTrunk(id) {
  try {
    await api(`trunks/${encodeURIComponent(id)}/remove`, {});
    closeDlg();
    await refresh();
    toast("Removed.");
  } catch (error) { toast(error.message); }
}

/* ---------- a Trunk from a job: create takes name, title and description; the look follows as an edit ---------- */
async function fromTemplate(i) {
  const [name, what, colour, shape] = TEMPLATES[i] ?? [];
  if (!name) return;
  try {
    const { trunk } = await api("trunks", { name, title: what, description: what });
    await api(`trunks/${encodeURIComponent(trunk.id)}`, { chosenColour: hex(colour), look: { ...LOOK, shape: SHAPE_NAMES[shape] } });
    await refresh();
    openChat(trunk.chatSessionId);
    toast(`${name} is ready.`);
  } catch (error) { toast(error.message); }
}

/* ---------- a new room: a name and two to six Trunks. People and agents on other computers stay greyed (sharing). ---------- */
let grp = null;

function groupDlg() {
  const people = (E.profiles?.profiles ?? []).filter((p) => p.id !== E.profiles?.active), agents = grp.agents;
  const chip = (act, id, label, on) => `<button type="button" class="chip6" data-act="${act}" data-k="trunks" data-v="${esc(id)}" aria-pressed="${on}">${esc(label)}</button>`;
  openDlg({ title: "New group chat", wide: true, body: `<label class="fld"><span>Name</span><input class="inp" id="grp-name" value="${esc(grp.name)}"></label>
    <div class="fld"><span>Trunks · two to six</span><span class="chips8">${E.trunks.map((t) => chip("grp-pick", t.id, t.name, grp.trunks.includes(t.id))).join("")}</span></div>
    <div class="fld"><span>People · up to eight</span><span class="chips8">${people.map((p) => chip("grp-person", p.id, p.name, false)).join("")}</span></div>
    <div class="fld"><span>Agents on other computers</span><span class="chips8">${agents.map((a) => chip("grp-agent", a.name ?? a.id, a.name ?? a.id, false)).join("")}</span></div>
    <div class="ctl"><b>Who answers</b><span class="right"><span class="seg" role="group" aria-label="Who answers">${["Only those you @mention", "A lead Trunk decides", "Everyone, every time"].map((l) => `<button type="button" data-act="grp-rule" aria-pressed="false">${l}</button>`).join("")}</span></span><small>Nobody mentioned means everyone.</small></div>
    ${ctl("grp-talk", "Trunks may talk to each other in here", "Up to 3 rounds and 10 Trunk messages for each of yours. A Trunk can pass.")}`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="grp-make">Start the group chat</button>' });
}

/* The agents on other computers are read once, when the dialog opens; they are drawn greyed. */
async function newGroup() {
  closePop();
  let agents = [];
  try { agents = (await api("agents/remote")).agents ?? []; } catch (error) { toast(error.message); }
  grp = { name: "", trunks: [], agents };
  groupDlg();
}

function pickMember(el) {
  grp.name = $("#grp-name")?.value ?? grp.name;
  const v = el.dataset.v;
  grp.trunks = grp.trunks.includes(v) ? grp.trunks.filter((x) => x !== v) : [...grp.trunks, v];
  groupDlg();
}

async function makeRoom() {
  const name = ($("#grp-name")?.value ?? "").trim();
  try {
    const { room } = await api("trunks/rooms", { name, members: grp.trunks });
    grp = null;
    closeDlg();
    await Promise.all([refresh(), loadRooms()]);
    if (room?.sessionId) openChat(room.sessionId);
  } catch (error) { toast(error.message); }
}

export function init() {
  markLive(["edit", "st-tab", "st-colour", "st-shape", "st-anim", "st-shuffle", "st-save", "emo15", "pin", "rename", "rename-save", "remove", "trunk-remove-yes", "tmpl", "grp-new", "grp-pick", "grp-make"]);
  on("edit", (el) => editTrunk(el.dataset.id));
  on("st-tab", (el) => { keepFields(); ed.tab = el.dataset.v; drawEditor(); });
  on("st-colour", (el) => { keepFields(); ed.d.colour = hex(el.dataset.v); drawEditor(); });
  on("st-shape", (el) => { keepFields(); ed.d.shape = SHAPE_NAMES[+el.dataset.v] ?? null; drawEditor(); });
  on("st-anim", (el) => { keepFields(); ed.d.motion = el.dataset.v; drawEditor(); });
  on("st-shuffle", () => shuffle());
  on("st-save", () => saveEditor());
  on("emo15", (el) => setEmoji(el.dataset.v));
  on("pin", () => pinChat());
  on("rename", () => renameDlg());
  on("rename-save", (el) => renameSave(el));
  on("remove", (el) => removeDlg(el.dataset.id));
  on("trunk-remove-yes", (el) => removeTrunk(el.dataset.id));
  on("tmpl", (el) => fromTemplate(+el.dataset.i));
  on("grp-new", () => newGroup());
  on("grp-pick", (el) => pickMember(el));
  on("grp-make", () => makeRoom());
  onRender(firstRooms);
}

/* The rooms are read once the window is signed in (E.loaded), then again after each change made here. */
let roomsAsked = false;
function firstRooms() {
  if (roomsAsked || !E.loaded) return;
  roomsAsked = true;
  loadRooms().catch((error) => toast(error.message));
}
