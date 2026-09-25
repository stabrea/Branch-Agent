/* Automations: scheduled, procedures, triggers. */

import { esc } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { ic, av } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { tabBar } from "./parts.js";

const tabs = [["scheduled", "Scheduled"], ["procedures", "Procedures"], ["triggers", "Triggers"]];
const tab = S.tabs.automations || "scheduled";

export function draw() {
  if (!E.state) return `<div class="scroll"><div class="place"></div></div>`;

  let html = `<div class="scroll"><div class="place">
    <h1>Automations</h1><p class="lede">Work your Trunks do on their own.</p>
    ${tabBar(tabs, "automations", tab)}<p class="hint">`;

  if (tab === "scheduled") {
    html += `Work a Trunk does on a schedule.</p>
      <form class="nl"><input class="inp" placeholder="Describe it: 'every weekday at 8, check my inbox'" aria-label="Describe a new automation">
      <button class="btn pri" type="submit">Add</button></form>
      <div class="rows">${(E.state.schedules || []).length ?
        (E.state.schedules || []).map((s, i) => `<div class="prow">${av({}, 26)}<span class="grow">
        <b>${esc(s.name || 'Schedule')}</b><small>${esc(s.when || 'Scheduled')}</small></span>
        <input class="sw" type="checkbox" id="auto-s-${i}" data-sw="auto" data-tab="scheduled" data-i="${i}" aria-label="Toggle">
        </div>`).join('') : `<p>No schedules yet.</p>`}`;
  } else if (tab === "procedures") {
    html += `Saved step-by-step routines, including ones a Trunk learned by watching you.</p>
      <div class="acts"><button class="btn" data-act="teach-start">${ic('play', 's')}Show a Trunk how, once</button></div>
      <div class="rows">${(E.state.procedures || []).length ?
        (E.state.procedures || []).map((p, i) => `<div class="prow">${av({}, 26)}<span class="grow">
        <b>${esc(p.name || 'Procedure')}</b><small>${esc(p.steps || '0 steps')}</small></span>
        <button class="btn sm" data-act="toast" data-msg="Running...">Run now</button></div>`).join('') : `<p>No procedures yet.</p>`}`;
  } else if (tab === "triggers") {
    html += `Work that starts when something happens.</p>
      <form class="nl"><input class="inp" placeholder="Describe it: 'when a PDF lands, summarise it'" aria-label="Describe a new trigger">
      <button class="btn pri" type="submit">Add</button></form>
      <div class="rows">${(E.state.triggers || []).length ?
        (E.state.triggers || []).map((t, i) => `<div class="prow">${av({}, 26)}<span class="grow">
        <b>${esc(t.name || 'Trigger')}</b><small>${esc(t.when || 'When...')}</small></span>
        <input class="sw" type="checkbox" id="auto-t-${i}" data-sw="auto" data-tab="triggers" data-i="${i}" aria-label="Toggle">
        </div>`).join('') : `<p>No triggers yet.</p>`}`;
  }

  html += `</div></div></div>`;
  return html;
}

export function init() {
  markLive(["ptab", "teach-start", "toast", "sw:auto"]);
}
