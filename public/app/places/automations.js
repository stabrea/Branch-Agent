/* Automations: scheduled, triggers, procedures, check-ins, board - matches redesign prototype.
   Real data from: GET /api/state (schedules, triggers, procedures), /api/heartbeat,
   /api/flows-boards, /api/prompts. Switches and buttons wired to real routes. */

import { $, esc, renderNow } from "../core/dom.js";
import { S, E, refresh } from "../core/state.js";
import { ic, av, toast, openPop, closePop, openDlg, closeDlg } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { api } from "../core/api.js";

let heartbeat = null;
let board = null;
let boardProblem = "";
let prompts = null;

/* The design's idea catalogue: [group, title, what it does, the words put in the Scheduled box]. Window text; nothing is
   saved until the person presses Add. */
const IDEAS = [
  ["Money", "Receipts into folders", "When a receipt lands in email, file it by the month it was paid.", "when a receipt arrives by email, file it in Receipts by the month it was paid"],
  ["Money", "Subscription watch", "Tell me when a subscription price goes up.", "every month, check my card statement and tell me if a subscription price went up"],
  ["Money", "Bill reminders", "A nudge three days before each bill is due.", "three days before a bill is due, remind me in Telegram"],
  ["Mornings", "Morning brief", "Weather, calendar and anything that needs you, at 7:30.", "every weekday at 7:30, send me the weather, my calendar and what needs me"],
  ["Mornings", "Inbox triage", "Sort new mail into needs-me, later and noise.", "every morning at 8, sort new mail into needs me, later and noise"],
  ["Home", "Tidy Downloads", "Anything older than six months goes to an archive.", "every Friday at 5, move files older than six months from Downloads to Downloads/Archive"],
  ["Home", "Backup check", "Make sure last night’s backup finished.", "every night at 2, check the backup finished and tell me only if it did not"],
  ["Home", "Photo clean-up", "Find blurry shots and duplicates, and ask before removing.", "every Sunday, find blurry and duplicate photos and ask me before removing any"],
  ["Research", "Price tracker", "Watch a product page and report only a real drop.", "every day, check the price on a product page and tell me only when it drops"],
  ["Research", "News on a topic", "A short weekly digest with sources.", "every Monday, send me a short digest on a topic with sources"],
  ["Research", "Page change alert", "Tell me what changed on a page, not that it changed.", "every hour, check a page and tell me only what changed since last time"],
  ["Work", "Meeting notes", "After each meeting, notes and follow-ups in Library.", "after each calendar meeting, write notes and follow-ups into Library"],
  ["Work", "Weekly report", "Friday summary of what your Trunks did.", "every Friday at 4, summarise what my Trunks did this week"],
];
const ideaCard = (x, i) => `<button type="button" class="idea15" data-act="idea15" data-i="${i}"><small>${esc(x[0])}</small><b>${esc(x[1])}</b><span>${esc(x[2])}</span></button>`;

