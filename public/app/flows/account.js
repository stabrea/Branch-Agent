/* Account wizard: sign into a model provider or add an API key. */

import { $, esc, applyCss, paint } from "../core/dom.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";

let providers = null;

export function init() {
  markLive(["addacct", "aa-prov", "aa-back", "aa-key", "aa-nm", "aa-tr", "aa-pos", "aa-done"]);
  on("addacct", (el) => addAcct(el.dataset.v || null));
  on("aa-prov", (el) => { S.addAcct.prov = el.dataset.v; S.addAcct.step = 2; drawAddAcct(); });
  on("aa-back", () => { S.addAcct.step = 1; S.addAcct.prov = null; drawAddAcct(); });
  on("aa-key", () => { S.addAcct.step = 3; drawAddAcct(); });
  on("aa-nm", (el) => { const i = $("#aa-name"); if (i) i.value = el.dataset.v; });
  on("aa-tr", (el) => { 
    const d = S.addAcct, v = el.dataset.v;
    d.trunks = d.trunks.includes(v) ? d.trunks.filter(x => x !== v) : [...d.trunks, v];
    drawAddAcct();
  });
  on("aa-pos", (el) => { S.addAcct.pos = el.dataset.v; drawAddAcct(); });
  on("aa-done", () => finishAcct());
}

export function openAddAcct(prov = null) { addAcct(prov); }

async function addAcct(prov) {
  if (!providers) providers = await api("providers/catalog").catch(() => ({}));
  S.addAcct = { step: prov ? 2 : 1, prov: prov || null, name: "", trunks: [], pos: "last" };
  drawAddAcct();
}

function drawAddAcct() {
  const d = S.addAcct, p = d.prov && providers?.[d.prov];
  if (!p) return;
  let body = "";

  if (d.step === 1) {
    body = `<p style="margin:0 0 10px">Which service is the new account with? You can have several accounts with each one.</p>
      <div class="provs">${Object.entries(providers || {})
        .map(([k, x]) => `<button class="prov" type="button" data-act="aa-prov" data-v="${k}">
          <span class="logo" style="font-size:24px">${x.icon || "🔑"}</span>
          <b>${esc(x.name)}</b>
          <small>${x.shape || ""}</small>
        </button>`).join("")}
      </div>`;
  } else if (d.step === 2) {
    body = `<p>Paste the key from ${esc(p.signUp || p.name)}. It goes straight into your password manager; Branch shows only the last four characters after this.</p>
      <label class="fld" style="margin-top:10px"><span>Key</span>
      <input class="inp" id="aa-key" type="password" autocomplete="off" placeholder="sk-or-…" aria-label="Key">
      </label>`;
  } else if (d.step === 3) {
    const trunkList = E.trunks || [];
    body = `<div style="display:flex;gap:10px;margin-bottom:10px">
      <span class="pill ok"><i></i>Connected</span>
    </div>
    <label class="fld"><span>Call it</span>
    <input class="inp" id="aa-name" maxlength="40" aria-label="Account name">
    </label>
    <div class="fld"><span>Which Trunks use it</span>
    <span class="acts" style="gap:6px">${
      trunkList.map(t => `<button class="chip6" type="button" data-act="aa-tr" data-v="${esc(t.id)}" aria-pressed="${d.trunks.includes(t.id)}">${esc(t.name || t.id)}</button>`).join("")
    }</span></div>
    <div class="fld"><span>Where it goes in the order</span>
    <button class="chip6" type="button" data-act="aa-pos" data-v="first" aria-pressed="${d.pos === "first"}">First</button>
    <button class="chip6" type="button" data-act="aa-pos" data-v="last" aria-pressed="${d.pos === "last"}">Last</button>
    </div>`;
  }

  const dots = `<div class="wiz-dots" style="display:flex;gap:6px;margin-bottom:16px">${
    [1, 2, 3].map(i => `<i style="width:6px;height:6px;border-radius:50%;background:${i <= d.step ? "var(--accent)" : "var(--line)"};display:inline-block"></i>`).join("")
  }</div>`;

  const foot = d.step === 1 
    ? '<button class="btn ghost" data-act="dlg-close">Cancel</button>'
    : d.step === 2
    ? `<button class="btn ghost" data-act="aa-back">Back</button><button class="btn pri" data-act="aa-key">Add key</button>`
    : `<button class="btn ghost" data-act="aa-back">Back</button><button class="btn pri" data-act="aa-done">Add account</button>`;

  openDlg({
    title: d.step === 1 ? "Add an account" : `Add a ${esc(p.name)} account`,
    body: dots + body,
    foot
  });
}

async function finishAcct() {
  const d = S.addAcct, p = providers?.[d.prov];
  const name = ($("#aa-name")?.value || `${p.name}`).trim().slice(0, 40);
  try {
    await api("providers/test", { provider: d.prov, name, key: $("#aa-key")?.value }, "POST");
    S.addAcct = null;
    closeDlg();
    toast(`${name} is added. It's ready to use.`);
  } catch (e) {
    toast(`Failed to add account: ${e.message || "Unknown error"}`);
  }
}
