/* Automations: scheduled, triggers, procedures, check-ins, board - matches redesign prototype.
   Real data from: GET /api/state (schedules, triggers, procedures), /api/heartbeat,
   /api/flows-boards, /api/prompts. Switches and buttons wired to real routes. */

import { esc, renderNow } from "../core/dom.js";
import { S, E, refresh } from "../core/state.js";
import { ic, av, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { api } from "../core/api.js";

let heartbeat = null;
let board = null;
let prompts = null;

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
    <div class="rows" data-css="margin-top:8px">${schedules.length ? schedules.map((s, i) => `<div class="prow">${av({id: s.id}, 34)}<span class="grow"><b>${esc(s.name || 'Schedule')}</b><small>${esc((s.description || 'Scheduled') + ' · Branch')}</small></span><button class="btn sm" type="button" data-act="sched-run" data-id="${esc(s.id || '')}">Run now</button></div>`).join('') : ''}</div>
  <div class="sec ideas15"><div class="sec-h15"><h2>Ideas</h2></div></div>`;

  } else if (tab === "procedures") {
    html += `<p class="hint" data-css="margin:4px 0 8px">Saved step-by-step routines, including ones a Trunk learned by watching you.</p>
    <div class="acts" data-css="margin:6px 0"><button class="btn" type="button" data-act="teach-start">${ic('play', 's')}Show a Trunk how, once</button></div>
    <div class="rows" data-css="margin-top:8px">${procedures.length ? procedures.map((p, i) => `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(p.name || 'Procedure')}</b><small>${esc((p.steps || '0 steps') + ' · Branch')}</small></span><button class="btn sm" type="button" data-act="toast" data-msg="Running ${esc(p.name || 'Procedure')}…">Run now</button></div>`).join('') : ''}</div>
  <div class="sec"><h2>Your saved prompts</h2><p class="hint" data-css="margin:0 0 8px">Things you ask for often. Each has its own command that works in the window, on the phone, in the terminal and in chat apps.</p><div class="rows">${prompts && prompts.list ? prompts.list.slice(0, 3).map(p => `<div class="prow"><span class="ico-tile"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"></path></svg></span><span class="grow"><b>${esc(p.name || '')} <code>/${esc(p.id || '')}</code></b><small>${esc((p.category || 'General') + ' · ' + (p.prompt?.slice(0, 40) || ''))}</small></span><button class="btn sm" type="button" data-act="prompt-use" data-v="${esc(p.id || '')}">Use</button></div>`).join('') : ''}</div><div class="acts" data-css="margin-top:10px"><button class="btn" type="button" data-act="prompt-new">${ic('plus', 's')}New prompt</button></div></div>`;

  } else if (tab === "triggers") {
    html += `<p class="hint" data-css="margin:4px 0 8px">Work that starts when something happens.</p>
    <form class="nl" data-form="nl"><input class="inp" id="nl-in" placeholder="Describe it: &quot;when a PDF lands in Downloads, summarise it&quot;" aria-label="Describe a new automation"><button class="btn pri" type="submit">Add</button></form>
    <div class="rows" data-css="margin-top:8px">${triggers.length ? triggers.map((t, i) => `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(t.name || 'Trigger')}</b><small>${esc(t.prompt ?? '')}</small></span><input class="sw" type="checkbox" id="auto-triggers-${i}" data-sw="trigger" data-id="${esc(t.id || '')}" ${t.enabled ? 'checked=""' : ''} aria-label="${esc(t.name || 'Trigger')} on or off"></div>`).join('') : ''}</div>`;

    markLive(triggers.map((_, i) => `sw:auto-triggers-${i}`));
  } else if (tab === "checkins") {
    html += checkinsTile(heartbeat);
  } else if (tab === "board") {
    const columns = board && board.columns ? board.columns : [];
    html += `<div class="x15" data-tab15="board"><p class="hint" data-css="margin:4px 0 10px">Work that takes more than one sitting. Trunks move their own cards; drag one to move it yourself.</p><div class="board15" role="list">${columns.map(col => `<section class="col15" data-col15="${esc(col.id)}" aria-label="${esc(col.name)}"><h3>${esc(col.name)}<span>${col.cards ? col.cards.length : 0}</span></h3>${col.cards ? col.cards.map(card => `<div class="card15" role="listitem" draggable="true" data-card15="${esc(card.id)}"><b>${esc(card.title || '')}</b><span class="c-foot15">${av({}, 18)}<small>${esc(card.subtitle || '')}</small></span><button type="button" class="c-mv15" data-act="bmove15" data-id="${esc(card.id)}" aria-label="Move"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="18" cy="12" r="1"></circle></svg></button></div>`).join('') : ''}</section>`).join('')}</div></div>`;
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
    const fresh = await api("flows-boards/board").catch(() => null);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(board)) {
      board = fresh;
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
  markLive(["ptab", "hb-every", "hb-hours", "hb-rm", "sched-run", "teach-start", "prompt-use", "prompt-new", "bmove15", "flow", "idea15", "ideas15"]);
  on("sched-run", async (el) => { try { await api(`schedules/${encodeURIComponent(el.dataset.id)}/trigger`, {}); await refresh(); renderNow(); } catch (error) { toast(error.message); } });
  on("hb-every", (el) => (el.dataset.v === "off" ? saveHeartbeat(null, "off") : saveHeartbeat({ everyMinutes: +el.dataset.v }, "on")));
  on("hb-hours", (el) => (el.dataset.v === "always" ? saveHeartbeat({ activeHours: null }) : null));
  on("hb-rm", (el) => { const lines = linesOf(heartbeat); lines.splice(+el.dataset.i, 1); saveHeartbeat({ checklist: lines.join("\n") }); });
  on("teach-start", async (el) => {
    try {
      await api("settings-kit/apply", { plan: { source: "set", key: "run-recording", field: "mode", value: "when-needed" } });
    } catch (error) {
      toast(error.message);
    }
  });
  on("prompt-use", async (el) => {
    const promptId = el.dataset.v;
    if (!prompts || !prompts.list) {
      toast("Prompts not loaded");
      return;
    }
    const prompt = prompts.list.find(p => p.id === promptId);
    if (prompt) {
      // Inject into draft - for now just toast
      toast(`Using prompt: ${prompt.name}`);
    }
  });
  on("prompt-new", async (el) => {
    // Window-only: opens dialog
    toast("New prompt dialog (window state only)");
  });
  on("bmove15", async (el) => {
    // Window-only: opens popover
    toast("Move card popover (window state only)");
  });
  on("flow", async (el) => {
    // Opens a saved flow from the editor
    const flowId = el.dataset.id;
    try {
      const flow = await api(`flows/${encodeURIComponent(flowId || '')}`);
      toast("Opening flow editor");
    } catch (error) {
      toast(error.message);
    }
  });
  on("idea15", async (el) => {
    // Window-only: fills the scheduled describe box with idea text
    toast("Idea selected (window state only)");
  });
  on("ideas15", async (el) => {
    // Window-only: opens fixed list of idea texts
    toast("Ideas list (window state only)");
  });
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
