/* The side panel beside a conversation (design doc 4.6), 1:1 with the prototype's: Activity (each tool the task used, from
   the conversation's own messages), Plan (GET /api/runs/<id>/plan), Files (what each task changed, from its run) and
   Memory, and Terminal (each command the tasks ran, from GET /api/panels/work: terminal.js). Browser opens the full-size
   view of the browser (stage.js), as the prototype's panel hands 'browser' to the stage. */

import { $, esc, applyCss } from "../core/dom.js";
import { ic } from "../core/ui.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { sendingPrompt } from "./chat.js";
import { initStage } from "./stage.js";
import { terminalBody, loadWork } from "./terminal.js";
import { pressed } from "../shell/keys.js";

const TABS = [["activity", "Activity"], ["plan", "Plan"], ["files", "Files"], ["memory", "Memory"], ["browser", "Browser"], ["terminal", "Terminal"]];
const REAL = new Set(["activity", "plan", "files", "memory", "terminal"]);
const P = { sid: null, messages: [], plan: null, at: 0 };

/* This conversation's tasks; before a new conversation has its id, the task its first message started. */
const runsHere = () => {
  const first = sendingPrompt();
  return (E.state?.runs ?? []).filter((r) => (S.chat ? r.sessionId === S.chat : first && r.prompt === first));
};
const working = () => runsHere().some((r) => ["running", "queued", "waiting"].includes(r.status));

function target(args) {
  try {
    const a = typeof args === "string" ? JSON.parse(args) : args ?? {};
    // A command shows as it was run: the program and its arguments.
    if (a.executable) return [a.executable, ...(Array.isArray(a.args) ? a.args : [])].join(" ");
    return a.path ?? a.url ?? a.command ?? a.query ?? a.name ?? "";
  } catch { return ""; }
}

function activity() {
  const results = new Map(P.messages.filter((m) => m.role === "tool").map((m) => [m.toolCallId, m.content]));
  const steps = P.messages.flatMap((m) => m.toolCalls ?? []).map((c) => {
    let ok = null;
    try { ok = JSON.parse(results.get(c.id) ?? "null")?.ok ?? null; } catch { /* a result that is not JSON */ }
    return { name: c.name, detail: target(c.arguments), ok };
  });
  if (!steps.length && !working()) return '<p class="empty">No steps yet.</p>';
  const rows = steps.map((s, i) => `<li class="${s.ok === false ? "" : "ok"}">${ic(s.ok === false ? "x" : "check", "s")}<span>${esc(s.name)}<small>${esc(s.detail)}</small></span><time>${i + 1}</time></li>`).join("");
  const now = working() ? `<li class="run">${ic("spin", "s")}<span>${esc(runsHere().find((r) => r.status === "running")?.prompt?.split("\n")[0] ?? "")}</span><time>now</time></li>` : "";
  return `<ol class="tl">${rows}${now}</ol>`;
}

function plan() {
  const steps = P.plan?.steps ?? [];
  if (!steps.length) return '<p class="empty">No plan for this conversation.</p>';
  const cls = { done: "done", working: "now", failed: "bad", waiting: "" };
  return `<ul class="plan">${steps.map((s) => `<li class="${cls[s.status] ?? ""}"><span class="box">${s.status === "done" ? ic("check") : ""}</span><span>${esc(s.title)}</span></li>`).join("")}</ul>`;
}

function files() {
  const changed = runsHere().flatMap((r) => r.changes ?? []);
  if (!changed.length) return '<p class="empty">No files touched yet.</p>';
  return changed.map((f) => { const st = f.existed ? "Changed" : "Made"; return `<button class="memrow" type="button" data-css="text-align:left" data-act="fileopen" data-n="${esc(f.path)}"><span><b data-css="font-weight:500">${esc(f.path)}</b></span><small>+${Number(f.added) || 0} −${Number(f.removed) || 0}</small><span class="pill ${st === "Made" ? "done" : "warn"}" data-css="grid-row:1 / span 2;grid-column:2;align-self:center">${st}</span></button>`; }).join("");
}

const BODY = { activity, plan, files, memory: () => '<p class="empty">Nothing remembered was used here.</p>', terminal: () => terminalBody(S.chat) };
const tabAct = (id) => (REAL.has(id) ? "ptabp" : id === "browser" ? "stage" : "ptabp-" + id);

export function drawPane() {
  const pane = $("#pane"), body = $("#body");
  const open = S.view === "chat" && !!S.pane && (!!S.chat || !!sendingPrompt());
  if (!pane) return;
  pane.hidden = !open;
  body?.classList.toggle("pane-on", open);
  if (!open) { pane.innerHTML = ""; return; }
  const tab = REAL.has(S.pane) ? S.pane : "activity";
  pane.innerHTML = `<div class="pane-h"><div class="ptabs" role="tablist">${TABS.map(([id, l]) => `<button class="ptab" role="tab" type="button" aria-selected="${tab === id}" data-act="${tabAct(id)}" data-p="${id}" data-v="${id}">${l}</button>`).join("")}</div><button class="icon-btn" type="button" aria-label="Close the side panel" data-act="pane" data-p="close">${ic("x")}</button></div><div class="pane-b">${BODY[tab]()}</div>`;
  applyCss(pane);
  greyOut(pane);
  loadPane();
  if (tab === "terminal") loadWork(S.chat);
}

/* The open conversation's messages and its newest task's plan, read again at most every two seconds; the panel alone is
   drawn again when they change. */
async function loadPane() {
  const sid = S.chat;
  if (!sid || (sid === P.sid && Date.now() - P.at < 2000)) return;
  P.at = Date.now();
  const newest = runsHere().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const [session, planned] = await Promise.all([
    api(`sessions/${encodeURIComponent(sid)}`).catch(() => null),
    newest ? api(`runs/${encodeURIComponent(newest.id)}/plan`).catch(() => null) : null,
  ]);
  const messages = session?.messages ?? [], planNow = planned?.plan ?? null;
  const same = sid === P.sid && JSON.stringify(messages) === JSON.stringify(P.messages) && JSON.stringify(planNow) === JSON.stringify(P.plan);
  Object.assign(P, { sid, messages, plan: planNow });
  if (!same && S.chat === sid) drawPane();
}

export function initPane() {
  initStage();
  markLive(["pane", "ptabp"]);
  on("pane", (el) => {
    const p = el.dataset.p, inHead = !!el.closest(".head");
    S.pane = p === "close" ? null : inHead && S.pane ? null : p;
    drawPane();
  });
  on("ptabp", (el) => { S.pane = el.dataset.p; drawPane(); });
  document.addEventListener("keydown", (e) => {
    if (pressed(e, "sidePane")) { e.preventDefault(); S.pane = S.pane ? null : "activity"; drawPane(); }
  });
}
