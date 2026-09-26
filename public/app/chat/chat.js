/* The conversation (design doc 4.1–4.4): the header (merged into the title bar on wide windows), the thread, the
   composer, sending through POST /api/run, and the approval card for a task waiting on a yes (GET /api/policy). */

import { $, esc, renderNow, render, onRender } from "../core/dom.js";
import { S, E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, av, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { text } from "./markdown.js";
import { chips, loadChips, initChips, startMode } from "./chips.js";
import { drawPane, initPane } from "./pane.js";
import { attached, takePending, initPlus, loadWho, whoHere, forgetWho } from "./plus.js";
import { recBar, initRec } from "./rec.js";
import { binding } from "../shell/keys.js";
import { checkpointRows, initCheckpoints } from "./checkpoints.js";
import { selfCard, loadSelfChange, initSelfChange } from "./selfchange.js";
import { teachBar, teachAdopt, initTeach } from "./teach.js";
import { findBar, applyFind, initFind } from "./find.js";
import { initToolsHub } from "./toolshub.js";
import { initDictate, loadDictation, dictating, micButton, dictRow } from "./dictate.js";
import { dockRow, initBg } from "./bg.js";
import { mediaRows, initMedia } from "./media.js";
import { besideWrap, rosterButton, initBeside } from "./beside.js";
import { msgActs, pinnedClass, pinsBar, queueRow, loadExtras, initMessages } from "./messages.js";
import { rememberCards, initRemember } from "./remember.js";
import { goalStrip, loadGoal, initGoal } from "./goal.js";
import { goHome } from "./goto.js";
import { routeFor, authorOf, countsAsReply, replyWords, readRoom, roomView, roomAsks, answerRoom } from "./rooms.js";
import { planBlock, loadPlan, failedLine } from "./runview.js";

const C = { sessionId: null, messages: [], waiting: [], sending: false, thinking: "" };
const WIDE = matchMedia("(min-width: 761px)");

const current = () => E.sessions.find((s) => (s.sessionId ?? s.id) === C.sessionId);
const title = () => current()?.opening || C.messages.find((m) => m.role === "user")?.content?.slice(0, 70) || "New conversation";

export function head() {
  const working = C.sending, paused = E.trunks.find((t) => t.chatSessionId === C.sessionId)?.paused;
  return `<div class="head"><button class="icon-btn menu-only" type="button" aria-label="Show conversations" data-act="side">${ic("menu")}</button>
    ${av({ kind: "main" }, 32)}<div class="who"><b>${esc(title())}</b><small class="${working ? "attn" : ""}">${working ? "<i></i>Working" : paused ? "Paused · won’t start anything new" : ""}</small></div>
    <span class="tb-grow"></span>
    <button class="icon-btn" type="button" aria-label="Side panel: Activity, Plan, Files, Memory, Browser, Terminal${binding("sidePane") ? ` (${esc(binding("sidePane"))})` : ""}" aria-pressed="${!!S.pane && S.pane !== "browser"}" data-act="pane" data-p="activity">${ic("sidebar")}</button>
    ${rosterButton()}<button class="icon-btn" type="button" aria-label="Find in this conversation (Ctrl+F)" data-tip="Find in this conversation" data-act="find-open">${ic("search")}</button>
    <button class="icon-btn" type="button" aria-label="More for this conversation" data-act="chatmenu">${ic("more")}</button></div>`;
}

const mid = (m) => (m.messageId ? ` data-i15="${esc(m.messageId)}"` : "");
function user(m) { return `<div class="u${pinnedClass(m)}"${mid(m)}>${esc(m.content)}${msgActs(m)}</div>${mediaRows(m)}`; }
/* A reply is signed as the prototype's are: the face of whoever wrote it when the speaker changes (a Trunk's, or Branch's),
   and in a room the Trunk's name above it. */
function bot(m, first, who, info) {
  const from = first && who && info?.kind === "room" ? `<div class="from">${esc(who.name)}</div>` : "";
  return `<div class="b${pinnedClass(m)}"${mid(m)}><div class="gut">${first ? av(who ?? { kind: "main" }, 28) : ""}</div><div>${from}<div class="txt">${text(replyWords(m, info))}</div></div>${msgActs(m)}</div>`;
}

/* The approval card, 1:1 with the prototype's: the action's verb (allow once), "Always allow for …" (a standing rule,
   greyed out until the engine can scope a rule to one Trunk), and "Don't …" (deny). The verb comes from the tool alone,
   never from the label, which can carry a reviewer's or hook's words; the label is the card's body. Each button names
   its request by session and fingerprint, and only that exact request is answered. */
const VERBS = { files: "Change it", shell: "Run it", code: "Run it", device: "Allow", browser: "Go ahead", channels: "Send it", memory: "Save it" };
const verbOf = (tool) => (tool === "files.read" ? "Read it" : VERBS[String(tool ?? "").split(".")[0]] ?? "Allow");
/* The requests being answered now, by session and fingerprint: from the first press until the engine answers, the card's
   buttons stay disabled (also when the card is drawn again meanwhile) and a second press sends nothing. */
const answering = new Set();
const askKey = (sid, fp) => `${sid}\n${fp || ""}`;
function askCard(q) {
  const verb = verbOf(q.tool);
  const off = answering.has(askKey(q.sessionId, q.fingerprint)) ? " disabled" : "";
  const id = `data-sid="${esc(q.sessionId)}" data-fp="${esc(q.fingerprint || "")}"${off}`;
  const trunk = q.trunk ? E.trunks.find((t) => t.id === q.trunk) : null;
  const always = trunk ? `Always allow for ${esc(trunk.name)}` : "Always allow";
  return `<div class="b"><div class="gut"></div><div><div class="card ask" id="live-ask"><div class="card-h"><span class="q">${esc(q.question || q.label)}</span><span class="pill work ml"><i></i>Needs you</span></div>
    ${(q.question && q.label) || q.bytes ? `<dl class="kv">${q.question && q.label ? `<dd class="mailbody">${esc(q.label)}</dd>` : ""}${q.bytes ? `<dd class="mailbody">${esc(q.bytes)}</dd>` : ""}</dl>` : ""}
    <div class="acts"><button class="btn pri" type="button" data-act="ask" data-v="allow" ${id}>${esc(verb)}</button><button class="btn" type="button" data-act="ask-always" ${id} data-trunk="${esc(q.trunk || "")}">${always}</button><button class="btn ghost" type="button" data-act="ask" data-v="deny" ${id}>Don’t allow</button></div></div></div></div>`;
}

function thread() {
  const info = whoHere();
  /* Each reply's place among the replies, counted as the engine counts them for `authors`. */
  const index = new Map();
  let replies = 0;
  for (const m of C.messages) { index.set(m, replies); if (countsAsReply(m)) replies++; }
  let lastRole = null, lastWho = null;
  const rows = C.messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.from !== "branch").map((m) => {
    const who = m.role === "assistant" ? authorOf(m, index.get(m), info) : null;
    const first = lastRole !== "assistant" || (who?.id ?? null) !== (lastWho?.id ?? null);
    const html = m.role === "user" ? user(m) : bot(m, first, who, info) + checkpointRows(m, C.messages) + selfCard(m, C.messages);
    lastRole = m.role;
    lastWho = who;
    return html;
  });
  const asks = C.waiting.filter((q) => q.sessionId === C.sessionId).map(askCard).concat(roomAsks(info, (q) => answering.has(roomKey(info.room.id, q.memberId, q.fingerprint))));
  const think = C.sending && C.thinking ? `<div class="think">${ic("spark", "s")}<span>${esc(C.thinking)}</span></div>` : "";
  const typing = C.sending ? `<div class="b"><div class="gut">${av({ kind: "main" }, 28)}</div><div>${think || '<span class="typing" aria-label="Typing"><i></i><i></i><i></i></span>'}</div></div>` : "";
  return rows.join("") + planBlock(liveRun()) + failedLine(E.state?.runs, C.sessionId, C.sending) + rememberCards(C.sessionId) + asks.join("") + typing;
}

