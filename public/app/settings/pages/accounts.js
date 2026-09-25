/* Settings › accounts: bind real engine data and wire controls. Never show keys. */
import { level, E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";

let accountsData = null;

async function loadAccounts() {
  try {
    const data = await api("accounts");
    accountsData = data;
  } catch (err) {
    console.error("Failed to load accounts:", err);
    accountsData = { accounts: [] };
  }
}

function draw() {
  if (!accountsData) {
    return `<h1>Accounts</h1><p class="lede">Loading...</p>`;
  }

  const accts = accountsData.accounts || [];
  const count = accts.length;
  const statusColor = count > 0 ? '' : 'bad';

  let html = `<h1>Accounts</h1><p class="lede">Your model accounts, the order Branch uses them in, which Trunks use each, and your keepoak.com account.</p>`;
  html += `<div class="status"><span class="sdot ${statusColor}"></span><div><b>${count} account${count !== 1 ? 's' : ''} signed in</b><p>Branch never sees your passwords. Each account is billed by its own site.</p></div></div>`;

  // Account list
  html += `<div class="sec"><h2>Order Branch uses them in</h2><div class="rows">`;

  if (accts.length === 0) {
    html += `<p class="empty">No accounts connected. Add one to get started.</p>`;
  } else {
    accts.forEach((acct, i) => {
      const logo = acct.provider === 'openai' ? '#0F0F0F' :
                   acct.provider === 'anthropic' ? '#D97757' :
                   acct.provider === 'gemini' ? '#1E1F24' :
                   acct.provider === 'openrouter' ? '#6566F1' :
                   acct.provider === 'github' ? '#181717' : '#666';

      const logoSvg = acct.provider === 'openai' ? '<path d="M12 3.2l7.6 4.4v8.8L12 20.8 4.4 16.4V7.6z" fill="none" stroke="#fff" stroke-width="1.7"></path><path d="M12 7.6l3.8 2.2v4.4L12 16.4l-3.8-2.2V9.8z" fill="#fff"></path>' :
                        acct.provider === 'anthropic' ? '<path d="M12 4v16M4 12h16M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"></path>' :
                        acct.provider === 'gemini' ? '<path d="M12 3c.8 4.6 4.4 8.2 9 9-4.6.8-8.2 4.4-9 9-.8-4.6-4.4-8.2-9-9 4.6-.8 8.2-4.4 9-9z" fill="#8AB4F8"></path>' :
                        acct.provider === 'openrouter' ? '<b data-css="font:700 11px var(--sans);color:#fff">OR</b>' :
                        '<path d="M12 4a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-3.9 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.6 7.6 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.5.8.5 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 12 4z" fill="#fff"></path>';

      const statusText = i === 0 ? 'used next' : '';
      html += `<div class="prow"><span class="logo" data-css="width:32px;height:32px;background:${logo}"><svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true">${logoSvg}</svg></span>` +
              `<span class="grow"><b>${acct.label}</b><small>${acct.plan || 'Plan'} · used by anyone${i === 0 ? ', next' : ''}</small></span>`;
      if (statusText) {
        html += `<span class="pill ok">${statusText}</span>`;
      }
      html += `<button class="icon-btn" type="button" aria-label="Move up" data-act="acct-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} data-css="width:28px;height:28px"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"></path></svg></button>` +
              `<button class="icon-btn" type="button" aria-label="More for ${acct.label}" data-act="acct-menu" data-i="${i}" data-css="width:28px;height:28px"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="18" cy="12" r="1"></circle></svg></button></div>`;
    });
  }

  html += `</div><div class="acts" data-css="margin-top:12px"><button class="btn pri" type="button" data-act="addacct"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Add an account</button>` +
          `<button class="btn" type="button" data-act="addacct" data-v="openai">Another ChatGPT account</button>` +
          `<button class="btn" type="button" data-act="addacct" data-v="anthropic">Another Claude account</button></div></div>`;

  // When one runs out
  html += `<div class="sec"><h2>When one runs out</h2>` +
          `<div class="ctl"><b>Move to the next account in the list</b><input class="sw" type="checkbox" id="ac-next" checked="" aria-label="Move to the next account in the list" data-sw="set">` +
          `<small>Only between accounts you own and pay for, within each provider's terms. No account's allowance is shared with another person.</small></div>` +
          `<div class="ctl"><b>Fall back to this computer</b><input class="sw" type="checkbox" id="ac-fall" checked="" aria-label="Fall back to this computer" data-sw="set">` +
          `<small>When every account is out, keep going on Qwen3.6 35B instead of stopping.</small></div></div>`;

  // keepoak.com
  html += `<div class="sec"><h2>keepoak.com</h2><div class="ko-card"><span class="ko-mark" aria-hidden="true"></span><span class="grow"><b>Your keepoak.com account</b><small>Have a KeepOak computer or a team on keepoak.com? Connect it once.</small></span><span class="pill idle" title="Branch does not link to keepoak.com today">Proposal</span></div>` +
          `<ul class="may6"><li><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>Your KeepOak computer joins the computer switcher, with its agents.</li>` +
          `<li><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>Your theme, saved colours and season follow you between computers and keepoak.com.</li>` +
          `<li><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>Your team workspace: members, shared Trunks and what they're running.</li>` +
          `<li><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>Conversations, memory and keys stay on each computer. Nothing else is shared.</li></ul>` +
          `<div class="acts"><button class="btn pri" type="button" data-act="ko-start">Connect your keepoak.com account</button></div></div>`;

  return html;
}

export async function load() {
  await loadAccounts();
}

export function init() {
  // Set up event handlers
}

export const live = {
  // Wire up these controls
};

export function after(col) {
  // Set up control listeners after rendering
}