/* The engine's shared board (GET /api/flows-boards/board): its five lanes under the design's five column names. */
const LANES = [["todo", "To do"], ["doing", "Doing"], ["review", "To check"], ["done", "Done"], ["blocked", "Stuck"]];
const cardOf = (id) => LANES.flatMap(([k]) => board?.lanes?.[k] ?? []).find((c) => c.id === id);
function assigneeFace(name) {
  const trunk = (Array.isArray(E.trunks) ? E.trunks : []).find((t) => t.name === name || t.id === name);
  return trunk ? av(trunk, 18) : name === "assistant" ? av({ kind: "main" }, 18) : "";
}
function boardCard(c) {
  return `<div class="card15" role="listitem" draggable="true" data-card15="${esc(c.id)}"><b>${esc(c.title)}</b><span class="c-foot15">${assigneeFace(c.assignee)}<small>${esc(c.notes)}</small></span><button type="button" class="c-mv15" data-act="bmove15" data-id="${esc(c.id)}" aria-label="Move “${esc(c.title)}”">${ic("more", "s")}</button></div>`;
}
function boardTab() {
  const hint = `<p class="hint" data-css="margin:4px 0 10px">Work that takes more than one sitting. Trunks move their own cards; drag one to move it yourself.</p>`;
  if (!board) return `<div class="x15" data-tab15="board">${hint}${boardProblem ? `<p class="hint">${esc(boardProblem)}</p>` : ""}</div>`;
  const cols = LANES.map(([k, label]) => {
    const cards = board.lanes?.[k] ?? [];
    return `<section class="col15" data-col15="${k}" aria-label="${label}"><h3>${label}<span>${cards.length}</span></h3>${cards.map(boardCard).join("") || '<p class="c-empty15">Nothing here</p>'}</section>`;
  }).join("");
  return `<div class="x15" data-tab15="board">${hint}<div class="board15" role="list">${cols}</div></div>`;
}
/* One card to another lane: POST /api/flows-boards/board/cards/<id>/move {lane}; the engine's refusal is shown as it said it. */
async function moveCard(id, lane) {
  closePop();
  try { await api(`flows-boards/board/cards/${encodeURIComponent(id)}/move`, { lane }); } catch (error) { toast(error.message); }
  try { board = await api("flows-boards/board"); } catch (error) { toast(error.message); }
  renderNow();
}
/* Dragging a card onto another column is the same move. */
function initDrag() {
  let dragged = null;
  document.addEventListener("dragstart", (e) => { const c = e.target.closest?.("[data-card15]"); if (!c) return; dragged = c.dataset.card15; c.classList.add("dragging15"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragged); });
  document.addEventListener("dragover", (e) => { const col = e.target.closest?.("[data-col15]"); if (!col || !dragged) return; e.preventDefault(); document.querySelectorAll(".col15.over15").forEach((x) => x !== col && x.classList.remove("over15")); col.classList.add("over15"); });
  document.addEventListener("drop", (e) => {
    const col = e.target.closest?.("[data-col15]");
    if (!col || !dragged) return;
    e.preventDefault();
    const id = dragged;
    dragged = null;
    if (cardOf(id)?.lane !== col.dataset.col15) moveCard(id, col.dataset.col15); else renderNow();
  });
  document.addEventListener("dragend", () => { dragged = null; document.querySelectorAll(".dragging15,.over15").forEach((x) => x.classList.remove("dragging15", "over15")); });
}