function composer() {
  const draft = S.drafts[C.sessionId ?? "new"] ?? "";
  return `<div class="dock"><div id="attached">${attached()}</div>${queueRow()}${dockRow()}<form class="composer" id="composer" data-form="composer">
    <button class="c-btn" type="button" aria-label="Attach, mention a Trunk, skills, Temporary" aria-haspopup="menu" data-act="plusmenu">${ic("plus")}</button><button class="c-btn plug9" type="button" aria-label="Tools: connectors, skills, plugins and command-line tools" data-tip="Tools" aria-haspopup="dialog" data-act="tools9">${ic("puzzle")}</button>
    ${dictating() ? dictRow() : `<textarea id="prompt" rows="1" placeholder="Message Branch" aria-label="Message Branch">${esc(draft)}</textarea>`}
    ${chips()}
    ${dictating() ? "" : `${micButton()}<button class="c-btn" type="button" aria-label="Talk live with voice" data-act="voice">${ic("wave")}</button>`}
    ${!draft.trim() && (C.sending || liveRun()) ? `<button class="c-btn send stop" id="send" type="button" aria-label="Stop" data-act="stop-run">${ic("stop")}</button>`
      : `<button class="c-btn send${draft.trim() ? " ready" : ""}" id="send" type="submit" aria-label="Send">${ic("up")}</button>`}</form></div>`;
}

