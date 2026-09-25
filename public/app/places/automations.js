/* Automations: scheduled, triggers, procedures, check-ins, board - matches redesign prototype.
   Real data from: GET /api/state (schedules, triggers, procedures), /api/heartbeat,
   /api/flows-boards, /api/prompts. Switches and buttons wired to real routes. */

import { esc, renderNow } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { ic, av } from "../core/ui.js";
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
    <div class="rows" data-css="margin-top:8px">${triggers.length ? triggers.map((t, i) => `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(t.name || 'Trigger')}</b><small>${esc((t.prompt || 'When...') + ' · Scout')}</small></span><input class="sw" type="checkbox" id="auto-triggers-${i}" data-sw="sw:trigger-toggle-${i}" data-id="${esc(t.id || '')}" ${t.enabled ? 'checked=""' : ''} aria-label="${esc(t.name || 'Trigger')} on or off"></div>`).join('') : ''}</div>`;

  } else if (tab === "checkins") {
    const checks = heartbeat && heartbeat.checks ? heartbeat.checks : [];
    html += `<div class="tile"><div class="th"><b>Check in on its own</b><span class="pill ok ml"><i></i>On</span></div><p>Branch looks at the list below every so often and speaks up only when there's news. It's HEARTBEAT.md, in plain words.</p>
        <div class="ctl"><b>How often</b><span class="right"><span class="seg" role="group" aria-label="How often"><button type="button" aria-pressed="false" data-act="hb-every" data-v="15">Every 15 min</button><button type="button" aria-pressed="true" data-act="hb-every" data-v="30">Every 30 min</button><button type="button" aria-pressed="false" data-act="hb-every" data-v="60">Every hour</button><button type="button" aria-pressed="false" data-act="hb-every" data-v="off">Off</button></span></span><small>Quiet background work: no news, no message.</small></div><div class="ctl"><b>Which hours</b><span class="right"><span class="seg" role="group" aria-label="Which hours"><button type="button" aria-pressed="true" data-act="hb-hours" data-v="8-20">8 AM – 8 PM</button><button type="button" aria-pressed="false" data-act="hb-hours" data-v="always">Always</button><button type="button" aria-pressed="false" data-act="hb-hours" data-v="work">Work hours</button></span></span><small>Outside these hours it waits.</small></div><div class="ctl"><b>Quiet on weekends</b><input class="sw" type="checkbox" id="hb-wk" checked="" aria-label="Quiet on weekends" data-sw="sw:hb-wk"><small>It still tells you if a Trunk is stuck.</small></div>
        <div class="sec"><h2>What it checks</h2><div class="rows">${checks.length ? checks.map((c, i) => `<div class="prow"><span class="ico-tile"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2-5 4 10 2-5h6"></path></svg></span><span class="grow"><b data-css="font-weight:500">${esc(c)}</b></span><button class="icon-btn" type="button" aria-label="Remove" data-act="hb-rm" data-i="${i}" data-css="width:28px;height:28px"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></div>`).join('') : ''}</div><form class="nl" data-form="hb" data-css="margin-top:8px"><input class="inp" id="hb-in" placeholder="Add something to check: &quot;a reply from the landlord&quot;" aria-label="Add something to check"><button class="btn" type="submit">Add</button></form></div>
        <div class="sec"><h2>Last check-ins</h2><ol class="tl"></ol></div></div>`;

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

export function init() {
  const triggers = E.state?.triggers || [];
  const triggerIds = triggers.map((_, i) => `sw:trigger-toggle-${i}`);
  markLive(["ptab", "sw:hb-wk", ...triggerIds]);

  // Trigger toggle switches with addEventListener
  document.addEventListener("change", async (e) => {
    const el = e.target;
    if (el.dataset.sw?.startsWith("sw:trigger-toggle-")) {
      const id = el.dataset.id;
      if (!id) return;
      try {
        await api(`triggers/${encodeURIComponent(id)}/enabled`, { enabled: el.checked });
      } catch (error) {
        el.checked = !el.checked;
      }
    } else if (el.dataset.sw === "sw:hb-wk") {
      try {
        await api("heartbeat/switches", { quietWeekends: el.checked });
      } catch (error) {
        el.checked = !el.checked;
      }
    }
  }, true);

  // Schedule run-now buttons
  document.addEventListener("click", async (e) => {
    if (e.target.dataset.act === "sched-run") {
      const id = e.target.dataset.id;
      if (!id) return;
      try {
        await api(`schedules/${encodeURIComponent(id)}/trigger`, {});
      } catch (error) {
        // Error handled by system
      }
    }
  }, true);

  // Heartbeat frequency buttons
  document.addEventListener("click", async (e) => {
    if (e.target.dataset.act === "hb-every") {
      const v = e.target.dataset.v;
      const mins = v === "15" ? 15 : v === "30" ? 30 : v === "60" ? 60 : null;
      try {
        await api("heartbeat/switches", { frequency: mins });
      } catch (error) {
        // Error handled by system
      }
    }
  }, true);

  // Heartbeat hours buttons
  document.addEventListener("click", async (e) => {
    if (e.target.dataset.act === "hb-hours") {
      const v = e.target.dataset.v;
      try {
        await api("heartbeat/switches", { hours: v });
      } catch (error) {
        // Error handled by system
      }
    }
  }, true);

  // Board card move button
  document.addEventListener("click", async (e) => {
    if (e.target.dataset.act === "bmove15") {
      const id = e.target.dataset.id;
      if (!id) return;
      try {
        await api(`flows-boards/board/cards/${encodeURIComponent(id)}/move`, {});
      } catch (error) {
        // Error handled by system
      }
    }
  }, true);
}
