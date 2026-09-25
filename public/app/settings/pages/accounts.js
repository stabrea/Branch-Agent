/* Settings › accounts: bind real engine data and wire controls. Never show keys. */
import { level, E } from "../../core/state.js";
import { esc, render } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";

let view = null;
const flat = () => (view?.pools ?? []).flatMap((p) => p.accounts.map((a) => ({ ...a, pool: p.pool, kind: p.kind, first: p.defaultAccount === a.id })));

export async function load() {
  try { view = await api("accounts"); } catch { view = { pools: [] }; }
  render();
}

const up = '<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"></path></svg>';
const more = '<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="18" cy="12" r="1"></circle></svg>';

function row(a, i) {
  return `<div class="prow"><span class="ico-tile"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"></circle><path d="M11 12.5l8-8M16 7.5l2.5 2.5"></path></svg></span>`
    + `<span class="grow"><b>${esc(a.label)}</b><small>${esc(a.pool)}</small></span>${a.first ? '<span class="pill ok">used next</span>' : ""}`
    + `<button class="icon-btn" type="button" aria-label="Move up" data-act="acct-up" data-i="${i}" ${i === 0 ? "disabled" : ""} data-css="width:28px;height:28px">${up}</button>`
    + `<button class="icon-btn" type="button" aria-label="More for ${esc(a.label)}" data-act="acct-menu" data-i="${i}" data-css="width:28px;height:28px">${more}</button></div>`;
}

export function draw() {
  const accts = flat();
  const lev = level();
  let html = `<h1>Accounts</h1><p class="lede">Your model accounts, the order Branch uses them in, which Trunks use each, and your keepoak.com account.</p>`;

  if (view) {
    html += `<div class="status"><span class="sdot ${accts.length ? "" : "bad"}"></span><div><b>${accts.length} account${accts.length === 1 ? "" : "s"} signed in</b><p>Branch never sees your passwords. Each account is billed by its own site.</p></div></div>`;
  }

  // Accounts section - advanced level has "Select several" button
  html += `<div class="sec"><h2${lev >= 1 ? ' class="h2row15"' : ''}>Order Branch uses them in${lev >= 1 ? '<button type="button" class="link15 acsel15" data-act="acsel15">Select several</button>' : ''}</h2><div class="rows">`;
  html += accts.map(row).join("");
  html += `</div><div class="acts" data-css="margin-top:12px"><button class="btn pri" type="button" data-act="addacct"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Add an account</button>`;
  html += (view?.pools ?? []).map((p) => `<button class="btn" type="button" data-act="addacct" data-v="${esc(p.pool)}">Another ${esc(p.pool)} account</button>`).join("");
  html += `</div></div>`;

  // When one runs out
  html += `<div class="sec"><h2>When one runs out</h2>` +
          `<div class="ctl"><b>Move to the next account in the list</b><input class="sw" type="checkbox" id="ac-next" checked="" aria-label="Move to the next account in the list" data-sw="set">` +
          `<small>Only between accounts you own and pay for, within each provider's terms. No account's allowance is shared with another person.</small></div>` +
          `<div class="ctl"><b>Fall back to this computer</b><input class="sw" type="checkbox" id="ac-fall" checked="" aria-label="Fall back to this computer" data-sw="set">` +
          `<small>When every account is out, keep going on this computer instead of stopping.</small></div></div>`;

  // keepoak.com
  html += `<div class="sec"><h2>keepoak.com</h2><div class="ko-card"><span class="ko-mark" aria-hidden="true"></span><span class="grow"><b>Your keepoak.com account</b><small>Have a KeepOak computer or a team on keepoak.com? Connect it once.</small></span><span class="pill idle" title="Branch does not link to keepoak.com today">Proposal</span></div>` +
          `<ul class="may6"><li><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>Your KeepOak computer joins the computer switcher, with its agents.</li>` +
          `<li><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>Your theme, saved colours and season follow you between computers and keepoak.com.</li>` +
          `<li><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>Your team workspace: members, shared Trunks and what they're running.</li>` +
          `<li><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>Conversations, memory and keys stay on each computer. Nothing else is shared.</li></ul>` +
          `<div class="acts"><button class="btn pri" type="button" data-act="ko-start">Connect your keepoak.com account</button></div></div>`;

  return html;
}

export function init() {
  load();
}

export const live = {};

export function after(col) {
  // Set up control listeners after rendering
}