/* The words of the message being sent, so the side panel can follow a new conversation's first task before its id is known. */
export const sendingPrompt = () => (C.sending && !C.sessionId ? C.prompt : null);

export function draw() {
  const narrowHead = WIDE.matches ? "" : head();
  return `${narrowHead}${recBar()}${teachBar(C.sessionId)}${findBar()}${pinsBar()}${besideWrap(`<div class="scroll" id="scroll">${goalStrip(C.sessionId)}<div class="thread" id="conversation">${thread()}</div></div>`)}${composer()}`;
}
export function after(main) {
  /* Newest at the bottom stays in view only while the reader is at the bottom; someone reading back keeps their place. */
  const box = $("#scroll", main);
  if (box) {
    const same = C.readSid === C.sessionId;
    box.scrollTop = !same || C.atBottom !== false ? box.scrollHeight : C.readTop ?? box.scrollHeight;
    C.readSid = C.sessionId;
    box.addEventListener("scroll", () => { C.readTop = box.scrollTop; C.atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40; }, { passive: true });
  }
  applyFind();
  loadDictation();
  loadChips();
  loadGoal(C.sessionId);
  loadWho();
  loadSelfChange(C.sessionId, C.messages);
  loadPlan(liveRun());
  const info = whoHere();
  if (info?.kind === "room" && !roomView(info)) readRoom(info).then((view) => { if (view) render(); });
}

/* Opening a conversation closes the phone's list over it, as the prototype's openChat does. */
export async function openConversation(id) {
  S.view = "chat";
  $("#app")?.classList.remove("side-open");
  C.sessionId = id;
  S.chat = id;
  C.messages = [];
  renderNow();
  try { C.messages = (await api("sessions/" + id)).messages ?? []; } catch (error) { toast(error.message); }
  await loadWaiting();
  await loadExtras(id);
  renderNow();
}
export function startConversation() {
  S.view = "chat";
  $("#app")?.classList.remove("side-open");
  C.sessionId = null;
  S.chat = null;
  C.messages = [];
  loadExtras(null);
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
    // Before a new conversation has its id, only the task this message started counts, found by its own words.
    const mine = (Array.isArray(live) ? live : []).find((a) => (C.sessionId ? a.sessionId === C.sessionId : a.prompt === C.prompt));
    if ((mine?.thinking ?? "") !== C.thinking) { C.thinking = mine?.thinking ?? ""; render(); }
  }, 1000);
}

async function loadWaiting() {
  try { C.waiting = (await api("policy")).waiting ?? []; } catch { C.waiting = []; }
}

/* A line starting with / is offered to the engine's commands first (POST /api/commands/run). One it runs shows its answer
   here and nothing goes to the model; a line it doesn't know is sent as a message. */
async function command(line) {
  let done;
  try { done = await api("commands/run", { surface: "window", line, ...(C.sessionId ? { sessionId: C.sessionId } : {}) }); } catch (error) { toast(error.message); return true; }
  if (!done?.handled) return false;
  C.messages.push({ role: "assistant", content: done.text ?? "" });
  S.drafts[C.sessionId ?? "new"] = "";
  const box = $("#prompt");
  if (box) box.value = "";
  renderNow();
  $("#prompt")?.focus();
  await carryOut(done.client);
  return true;
}

/* What the engine's answer asks the window to do (src/commands/handlers.ts ClientAction): open a place, open or start a
   conversation, put words in the box or send them, read the model again. */
async function carryOut(client) {
  if (!client?.do) return;
  if (client.do === "go") { if (goHome(client.home)) renderNow(); }
  else if (client.do === "open-session" && client.id) await openConversation(client.id);
  else if (client.do === "new") startConversation();
  else if (client.do === "fill" && typeof client.text === "string") {
    S.drafts[C.sessionId ?? "new"] = client.text;
    const box = $("#prompt");
    if (box) { box.value = client.text; box.focus(); }
  } else if (client.do === "send" && typeof client.text === "string") await send(client.text);
  else if (client.do === "refresh-model") { await refresh().catch((error) => toast(error.message)); renderNow(); }
}

