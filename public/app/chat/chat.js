/* The conversation (design doc 4.1–4.4): the header (merged into the title bar on wide windows), the thread, the
   composer, sending through POST /api/run, and the approval card for a task waiting on a yes (GET /api/policy). */

import { $, esc, renderNow, render } from "../core/dom.js";
import { S, E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, av, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { text } from "./markdown.js";

const C = { sessionId: null, messages: [], waiting: [], sending: false, thinking: "" };
const WIDE = matchMedia("(min-width: 761px)");

const current = () => E.sessions.find((s) => (s.sessionId ?? s.id) === C.sessionId);
const title = () => current()?.opening || C.messages.find((m) => m.role === "user")?.content?.slice(0, 70) || "New conversation";

export function head() {
  const working = C.sending;
  return `<div class="head"><button class="icon-btn menu-only" type="button" aria-label="Show conversations" data-act="side">${ic("menu")}</button>
    ${av({ kind: "main" }, 32)}<div class="who"><b>${esc(title())}</b><small class="${working ? "attn" : ""}">${working ? "<i></i>Working" : ""}</small></div>
    <span class="tb-grow"></span>
    <button class="icon-btn" type="button" aria-label="Side panel: Activity, Plan, Files, Memory, Browser, Terminal (Ctrl+Shift+K)" data-act="pane" data-p="activity">${ic("sidebar")}</button>
    <button class="icon-btn" type="button" aria-label="Find in this conversation (Ctrl+F)" data-tip="Find in this conversation" data-act="find-open">${ic("search")}</button>
    <button class="icon-btn" type="button" aria-label="More for this conversation" data-act="chatmenu">${ic("more")}</button></div>`;
}

function user(m) { return `<div class="u">${esc(m.content)}</div>`; }
function bot(m, first) {
  return `<div class="b"><div class="gut">${first ? av({ kind: "main" }, 28) : ""}</div><div><div class="txt">${text(m.content)}</div></div></div>`;
}

/* The approval card, 1:1 with the prototype's: the action's verb (allow once), "Always allow for …" (a standing rule,
   greyed out until the engine can scope a rule to one Trunk), and "Don't …" (deny). The fingerprint is always sent. */
function askCard(q) {
  const verb = q.label || "Allow";
  const trunk = q.trunk ? E.trunks.find((t) => t.id === q.trunk) : null;
  const always = trunk ? `Always allow for ${esc(trunk.name)}` : "Always allow";
  return `<div class="b"><div class="gut"></div><div><div class="card ask" id="live-ask"><div class="card-h"><span class="q">${esc(q.question || q.label)}</span><span class="pill work ml"><i></i>Needs you</span></div>
    ${q.bytes ? `<dl class="kv"><dd class="mailbody">${esc(q.bytes)}</dd></dl>` : ""}
    <div class="acts"><button class="btn pri" type="button" data-act="ask" data-v="allow" data-fp="${esc(q.fingerprint || "")}">${esc(verb)}</button><button class="btn" type="button" data-act="ask-always" data-fp="${esc(q.fingerprint || "")}" data-trunk="${esc(q.trunk || "")}">${always}</button><button class="btn ghost" type="button" data-act="ask" data-v="deny" data-fp="${esc(q.fingerprint || "")}">Don’t allow</button></div></div></div></div>`;
}

function thread() {
  let lastRole = null;
  const rows = C.messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.from !== "branch").map((m) => {
    const html = m.role === "user" ? user(m) : bot(m, lastRole !== "assistant");
    lastRole = m.role;
    return html;
  });
  const asks = C.waiting.filter((q) => q.sessionId === C.sessionId).map(askCard);
  const think = C.sending && C.thinking ? `<div class="think">${ic("spark", "s")}<span>${esc(C.thinking)}</span></div>` : "";
  const typing = C.sending ? `<div class="b"><div class="gut">${av({ kind: "main" }, 28)}</div><div>${think || '<span class="typing" aria-label="Typing"><i></i><i></i><i></i></span>'}</div></div>` : "";
  return rows.join("") + asks.join("") + typing;
}

function composer() {
  const draft = S.drafts[C.sessionId ?? "new"] ?? "";
  return `<div class="dock"><form class="composer" id="composer" data-form="composer">
    <button class="c-btn" type="button" aria-label="Attach, mention a Trunk, skills, Temporary" aria-haspopup="menu" data-act="plusmenu">${ic("plus")}</button><button class="c-btn plug9" type="button" aria-label="Tools: connectors, skills, plugins and command-line tools" data-tip="Tools" aria-haspopup="dialog" data-act="tools9">${ic("puzzle")}</button>
    <textarea id="prompt" rows="1" placeholder="Message Branch" aria-label="Message Branch">${esc(draft)}</textarea>
    <button type="button" class="chip-c" data-act="modelmenu2" data-tip="Model and how long it thinks"><span class="lbl">${esc([E.state?.activeModel?.presetName, E.state?.activeModel?.reasoning].filter(Boolean).join(" · "))}</span>${ic("chev", "s")}</button><button type="button" class="chip-c" data-act="modemenu2" data-tip="How much it may do in this conversation (Shift+Tab)">${ic("shield", "s")}<span class="lbl">Ask first</span>${ic("chev", "s")}</button>
    <button class="c-btn" type="button" aria-label="Dictate into the box" data-act="dict">${ic("mic")}</button><button class="c-btn" type="button" aria-label="Talk live with voice" data-act="voice">${ic("wave")}</button>
    <button class="c-btn send" id="send" type="submit" aria-label="Send" ${C.sending ? "disabled" : ""}>${ic("up")}</button></form></div>`;
}

