/* Settings › models: bind real engine data and wire controls. */
import { esc, renderNow } from "../../core/dom.js";
import { level, E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";

let accounts = { pools: [] };

async function loadAccounts() {
  try {
    const data = await api("accounts");
    accounts = data || { pools: [] };
  } catch (err) {
    console.error("Failed to load accounts:", err);
    accounts = { pools: [] };
  }
  renderNow();
}

function getAccountsByProvider(provider) {
  if (!accounts || !accounts.pools) return [];
  const pool = accounts.pools.find(p => p.pool === provider.toLowerCase().replace(' ', ''));
  return pool?.accounts || [];
}

function renderAccountGroup(provider, logoColor, logoSvg) {
  const accts = getAccountsByProvider(provider);
  const hasAccounts = accts.length > 0;
  const poolId = provider.toLowerCase().replace(' ', '');

  let html = `<div class="acct-g"><div class="acct-gh"><span class="logo" data-css="width:30px;height:30px;background:${logoColor}"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">${logoSvg}</svg></span><b>${esc(provider)}</b><span class="n6">${hasAccounts ? `${accts.length} account${accts.length !== 1 ? 's' : ''}` : 'Not set up'}</span></div>`;

  if (hasAccounts) {
    accts.forEach((acct, i) => {
      const status = i === 0 ? 'ok' : 'idle';
      const statusText = i === 0 ? 'Answers first' : 'Next in line';
      html += `<div class="acct-r"><span class="grow"><b>${esc(acct.label || `${provider} Account ${i + 1}`)}</b><small>${esc(acct.pool)} · used by anyone</small></span><span class="pill ${status}"><i></i>${statusText}</span><button class="icon-btn" type="button" aria-label="More for ${esc(acct.label)}" data-act="acct-menu" data-i="${i}"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="18" cy="12" r="1"></circle></svg></button></div>`;
    });
    html += `<button class="add-row" type="button" data-act="addacct" data-v="${esc(poolId)}"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Add another ${esc(provider)} account</button>`;
  } else {
    html += `<button class="add-row" type="button" data-act="addacct" data-v="${esc(poolId)}"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Sign in to ${esc(provider)}</button>`;
  }

  html += `</div>`;
  return html;
}

export function draw() {
  const lv = level();

  let html = `<h1>Models</h1><p class="lede">Which models answer, and where they run.</p><div class="tabs" role="tablist"><button class="tab" role="tab" type="button" aria-selected="true" data-act="mtab" data-v="connections">Connections</button><button class="tab" role="tab" type="button" aria-selected="false" data-act="mtab" data-v="defaults">Defaults</button><button class="tab" role="tab" type="button" aria-selected="false" data-act="mtab" data-v="local">On this computer</button><button class="tab" role="tab" type="button" aria-selected="false" data-act="mtab" data-v="second">Second opinion</button><button class="tab" role="tab" type="button" aria-selected="false" data-act="mtab" data-v="media">Media</button></div><p class="hint" data-css="margin:2px 0 12px">You can sign in to the same service more than once. When one account runs low, Branch moves to the next. The order is in <button class="link" type="button" data-act="setpage" data-v="accounts">Settings › Accounts</button>.</p><div class="acct-gs">`;

  // Render account groups
  html += renderAccountGroup('ChatGPT', '#0F0F0F', '<path d="M12 3.2l7.6 4.4v8.8L12 20.8 4.4 16.4V7.6z" fill="none" stroke="#fff" stroke-width="1.7"></path><path d="M12 7.6l3.8 2.2v4.4L12 16.4l-3.8-2.2V9.8z" fill="#fff"></path>');
  html += renderAccountGroup('Claude', '#D97757', '<path d="M12 4v16M4 12h16M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"></path>');
  html += renderAccountGroup('Gemini', '#1E1F24', '<path d="M12 3c.8 4.6 4.4 8.2 9 9-4.6.8-8.2 4.4-9 9-.8-4.6-4.4-8.2-9-9 4.6-.8 8.2-4.4 9-9z" fill="#8AB4F8"></path>');
  html += renderAccountGroup('OpenRouter', '#6566F1', '<b data-css="font:700 11px var(--sans);color:#fff">OR</b>');
  html += renderAccountGroup('GitHub Copilot', '#181717', '<path d="M12 4a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-3.9 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.6 7.6 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.5.8.5 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 12 4z" fill="#fff"></path>');

  html += `</div><div class="acts" data-css="margin-top:14px"><button class="btn pri" type="button" data-act="addacct"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Add an account</button></div>`;

  // Advanced sections (only show for level >= 1)
  if (lv >= 1) {
    html += `<div class="sec x15-sec"><h2>Budgets</h2><div class="ctl"><b>Most steps in one task</b><span class="right num15"><input class="inp" value="60" aria-label="Most steps in one task"><small>steps</small></span><small>It stops and asks when it gets there.</small></div><div class="ctl"><b>Spend cap per task</b><span class="right num15"><input class="inp" value="2.00" aria-label="Spend cap per task"><small>USD</small></span><small>Only for accounts that bill per use.</small></div><div class="ctl"><b>Sub-tasks at once</b><span class="right"><span class="seg" role="group" aria-label="Sub-tasks at once"><button type="button" aria-pressed="false" data-act="seg">1</button><button type="button" aria-pressed="true" data-act="seg">3</button><button type="button" aria-pressed="false" data-act="seg">5</button></span></span><small>Parts of a big task that can run side by side.</small></div></div><div class="sec x15-sec"><h2>Models for smaller jobs</h2><div class="ctl"><b>Sub-tasks and side jobs</b><span class="right"><span class="seg" role="group" aria-label="Sub-tasks and side jobs"><button type="button" aria-pressed="false" data-act="seg">Same model</button><button type="button" aria-pressed="true" data-act="seg">Soon</button></span></span><small>Titles, summaries and searches inside a task.</small></div><div class="ctl"><b>Pick the model per task</b><input class="sw" type="checkbox" id="f15-pick-the-model-per-task" checked="" aria-label="Pick the model per task" data-sw="set"><small>Easy tasks go to a quick model, hard ones to the best you have.</small></div><div class="ctl"><b>Planning model</b><span class="right"><span class="seg" role="group" aria-label="Planning model"><button type="button" aria-pressed="true" data-act="seg">Same model</button></span></span><small>Writes the plan in Plan first.</small></div><div class="ctl"><b>Mix models on hard questions</b><input class="sw" type="checkbox" id="f15-mix-models-on-hard-questions" aria-label="Mix models on hard questions" data-sw="set"><small>Asks two and merges the best of each. Off until you choose: it doubles the cost.</small></div></div><div class="sec x15-sec"><h2>Compare models</h2><div class="ctl"><b>Model arena</b><span class="right"><button class="btn sm" type="button" data-act="soon">Open the arena</button></span><small>The same task to two models, you pick the better. Ratings build up over time.</small></div><div class="ctl"><b>Test suites</b><span class="right"><button class="btn sm" type="button" data-act="soon">See history</button></span><small>Your own tasks with a check for each, with history.</small></div></div>`;
  }

  // Technical sections (only show for level >= 2)
  if (lv >= 2) {
    html += `<div class="sec x15-sec"><h2>Retries and timeouts</h2><div class="ctl"><b>Retries when a service fails</b><span class="right num15"><input class="inp" value="3" aria-label="Retries when a service fails"></span><small></small></div><div class="ctl"><b>Wait for the first word</b><span class="right num15"><input class="inp" value="60" aria-label="Wait for the first word"><small>s</small></span><small>Then it tries the next account.</small></div><div class="ctl"><b>Model rounds per step</b><span class="right num15"><input class="inp" value="25" aria-label="Model rounds per step"></span><small></small></div><div class="ctl"><b>Tool and command timeout</b><span class="right num15"><input class="inp" value="120" aria-label="Tool and command timeout"><small>s</small></span><small></small></div><div class="ctl"><b>Largest tool answer kept whole</b><span class="right num15"><input class="inp" value="32" aria-label="Largest tool answer kept whole"><small>KB</small></span><small>Bigger answers are saved to a file and summarised.</small></div></div><div class="sec x15-sec"><h2>Per connection</h2><div class="ctl"><b>Thinking effort</b><span class="right"><span class="seg" role="group" aria-label="Thinking effort"><button type="button" aria-pressed="false" data-act="seg">Low</button><button type="button" aria-pressed="true" data-act="seg">Medium</button><button type="button" aria-pressed="false" data-act="seg">High</button></span></span><small>For the connection in use; others keep their own.</small></div><div class="ctl"><b>Service tier</b><span class="right"><span class="seg" role="group" aria-label="Service tier"><button type="button" aria-pressed="true" data-act="seg">Standard</button><button type="button" aria-pressed="false" data-act="seg">Priority</button><button type="button" aria-pressed="false" data-act="seg">Flex</button></span></span><small>Priority costs more; flex is cheaper and slower.</small></div><div class="ctl"><b>Slow down near a rate limit</b><input class="sw" type="checkbox" id="f15-slow-down-near-a-rate-limit" checked="" aria-label="Slow down near a rate limit" data-sw="set"><small>Spreads requests out instead of hitting the wall.</small></div><div class="ctl"><b>Keep Claude's cache warm</b><input class="sw" type="checkbox" id="f15-keep-claude-s-cache-warm" checked="" aria-label="Keep Claude's cache warm" data-sw="set"><small>A tiny request every 4 minutes during long tasks, so repeats cost less. On because a Claude account is connected.</small></div><div class="ctl"><b>OpenRouter picks</b><span class="right"><span class="seg" role="group" aria-label="OpenRouter picks"><button type="button" aria-pressed="true" data-act="seg">Cheapest</button><button type="button" aria-pressed="false" data-act="seg">Fastest</button><button type="button" aria-pressed="false" data-act="seg">Only ones I list</button></span></span><small>Which provider serves an OpenRouter model.</small></div><div class="ctl"><b>Fewer rounds</b><input class="sw" type="checkbox" id="f15-fewer-rounds" checked="" aria-label="Fewer rounds" data-sw="set"><small>Groups tool calls that don't depend on each other.</small></div></div>`;
  }

  return html;
}

export function init() {
  loadAccounts();
  on("mtab", (el) => {
    const tab = el.dataset.v;
    if (tab) {
      // Switch tab view - window state only
      const tabs = document.querySelectorAll('[data-act="mtab"]');
      tabs.forEach(t => t.setAttribute('aria-selected', t.dataset.v === tab ? 'true' : 'false'));
    }
  });
  on("addacct", (el) => {
    // addacct triggers the add account flow from flows/account.js
  });
  on("acct-menu", (el) => {
    // Account menu for managing accounts
  });
  markLive(["mtab"]);
}

export async function load() {
  await loadAccounts();
}

export const live = {
  "mtab": false  // Window state only
};

export function after(col) {
  // Wire up controls after DOM is rendered
}