/* Sends what is in the box, or `words` when given (an earlier message edited and sent again). While a task works, the
   message joins the conversation's waiting line instead; a message for a room or naming a Trunk goes where the engine
   expects it (rooms.js). */
async function send(words) {
  const box = $("#prompt");
  const prompt = (words ?? box?.value ?? "").trim();
  if (!prompt) return;
  if (C.sending || ["running", "queued"].includes(liveRun()?.status)) { await queueNext(prompt, words === undefined); return; }
  if (prompt.startsWith("/") && (await command(prompt))) return;
  const route = routeFor(prompt, C.sessionId, whoHere(), HOOKS);
  if (route) {
    clearBox(words === undefined);
    try { await route(); } catch (error) {
      toast(error.message);
      S.drafts[C.sessionId ?? "new"] = prompt;
      renderNow();
    }
    return;
  }
  await sendPlain(prompt);
}

function clearBox(fromBox) {
  S.drafts[C.sessionId ?? "new"] = "";
  const box = $("#prompt");
  if (fromBox && box) box.value = "";
}

/* A message written while a task works goes through the engine's busy send (POST /api/flows-boards/busy/send), which
   does what the owner chose for typing while it works: wait in the line ("Waiting line · sent after this step"), steer the
   task, or stop it and go next. The engine's words say which; a refusal keeps the words in the box. The conversation
   keeps following until the line has moved on. */
async function queueNext(prompt, fromBox) {
  let sid = C.sessionId ?? liveRun()?.sessionId;
  /* A new conversation's first task may not be in the window's picture yet: read it once more before giving up. */
  if (!sid) { await refresh().catch(() => {}); sid = liveRun()?.sessionId; }
  if (!sid) return;
  let said;
  try { said = await api("flows-boards/busy/send", { sessionId: sid, prompt }); } catch (error) { toast(error.message); return; }
  if (said?.message) toast(said.message);
  clearBox(fromBox);
  C.queued = true;
  await loadExtras(sid);
  renderNow();
  if (!C.sending) await follow(sid);
}

/* The hooks rooms.js uses: open a conversation, send as usual, read who answers again, follow a room's answers. */
const HOOKS = {
  open: (id) => openConversation(id),
  sendPlain: (text) => sendPlain(text),
  after: async () => { forgetWho(); await loadWho(); },
  followRoom: (info) => followRoom(info),
};

async function sendPlain(prompt) {
  C.messages.push({ role: "user", content: prompt });
  C.atBottom = true;
  C.prompt = prompt;
  S.drafts[C.sessionId ?? "new"] = "";
  C.sending = true;
  watchThinking(true);
  renderNow();
  try {
    const run = await api("run", { prompt, ...(C.sessionId ? { sessionId: C.sessionId } : {}), ...takePending(!C.sessionId), ...(C.sessionId ? {} : startMode()) });
    C.sessionId = run.sessionId;
    S.chat = run.sessionId;
    teachAdopt(run.sessionId);
    C.messages = (await api("sessions/" + run.sessionId)).messages ?? C.messages;
    await loadWaiting();
  } catch (error) {
    C.messages.push({ role: "assistant", content: error.message });
  } finally {
    C.sending = false;
    watchThinking(false);
    await refresh().catch(() => {});
    await loadExtras(C.sessionId);
    renderNow();
    $("#prompt")?.focus();
  }
  if (C.queued && C.sessionId) { C.queued = false; await follow(C.sessionId); }
}

/* A room answers in the background (each member in its own conversation): its conversation is read again each second
   while the room is speaking (GET /api/trunks/rooms/<id> speaking), then once more. */
async function followRoom(info) {
  C.sending = true;
  renderNow();
  for (let waited = 0; waited < 600; waited++) {
    const view = await readRoom(info);
    try { C.messages = (await api("sessions/" + encodeURIComponent(info.sessionId))).messages ?? C.messages; } catch { /* the next second tries again */ }
    renderNow();
    if (!view?.speaking) break;
    await pause(1000);
  }
  C.sending = false;
  renderNow();
}

/* A room member's question, answered once (the same guard as the conversation's own card). */
const roomKey = (room, member, fp) => `${room}\n${member}\n${fp || ""}`;
async function answerInRoom(el, decision) {
  const key = roomKey(el.dataset.room, el.dataset.member, el.dataset.fp);
  if (answering.has(key)) return;
  holdButtons(el, key, true);
  try { await answerRoom(el, decision); } catch (error) { toast(error.message); holdButtons(el, key, false); renderNow(); return; }
  answering.delete(key);
  const info = whoHere();
  if (info?.kind === "room") await followRoom(info);
}