export function draw() {
  const tab = S.tabs.automations || "scheduled";
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;

  const schedules = E.state.schedules || [];
  const triggers = E.state.triggers || [];
  const procedures = E.state.procedures || [];

  let html = `<main class="main enter11" id="main"><div class="lock-banner">${ic('lock', 's')}Lockdown is on. Trunks can read, but nothing leaves this computer and nothing is changed.<button type="button" data-act="lock">Turn it off</button></div><div class="scroll"><div class="place">
    <h1>Automations</h1><p class="lede">Work your Trunks do on their own.</p>
    <div class="tabs" role="tablist"><button class="tab" role="tab" type="button" aria-selected="${tab === 'scheduled' ? 'true' : 'false'}" data-act="ptab" data-place="automations" data-v="scheduled">Scheduled</button><button class="tab" role="tab" type="button" aria-selected="${tab === 'procedures' ? 'true' : 'false'}" data-act="ptab" data-place="automations" data-v="procedures">Procedures</button><button class="tab" role="tab" type="button" aria-selected="${tab === 'triggers' ? 'true' : 'false'}" data-act="ptab" data-place="automations" data-v="triggers">Triggers</button><button class="tab" role="tab" type="button" aria-selected="${tab === 'checkins' ? 'true' : 'false'}" data-act="ptab" data-place="automations" data-v="checkins">Check-ins</button><button class="tab" role="tab" type="button" aria-selected="${tab === 'board' ? 'true' : 'false'}" data-act="ptab" data-place="automations" data-v="board">Board</button></div>`;

  if (tab === "scheduled") {
    html += `<p class="hint" data-css="margin:4px 0 8px">Work a Trunk does on a schedule.</p>
    <form class="nl" data-form="nl"><input class="inp" id="nl-in" placeholder="Describe it: &quot;every weekday at 8, check my inbox for invoices&quot;" aria-label="Describe a new automation"><button class="btn pri" type="submit">Add</button></form>
    <div class="rows" data-css="margin-top:8px">${schedules.length ? schedules.map((s, i) => `<div class="prow">${av({id: s.id}, 34)}<span class="grow"><b>${esc(String(s.data?.prompt ?? '').split('\n')[0].slice(0, 80))}</b><small>${esc(s.data?.dueAt ? new Date(s.data.dueAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '')}</small></span><button class="btn sm" type="button" data-act="sched-run" data-id="${esc(s.id || '')}">Run now</button></div>`).join('') : ''}</div>
  <div class="sec ideas15"><div class="sec-h15"><h2>Ideas</h2><button type="button" class="link15" data-act="ideas15">See all ${IDEAS.length}</button></div><div class="idea-row15">${IDEAS.slice(0, 3).map(ideaCard).join('')}</div></div>`;

  } else if (tab === "procedures") {
    html += `<p class="hint" data-css="margin:4px 0 8px">Saved step-by-step routines, including ones a Trunk learned by watching you.</p>
    <div class="acts" data-css="margin:6px 0"><button class="btn" type="button" data-act="teach-start">${ic('play', 's')}Show a Trunk how, once</button></div>
    <div class="rows" data-css="margin-top:8px">${procedures.length ? procedures.map((p, i) => `<div class="prow" data-act="flow" data-id="${esc(p.id)}">${av({}, 34)}<span class="grow"><b>${esc(p.data?.definition?.name ?? '')}</b><small>${esc(p.data?.status ?? '')}</small></span><button class="btn sm" type="button" data-act="toast">Run now</button></div>`).join('') : ''}</div>
  <div class="sec"><h2>Your saved prompts</h2><p class="hint" data-css="margin:0 0 8px">Things you ask for often. Each has its own command that works in the window, on the phone, in the terminal and in chat apps.</p><div class="rows">${(prompts?.prompts ?? []).slice(0, 3).map(p => `<div class="prow"><span class="ico-tile"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"></path></svg></span><span class="grow"><b>${esc(p.title ?? '')}${p.command ? ` <code>/${esc(p.command)}</code>` : ''}</b><small>${esc([p.group, String(p.body ?? '').slice(0, 40)].filter(Boolean).join(' · '))}</small></span><button class="btn sm" type="button" data-act="prompt-use" data-v="${esc(p.id ?? '')}">Use</button></div>`).join('')}</div><div class="acts" data-css="margin-top:10px"><button class="btn" type="button" data-act="prompt-new">${ic('plus', 's')}New prompt</button></div></div>`;

  } else if (tab === "triggers") {
    html += `<p class="hint" data-css="margin:4px 0 8px">Work that starts when something happens.</p>
    <form class="nl" data-form="nl"><input class="inp" id="nl-in" placeholder="Describe it: &quot;when a PDF lands in Downloads, summarise it&quot;" aria-label="Describe a new automation"><button class="btn pri" type="submit">Add</button></form>
    <div class="rows" data-css="margin-top:8px">${triggers.length ? triggers.map((t, i) => `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(t.name ?? '')}</b><small>${esc(t.prompt ?? '')}</small></span><input class="sw" type="checkbox" id="auto-triggers-${i}" data-sw="trigger" data-id="${esc(t.id || '')}" ${t.enabled ? 'checked=""' : ''} aria-label="${esc(t.name ?? '')} on or off"></div>`).join('') : ''}</div>`;

    markLive(triggers.map((_, i) => `sw:auto-triggers-${i}`));
  } else if (tab === "checkins") {
    html += checkinsTile(heartbeat);
  } else if (tab === "board") {
    html += boardTab();
  }

  html += `</div></div></div></main>`;
  return html;
}

