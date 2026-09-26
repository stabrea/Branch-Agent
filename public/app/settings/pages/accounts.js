/* Settings › Accounts: the engine's accounts in the order it uses them (GET /api/accounts), moving one up, the account
   menu (flows/account.js) and, at Advanced, selecting several and acting on all of them. Never shows a key. */
import { level } from "../../core/state.js";
import { esc, renderNow } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { ic, toast } from "../../core/ui.js";
import { logo } from "../../core/logos.js";
import { A, allAccounts, loadAccounts, ownerOnly } from "../../flows/account.js";

/* Which accounts are ticked while "Select several" is on (window state), by pool and id; null when it is off. */
let picked = null;
const key = (a) => `${a.pool}/${a.id}`;

export function load() { return loadAccounts(); }

function row(a, i, list) {
  const ids = `data-pool="${esc(a.pool)}" data-id="${esc(a.id)}"`;
  const tick = picked ? `<input type="checkbox" class="chk15" data-sw="acc15" data-acc15="${esc(key(a))}" ${picked.includes(key(a)) ? "checked" : ""} aria-label="Select ${esc(a.label)}">` : "";
  const top = i === 0 || list[i - 1].pool !== a.pool;
  return `<div class="prow">${tick}${logo(a.pool, a.poolName, 32)}<span class="grow"><b>${esc(a.label)}</b><small>${esc(a.poolName)}</small></span>${a.first ? '<span class="pill ok">used next</span>' : ""}`
    + `<button class="icon-btn" type="button" aria-label="Move up" data-act="acct-up" ${ids} ${top ? "disabled" : ownerOnly()} data-css="width:28px;height:28px">${ic("up", "s")}</button>`
    + `<button class="icon-btn" type="button" aria-label="More for ${esc(a.label)}" data-act="acct-menu" ${ids} data-css="width:28px;height:28px">${ic("more", "s")}</button></div>`;
}

function bulkBar() {
  if (!picked) return "";
  const n = picked.length, off = n ? ownerOnly() : "disabled";
  return `<div class="bulk15" role="toolbar" aria-label="With the selected accounts"><b>${n ? `${n} selected` : "Tick the accounts"}</b><span class="grow"></span><button class="btn ghost sm" type="button" data-act="acbulk15" data-v="top" ${off}>Move to the top</button><button class="btn ghost sm" type="button" data-act="acbulk15" data-v="pause" ${off}>Pause</button><button class="btn ghost sm danger15" type="button" data-act="acbulk15" data-v="remove" ${off}>Sign out</button></div>`;
}