/* One answer per request: every button of the card (or Inbox row) is disabled from the first press until the engine
   answers, and given back if the answer fails, so a double tap never sends a second, different answer. */
function holdButtons(el, key, on) {
  if (on) answering.add(key); else answering.delete(key);
  const box = el.closest(".card, .prow") ?? el;
  for (const b of box.querySelectorAll("button")) b.disabled = on;
  if (!box.querySelector("button")) el.disabled = on;
}
async function answer(el, decision, extra = {}) {
  if (!el.dataset.sid) return;
  const key = askKey(el.dataset.sid, el.dataset.fp);
  if (answering.has(key)) return;
  holdButtons(el, key, true);
  let said = null, q = null;
  try {
    await loadWaiting();
    q = C.waiting.find((w) => w.sessionId === el.dataset.sid && (w.fingerprint || "") === el.dataset.fp);
    if (!q) { holdButtons(el, key, false); renderNow(); return; }
    said = await api("policy/approve", { sessionId: q.sessionId, decision, remember: "never", ...extra, ...(q.fingerprint ? { fingerprint: q.fingerprint } : {}), carryOn: true });
  } catch (error) {
    toast(error.message);
    holdButtons(el, key, false);
    renderNow();
    return;
  }
  answering.delete(key);
  C.waiting = C.waiting.filter((w) => w !== q);
  if (said?.task === "carrying-on") await follow(q.sessionId);
  else await openConversation(q.sessionId);
}

/* The task this conversation is running now; before a new conversation has its id, the one its first message started. */
const LIVE = ["running", "queued", "waiting", "needs_input"];
const liveRun = () => (E.state?.runs ?? []).filter((r) => LIVE.includes(r.status) && (C.sessionId ? r.sessionId === C.sessionId : C.sending && r.prompt === C.prompt))
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];

/* Stop (the prototype puts it in Send's place while the conversation works): POST /api/runs/<id>/cancel. */
async function stopRun() {
  let run = liveRun();
  if (!run) { await refresh().catch((error) => toast(error.message)); run = liveRun(); }
  if (!run) return;
  try { await api(`runs/${encodeURIComponent(run.id)}/cancel`, {}); } catch (error) { toast(error.message); }
  await refresh().catch((error) => toast(error.message));
  renderNow();
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
  initChips();
  initPane();
  initPlus();
  initFind();
  initToolsHub();
  initDictate();
  initBg();
  initMedia();
  initBeside();
  initMessages({ state: () => C, sendText: (words) => send(words), reopen: openConversation });
  initRemember();
  initGoal();
  initRec();
  initCheckpoints();
  initSelfChange();
  initTeach({ start: startConversation });
  onRender(drawPane);
  markLive(["ask", "room-ask", "send", "side", "stop-run", "sw:prompt"]);
  on("stop-run", () => stopRun());
  on("ask", (el) => answer(el, el.dataset.v === "deny" ? "deny" : "allow"));
  on("room-ask", (el) => answerInRoom(el, el.dataset.v === "deny" ? "deny" : "allow"));
  /* Live once the engine scopes a standing yes to one Trunk (PR #285); until then features.js keeps it greyed. */
  on("ask-always", (el) => { if (el.dataset.trunk) answer(el, "allow", { remember: "always", trunk: el.dataset.trunk }); });
  on("side", () => document.getElementById("app").classList.toggle("side-open"));
  document.addEventListener("submit", (e) => { if (e.target.id === "composer") { e.preventDefault(); send(); } });
  document.addEventListener("keydown", (e) => { if (e.target.id === "prompt" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  document.addEventListener("input", (e) => {
    if (e.target.id !== "prompt") return;
    S.drafts[C.sessionId ?? "new"] = e.target.value;
    // Stop holds Send's place only while the box is empty: typing gives Send back, clearing the box brings Stop again.
    const stopNow = !e.target.value.trim() && (C.sending || !!liveRun());
    if (stopNow !== ($("#send")?.dataset.act === "stop-run")) renderNow();
    $("#send")?.classList.toggle("ready", !!e.target.value.trim()); // pass 17: Send turns copper once there is something to send
  });
  setInterval(async () => {
    if (S.view !== "chat" || !C.sessionId || C.sending) return;
    const before = JSON.stringify(C.waiting);
    await loadWaiting();
    if (JSON.stringify(C.waiting) !== before) render();
  }, 4000);
}