export async function after() {
  const tab = S.tabs.automations || "scheduled";

  if (tab === "checkins") {
    const fresh = await api("heartbeat").catch(() => null);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(heartbeat)) {
      heartbeat = fresh;
      renderNow();
    }
  } else if (tab === "board") {
    let fresh = null, problem = "";
    try { fresh = await api("flows-boards/board"); } catch (error) { problem = error.message; }
    if (JSON.stringify(fresh) !== JSON.stringify(board) || problem !== boardProblem) {
      board = fresh;
      boardProblem = problem;
      renderNow();
    }
  } else if (tab === "procedures") {
    const fresh = await api("prompts").catch(() => null);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(prompts)) {
      prompts = fresh;
      renderNow();
    }
  }
}

/* Check in on its own, from GET /api/heartbeat: whether it is on (the checkIn switch), how often, which hours, what it
   checks (the checklist, one line each) and the last check-ins. Settings are saved whole (POST /api/heartbeat). */
const hhmm = (t) => { const [h, m] = String(t).split(":").map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: m ? "2-digit" : undefined }); };
const settingsOf = (hb) => hb?.heartbeat?.settings ?? null;
const linesOf = (hb) => String(settingsOf(hb)?.checklist ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

function checkinsTile(hb) {
  const set = settingsOf(hb), mode = hb?.switches?.checkIn ?? "off", on = mode !== "off";
  const every = on ? String(set?.everyMinutes ?? "") : "off";
  const hours = set?.activeHours ?? null;
  const seg = (act, v, label, pressed) => `<button type="button" aria-pressed="${pressed}" data-act="${act}" data-v="${v}">${label}</button>`;
  const history = (hb?.heartbeat?.state?.history ?? []).slice(-5).reverse();
  return `<div class="tile"><div class="th"><b>Check in on its own</b><span class="pill ${on ? "ok" : "idle"} ml"><i></i>${on ? "On" : "Off"}</span></div><p>Branch looks at the list below every so often and speaks up only when there's news. It's HEARTBEAT.md, in plain words.</p>
    <div class="ctl"><b>How often</b><span class="right"><span class="seg" role="group" aria-label="How often">${seg("hb-every", 15, "Every 15 min", every === "15")}${seg("hb-every", 30, "Every 30 min", every === "30")}${seg("hb-every", 60, "Every hour", every === "60")}${seg("hb-every", "off", "Off", every === "off")}</span></span><small>Quiet background work: no news, no message.</small></div>
    <div class="ctl"><b>Which hours</b><span class="right"><span class="seg" role="group" aria-label="Which hours">${hours ? seg("hb-hours", "kept", `${esc(hhmm(hours.from))} – ${esc(hhmm(hours.to))}`, true) : ""}${seg("hb-hours", "always", "Always", !hours)}${seg("hb-work", "work", "Work hours", false)}</span></span><small>Outside these hours it waits.</small></div>
    <div class="ctl"><b>Quiet on weekends</b><input class="sw" type="checkbox" id="hb-wk" aria-label="Quiet on weekends" data-sw="hb-wk"><small>It still tells you if a Trunk is stuck.</small></div>
    <div class="sec"><h2>What it checks</h2><div class="rows">${linesOf(hb).map((c, i) => `<div class="prow"><span class="ico-tile"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2-5 4 10 2-5h6"></path></svg></span><span class="grow"><b data-css="font-weight:500">${esc(c)}</b></span><button class="icon-btn" type="button" aria-label="Remove" data-act="hb-rm" data-i="${i}" data-css="width:28px;height:28px"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></div>`).join("")}</div><form class="nl" data-form="hb" data-css="margin-top:8px"><input class="inp" id="hb-in" placeholder="Add something to check: &quot;a reply from the landlord&quot;" aria-label="Add something to check"><button class="btn" type="submit">Add</button></form></div>
    <div class="sec"><h2>Last check-ins</h2><ol class="tl">${history.map((h) => `<li class="${h.outcome === "failed" ? "" : "ok"}"><span>${esc(h.outcome)}<small>${esc(h.reason ?? "")}</small></span><time>${esc(new Date(h.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</time></li>`).join("")}</ol></div></div>`;
}

async function saveHeartbeat(change, switchOn) {
  try {
    const set = settingsOf(heartbeat);
    if (change && set) await api("heartbeat", { ...set, ...change });
    if (switchOn !== undefined) await api("heartbeat/switches", { checkIn: switchOn });
    heartbeat = await api("heartbeat");
  } catch (error) { toast(error.message); }
  renderNow();
}

export function init() {
  markLive(["ptab", "hb-every", "hb-hours", "hb-rm", "sched-run", "bmove15", "bto15", "ideas15", "idea15"]);
  on("bmove15", (el) => {
    const card = cardOf(el.dataset.id);
    if (!card) return;
    openPop(el, `<div class="ph">Move to</div>${LANES.map(([k, l]) => `<button class="mi" type="button" role="menuitemradio" aria-checked="${card.lane === k}" data-act="bto15" data-id="${esc(card.id)}" data-v="${k}"><span class="mi-t">${l}</span></button>`).join("")}`, { right: true });
  });
  on("bto15", (el) => moveCard(el.dataset.id, el.dataset.v));
  on("ideas15", () => openDlg({ title: "Ideas for automations", wide: true, body: [...new Set(IDEAS.map((x) => x[0]))].map((g) => `<div class="idea-g15"><h3>${esc(g)}</h3><div class="idea-row15">${IDEAS.map((x, i) => (x[0] === g ? ideaCard(x, i) : "")).join("")}</div></div>`).join("") }));
  /* Fills the Scheduled box with the idea's words; nothing is saved here. */
  on("idea15", (el) => {
    closeDlg();
    S.view = "automations";
    S.tabs.automations = "scheduled";
    renderNow();
    const box = $("#nl-in");
    if (box) { box.value = IDEAS[+el.dataset.i]?.[3] ?? ""; box.focus(); }
  });
  initDrag();
  on("sched-run", async (el) => { try { await api(`schedules/${encodeURIComponent(el.dataset.id)}/trigger`, {}); await refresh(); renderNow(); } catch (error) { toast(error.message); } });
  on("hb-every", (el) => (el.dataset.v === "off" ? saveHeartbeat(null, "off") : saveHeartbeat({ everyMinutes: +el.dataset.v }, "on")));
  on("hb-hours", (el) => (el.dataset.v === "always" ? saveHeartbeat({ activeHours: null }) : null));
  on("hb-rm", (el) => { const lines = linesOf(heartbeat); lines.splice(+el.dataset.i, 1); saveHeartbeat({ checklist: lines.join("\n") }); });
  document.addEventListener("submit", (e) => {
    if (e.target.dataset?.form !== "hb") return;
    e.preventDefault();
    const text = document.getElementById("hb-in")?.value.trim();
    if (text) saveHeartbeat({ checklist: [...linesOf(heartbeat), text].join("\n") });
  });
  /* A trigger's own switch: POST /api/triggers/<id>/enabled. */
  document.addEventListener("change", async (e) => {
    const el = e.target;
    if (el.dataset?.sw !== "trigger" || !el.dataset.id) return;
    try { await api(`triggers/${encodeURIComponent(el.dataset.id)}/enabled`, { enabled: el.checked }); } catch (error) { el.checked = !el.checked; toast(error.message); }
  });
}