export function draw() {
  const list = allAccounts();
  const lev = level();
  if (lev < 1) picked = null;
  let html = `<h1>Accounts</h1><p class="lede">Your model accounts, the order Branch uses them in, which Trunks use each, and your keepoak.com account.</p>`;
  if (A.view) html += `<div class="status"><span class="sdot ${list.length ? "" : "bad"}"></span><div><b>${list.length} accounts signed in</b><p>Branch never sees your passwords. Each account is billed by its own site.</p></div></div>`;
  /* Every change here is the owner's (the engine refuses a household person), so on a household profile they are greyed. */
  const mine = ownerOnly();
  const sel = lev >= 1 ? `<button type="button" class="link15 acsel15" data-act="acsel15" ${mine}>${picked ? "Done" : "Select several"}</button>` : "";
  html += `<div class="sec"><h2${lev >= 1 ? ' class="h2row15"' : ""}>Order Branch uses them in${sel}</h2>${bulkBar()}<div class="rows">${list.map(row).join("")}</div>`;
  html += `<div class="acts acadd-bf3" data-css="margin-top:12px"><button class="btn pri" type="button" data-act="addacct" ${mine}>${ic("plus", "s")}Add an account</button>`;
  html += (A.view?.pools ?? []).map((p) => `<button class="btn" type="button" data-act="addacct" data-v="${esc(p.pool)}" ${mine}>Another ${esc(p.name ?? p.pool)} account</button>`).join("");
  html += `</div></div>`;
  html += `<div class="sec"><h2>When one runs out</h2>`
    + `<div class="ctl"><b>Move to the next account in the list</b><input class="sw" type="checkbox" id="ac-next" aria-label="Move to the next account in the list" data-sw="set"><small>Only between accounts you own and pay for, within each provider’s terms. No account’s allowance is shared with another person.</small></div>`
    + `<div class="ctl"><b>Fall back to this computer</b><input class="sw" type="checkbox" id="ac-fall" aria-label="Fall back to this computer" data-sw="set"><small>Keeps working on the local model instead of stopping.</small></div></div>`;
  html += `<div class="sec"><h2>keepoak.com</h2><div class="ko-card"><span class="ko-mark" aria-hidden="true"></span><span class="grow"><b>Your keepoak.com account</b><small>Have a KeepOak computer or a team on keepoak.com? Connect it once.</small></span><span class="pill idle" title="Branch does not link to keepoak.com today">Proposal</span></div>`
    + `<ul class="may6"><li>${ic("check", "s")}Your KeepOak computer joins the computer switcher, with its agents.</li><li>${ic("check", "s")}Your theme, saved colours and season follow you between computers and keepoak.com.</li><li>${ic("check", "s")}Your team workspace: members, shared Trunks and what they’re running.</li><li>${ic("check", "s")}Conversations, memory and keys stay on each computer. Nothing else is shared.</li></ul>`
    + `<div class="acts"><button class="btn pri" type="button" data-act="ko-start">Connect your keepoak.com account</button></div></div>`;
  return html;
}

async function moveUp(el) {
  try { await api("accounts/update", { pool: el.dataset.pool, account: el.dataset.id, move: "up" }); } catch (error) { toast(error.message); }
  await loadAccounts();
}

/* Move to the top: the engine moves one place per request, so each ticked account climbs until only ticked ones of
   its own connection are above it. Pause: { disabled: true }. Sign out: POST /api/accounts/remove. */
async function bulk(v) {
  const chosen = allAccounts().filter((a) => picked?.includes(key(a)));
  const n = chosen.length;
  try {
    if (v === "top") await toTop(chosen);
    else for (const a of chosen) {
      await api(v === "pause" ? "accounts/update" : "accounts/remove", v === "pause" ? { pool: a.pool, account: a.id, disabled: true } : { pool: a.pool, account: a.id });
    }
    toast(v === "top" ? `Moved ${n} to the top.` : v === "pause" ? `Paused ${n}. Branch skips them until you resume.` : `Signed out of ${n}.`);
  } catch (error) { toast(error.message); }
  picked = null;
  await loadAccounts();
}

async function toTop(chosen) {
  for (const pool of new Set(chosen.map((a) => a.pool))) {
    const mine = chosen.filter((a) => a.pool === pool);
    const order = (A.view.pools.find((p) => p.pool === pool)?.accounts ?? []).map((a) => a.id);
    const wanted = mine.map((a) => a.id).sort((x, y) => order.indexOf(x) - order.indexOf(y));
    for (const [place, id] of wanted.entries()) {
      for (let at = order.indexOf(id); at > place; at--) {
        await api("accounts/update", { pool, account: id, move: "up" });
        [order[at - 1], order[at]] = [order[at], order[at - 1]];
      }
    }
  }
}

export function init() {
  load();
  on("acct-up", (el) => moveUp(el));
  on("acsel15", () => { picked = picked ? null : []; renderNow(); });
  on("acbulk15", (el) => bulk(el.dataset.v));
  document.addEventListener("change", (e) => {
    const k = e.target.dataset?.acc15;
    if (k == null || !picked) return;
    picked = e.target.checked ? [...new Set([...picked, k])] : picked.filter((x) => x !== k);
    renderNow();
  });
  markLive(["acct-up", "acsel15", "acbulk15", "sw:acc15"]);
}

export const live = { "acct-up": true, "acsel15": true, "acbulk15": true };
