/* Add an account (design doc 6.4), against the engine's accounts routes (src/accounts/api.ts):
   step 1 picks one of the engine's connections (GET /api/accounts → pools), step 2 names the account and, for a
   key connection, takes the key, step 3 shows what the engine saved (POST /api/accounts/add answers the pool).
   The key lives only in this module until it is sent, is never drawn back, and is cleared at once. */

import { $, esc } from "../core/dom.js";
import { openDlg, closeDlg, ic } from "../core/ui.js";
import { refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

const W = { step: 1, pools: [], pool: null, saved: null, error: "" };
let key = "";

const poolOf = (name) => W.pools.find((p) => p.pool === name);

function step1() {
  return `<p data-css="margin:0 0 10px">Which service is the new account with? You can have several accounts with each one.</p>
    <div class="provs">${W.pools.map((p) => `<button class="prov" type="button" data-act="aa-prov" data-v="${esc(p.pool)}"><span class="ico-tile">${ic("key", "s")}</span><b>${esc(p.pool)}</b><small>${p.accounts.length}</small></button>`).join("")}</div>`;
}
function step2() {
  const p = poolOf(W.pool);
  const keyField = p?.kind === "api-key" ? `<label class="fld" data-css="margin-top:10px"><span>Key</span><input class="inp" id="aa-key" type="password" autocomplete="off" aria-label="Key"></label>` : "";
  return `<label class="fld"><span>Name</span><input class="inp" id="aa-name" maxlength="60" autocomplete="off" aria-label="Name"></label>${keyField}
    ${W.error ? `<p class="hint" role="alert">${esc(W.error)}</p>` : ""}`;
}
function step3() {
  const a = W.saved;
  return `<div class="prow" data-css="border:0;padding:0 0 8px"><span class="ico-tile">${ic("key", "s")}</span><span class="grow"><b>${esc(a?.label ?? "")}</b><small>${esc(W.pool)}</small></span></div>`;
}

function draw() {
  const body = W.step === 1 ? step1() : W.step === 2 ? step2() : step3();
  const foot = W.step === 1 ? '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button>'
    : W.step === 2 ? '<button class="btn ghost" type="button" data-act="aa-back">Back</button><button class="btn pri" type="button" data-act="aa-done">Add account</button>'
    : '<button class="btn pri" type="button" data-act="dlg-close">Done</button>';
  openDlg({ title: "Add an account", body, foot, wide: W.step === 1 });
  $("#aa-name")?.focus();
}

async function open(pool = null) {
  key = "";
  const view = await api("accounts").catch(() => ({ pools: [] }));
  Object.assign(W, { step: pool ? 2 : 1, pools: view.pools ?? [], pool, saved: null, error: "" });
  draw();
}

async function finish() {
  const label = ($("#aa-name")?.value ?? "").trim();
  key = $("#aa-key")?.value ?? key;
  const p = poolOf(W.pool);
  try {
    const view = await api("accounts/add", { pool: W.pool, label, ...(p?.kind === "api-key" ? { key } : {}) });
    key = "";
    W.saved = view.accounts?.find((a) => a.label === label) ?? { label };
    W.error = "";
    W.step = 3;
    await refresh().catch(() => {});
  } catch (error) {
    key = "";
    W.error = error.message;
  }
  draw();
}

export function openAddAcct(pool = null) { return open(pool); }

export function init() {
  markLive(["addacct", "aa-prov", "aa-back", "aa-done"]);
  on("addacct", (el) => open(el.dataset.v || null));
  on("aa-prov", (el) => { W.pool = el.dataset.v; W.step = 2; W.error = ""; draw(); });
  on("aa-back", () => { key = ""; W.step = 1; W.error = ""; draw(); });
  on("aa-done", () => finish());
  document.addEventListener("click", (e) => { if (e.target.closest?.('[data-act="dlg-close"]')) key = ""; }, true);
}

export { closeDlg };