export function draw() {
  const narrowHead = WIDE.matches ? "" : head();
  return `${narrowHead}<div class="scroll" id="scroll"><div class="thread" id="conversation">${thread()}</div></div>${composer()}`;
}
export function after(main) {
  const box = $("#scroll", main);
  if (box) box.scrollTop = box.scrollHeight;
}

export async function openConversation(id) {
  S.view = "chat";
  C.sessionId = id;
  S.chat = id;
  C.messages = [];
  renderNow();
  try { C.messages = (await api("sessions/" + id)).messages ?? []; } catch (error) { toast(error.message); }
  await loadWaiting();
  renderNow();
}
export function startConversation() {
  S.view = "chat";
  C.sessionId = null;
  S.chat = null;
  C.messages = [];
  renderNow();
  $("#prompt")?.focus();
}

/* While a task runs, what its model is thinking now (GET /api/activity; held in memory by the engine, never recorded). */
let thinkTimer = null;
function watchThinking(on) {
  clearInterval(thinkTimer);
  C.thinking = "";
  if (!on) return;
  thinkTimer = setInterval(async () => {
    const live = await api("activity").catch(() => []);
    const mine = (Array.isArray(live) ? live : []).find((a) => a.sessionId === C.sessionId) ?? (C.sessionId ? null : live[0]);
    if ((mine?.thinking ?? "") !== C.thinking) { C.thinking = mine?.thinking ?? ""; render(); }
  }, 1000);
}

async function loadWaiting() {
  try { C.waiting = (await api("policy")).waiting ?? []; } catch { C.waiting = []; }
}

async function send() {
  const box = $("#prompt");
  const prompt = (box?.value ?? "").trim();
  if (!prompt || C.sending) return;
  C.messages.push({ role: "user", content: prompt });
  S.drafts[C.sessionId ?? "new"] = "";
  C.sending = true;
  watchThinking(true);
  renderNow();
  try {
    const run = await api("run", { prompt, ...(C.sessionId ? { sessionId: C.sessionId } : {}) });
    C.sessionId = run.sessionId;
    S.chat = run.sessionId;
    C.messages = (await api("sessions/" + run.sessionId)).messages ?? C.messages;
    await loadWaiting();
  } catch (error) {
    C.messages.push({ role: "assistant", content: error.message });
  } finally {
    C.sending = false;
    watchThinking(false);
    await refresh().catch(() => {});
    renderNow();
    $("#prompt")?.focus();
  }
}

async function answer(el, decision, extra = {}) {
  const q = C.waiting.find((w) => (w.fingerprint || "") === el.dataset.fp) ?? C.waiting[0];
  if (!q) return;
  let said = null;
  try {
    said = await api("policy/approve", { sessionId: q.sessionId, decision, remember: "never", ...extra, ...(q.fingerprint ? { fingerprint: q.fingerprint } : {}), carryOn: true });
  } catch (error) { toast(error.message); }
  C.waiting = C.waiting.filter((w) => w !== q);
  if (said?.task === "carrying-on") await follow(q.sessionId);
  else await openConversation(q.sessionId);
}

const busy = (id) => (E.state?.runs ?? []).some((r) => r.sessionId === id && ["running", "queued", "waiting"].includes(r.status));
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/* A task carried on after a yes: show it working, re-read the conversation each second until it has finished. */
async function follow(id) {
  C.sessionId = id;
  C.sending = true;
  watchThinking(true);
  renderNow();
  for (let waited = 0; waited < 600; waited++) {
    await pause(1000);
    await refresh().catch(() => {});
    try { C.messages = (await api("sessions/" + id)).messages ?? C.messages; } catch { /* the next second tries again */ }
    await loadWaiting();
    renderNow();
    if (!busy(id)) break;
  }
  C.sending = false;
  watchThinking(false);
  renderNow();
}

export function init() {
  markLive(["ask", "send", "side"]);
  on("ask", (el) => answer(el, el.dataset.v === "deny" ? "deny" : "allow"));
  /* Live once the engine scopes a standing yes to one Trunk (PR #285); until then features.js keeps it greyed. */
  on("ask-always", (el) => { if (el.dataset.trunk) answer(el, "allow", { remember: "always", trunk: el.dataset.trunk }); });
  on("side", () => document.getElementById("app").classList.toggle("side-open"));
  document.addEventListener("submit", (e) => { if (e.target.id === "composer") { e.preventDefault(); send(); } });
  document.addEventListener("keydown", (e) => { if (e.target.id === "prompt" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  document.addEventListener("input", (e) => { if (e.target.id === "prompt") S.drafts[C.sessionId ?? "new"] = e.target.value; });
  setInterval(() => { if (S.view === "chat" && C.sessionId && !C.sending) loadWaiting().then(render); }, 4000);
}
