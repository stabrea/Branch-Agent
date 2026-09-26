/* Set up a chat app (design doc 6.5), 1:1 with the prototype's wizard: Create, Paste, Check, Pair, Save, following each
   app's recipe from GET /api/channel-setup/<id>. POST /api/channel-setup/<id>/check checks what was pasted, saves it
   and switches the app on in one step; a six-digit code goes to POST /api/channels/pairings/approve. Pasted secrets
   live only in this module until they are sent, are never drawn back, and are cleared at once. */

import { $, esc } from "../core/dom.js";
import { openDlg, closeDlg, toast, ic } from "../core/ui.js";
import { S, E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { logo } from "../core/logos.js";
import { qr } from "../core/qr.js";

let vals = {};
const FAMILY = { core: "Popular", chat: "Work chat · webhook" };

const inputs = (c) => [...(c.fields ?? []).map((f) => ({ key: f.name, what: f.what, optional: f.optional, secret: false })),
  ...(c.paste ?? []).map((f) => ({ key: f.secret, what: f.what, optional: f.optional, secret: true }))];
const filled = (c) => inputs(c).every((f) => f.optional || (vals[f.key] ?? "").trim());

function stepsOf(c) {
  return [c.create?.url || c.steps?.length || c.create?.how ? "Create" : null, "Paste", c.hasCheck || c.noCheck ? "Check" : null, c.pairing ? "Pair" : null, "Save"].filter(Boolean);
}

function create(c) {
  const how = c.create?.how || (c.steps ?? []).join(" ") || "Make the bot or app on the service first.";
  const open = c.create?.url ? `<a class="btn pri sm" href="${esc(c.create.url)}" target="_blank" rel="noopener">${ic("globe", "s")}Open ${esc(c.name)}${c.create.prefilled ? " with Branch’s settings filled in" : ""}</a>` : "";
  const app = c.app?.download ? `<a class="btn ghost sm" href="${esc(c.app.download)}" target="_blank" rel="noopener">Get the ${esc(c.app.name || c.name)} app</a>` : "";
  const code = c.codes?.create ? `<div class="chw-qr12">${qr(c.codes.create, 148)}<small>Or scan to do this on your phone</small></div>` : "";
  return `<div class="chw-create12"><div><p>${esc(how)}</p>${c.steps?.length ? `<ol class="steps-list">${c.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}<div class="acts">${open}${app}</div></div>${code}</div>`;
}

function paste(c) {
  const rows = inputs(c).map((f) => `<label class="fld chf12"><span>${esc(f.what)}</span><span class="chf-in12"><input class="inp" data-sw="chf" data-chf="${esc(f.key)}" type="${f.secret ? "password" : "text"}" value="${f.secret ? "" : esc(vals[f.key] ?? "")}" autocomplete="off" spellcheck="false" placeholder="${f.secret ? "Paste it here" : ""}">${f.secret ? `<button type="button" class="icon-btn" data-act="chf-eye" data-k="${esc(f.key)}" aria-label="Show or hide">${ic("eye", "s")}</button>` : ""}</span></label>`).join("");
  return `<p data-css="margin:0 0 6px">Paste what ${esc(c.name)} gave you. Secrets go straight into your password manager; Branch shows only the last four characters afterwards.</p>${rows || '<p class="hint">Nothing to paste for this one.</p>'}`;
}

function check(c, w) {
  if (!c.hasCheck && !w.result && !w.error) return `<p class="hint12">${esc(c.noCheck)}</p>`;
  if (w.error) return `<div class="status"><span class="sdot bad"></span><div><b>${esc(c.name)} did not accept it</b><p>${esc(w.error)}</p></div></div>`;
  if (!w.result) return `<div class="chw-ok12 run12"><span class="spin12"></span><span><b>Checking with ${esc(c.name)}…</b><small>A read-only request, nothing is sent to anyone.</small></span></div>`;
  const said = w.result.botName ? `Found the bot: @${w.result.botName}` : w.result.checkNote || "The service accepted the details.";
  return `<div class="chw-ok12">${ic("check", "s")}<span><b>It answers.</b><small>${esc(said)}</small></span></div>`;
}

function pair(c, w) {
  return `<p data-css="margin:0 0 10px">${esc(c.pairing)}</p><div class="code12">${[0, 1, 2, 3, 4, 5].map((i) => `<input inputmode="numeric" maxlength="1" data-sw="code" data-code="${i}" value="${esc(w.code[i] ?? "")}" aria-label="Digit ${i + 1}">`).join("")}</div>${w.error ? `<p class="hint" role="alert">${esc(w.error)}</p>` : '<p class="hint">The code works once, for ten minutes, and only for the person who sent the message.</p>'}`;
}

function save(c) {
  const who = [...E.trunks.map((t) => t.name), "Branch"].map((n, i, all) => `<button type="button" data-act="chw-who" aria-pressed="${i === all.length - 1}">${esc(n)}</button>`).join("");
  const may = ["Only me", "People I approve", "Anyone in my workspace"].map((l, i) => `<button type="button" aria-pressed="${i === 0}" data-act="chw-may">${l}</button>`).join("");
  const tg = c.id === "telegram" ? `<div class="tg15"><div class="ctl"><b>Keep forum topics apart</b><input class="sw" type="checkbox" id="tg-topics15" aria-label="Keep forum topics apart" data-sw="set"><small>Each topic in a group becomes its own conversation.</small></div><div class="ctl"><b>Photos and files reach the task</b><input class="sw" type="checkbox" id="tg-media15" aria-label="Photos and files reach the task" data-sw="set"><small>What you send in Telegram is handed to the Trunk as material.</small></div></div>` : "";
  return `<div class="chw-ok12">${ic("check", "s")}<span><b>${esc(c.name)} is ready</b><small>Choose who answers there and who may use it, then save.</small></span></div>
    <div class="fld"><span>Who answers in ${esc(c.name)}</span><span class="seg">${who}</span></div>
    <div class="ctl"><b>Who may message it</b><span class="right"><span class="seg" role="group" aria-label="Who may message it">${may}</span></span><small>Everyone else gets no answer.</small></div>${tg}`;
}

const BODIES = { Create: create, Paste: paste, Check: check, Pair: pair, Save: save };

function draw() {
  const w = S.chw, c = w?.recipe;
  if (!c) return;
  const steps = stepsOf(c), cur = steps[Math.min(w.step, steps.length - 1)];
  const dots = `<div class="chw-steps12">${steps.map((s, i) => `<span class="${i < w.step ? "done" : i === w.step ? "now" : ""}"><em>${i < w.step ? "✓" : i + 1}</em>${s}</span>`).join("")}</div>`;
  const canNext = cur === "Paste" ? filled(c) : cur === "Check" ? !!w.result || (!c.hasCheck && !w.error) : cur === "Pair" ? /^\d{6}$/.test(w.code) : true;
  const back = w.step ? '<button class="btn ghost" type="button" data-act="chw-back">Back</button>' : '<button class="btn ghost" type="button" data-act="dlg-close">Cancel</button>';
  const next = cur === "Save" ? '<button class="btn pri" type="button" data-act="chw-save">Save</button>' : `<button class="btn pri" type="button" data-act="chw-next" ${canNext ? "" : "disabled"}>${cur === "Pair" ? "Approve" : "Continue"}</button>`;
  const head = `<div class="chw-head12">${logo(c.id, c.name, 40)}<span><b>${esc(c.name)}</b><small>${FAMILY[c.family] ?? "More apps"}${c.app?.name ? " · " + esc(c.app.name) : ""}</small></span></div>`;
  openDlg({ title: `${w.connected ? "Manage" : "Set up"} ${c.name}`, wide: true, body: `${head}${dots}<div class="chw-body12">${BODIES[cur](c, w)}</div>`, foot: back + next });
  if (cur === "Pair") setTimeout(() => $('.code12 input[value=""]')?.focus(), 30);
}

export async function openChatWizard(id) {
  vals = {};
  let recipe, live;
  try {
    [recipe, live] = await Promise.all([api(`channel-setup/${encodeURIComponent(id)}`), api("channels").catch(() => ({}))]);
  } catch (error) { toast(error.message); return; }
  const connected = (live.channels ?? []).some((c) => c.id === id || c.kind === id);
  S.chw = { id, recipe, connected, step: connected ? stepsOf(recipe).length - 1 : 0, result: null, error: "", code: "" };
  draw();
}

/* Check, save and switch on, in the engine's one step. Setting an app up here is asking for guided setup, so it is
   switched on first if it is off. The pasted values are cleared whatever the answer. */
async function runCheck(w) {
  const sent = vals;
  vals = {};
  try {
    if ((await api("channel-setup")).mode === "off") await api("channel-setup", { mode: "on" });
    w.result = await api(`channel-setup/${encodeURIComponent(w.id)}/check`, { values: sent, enable: "on" });
    w.error = "";
  } catch (error) { w.result = null; w.error = error.message; }
  if (S.chw === w) draw();
}

async function approve(w) {
  try {
    await api("channels/pairings/approve", { code: w.code });
    w.error = "";
    return true;
  } catch (error) { w.error = error.message; w.code = ""; draw(); return false; }
}

async function next() {
  const w = S.chw, steps = stepsOf(w.recipe), cur = steps[w.step];
  if (cur === "Pair" && !(await approve(w))) return;
  w.step = Math.min(w.step + 1, steps.length - 1);
  if (steps[w.step] === "Check") { w.result = null; w.error = ""; draw(); await runCheck(w); return; }
  draw();
}

async function finish() {
  const name = S.chw.recipe.name;
  S.chw = null;
  vals = {};
  closeDlg();
  await refresh().catch(() => {});
  toast(`${name} is connected. Messages there reach Branch.`);
}

function onInput(e) {
  const t = e.target, w = S.chw;
  if (!w) return;
  if (t.dataset.chf) {
    vals[t.dataset.chf] = t.value;
    const btn = $('.dlg [data-act="chw-next"]');
    if (btn) btn.disabled = !filled(w.recipe);
  }
  if (t.dataset.code != null) {
    const boxes = [...document.querySelectorAll(".code12 input")];
    t.value = t.value.replace(/\D/g, "").slice(-1);
    w.code = boxes.map((x) => x.value).join("");
    const btn = $('.dlg [data-act="chw-next"]');
    if (btn) btn.disabled = !/^\d{6}$/.test(w.code);
    if (t.value) boxes[+t.dataset.code + 1]?.focus();
  }
}

export function init() {
  markLive(["sw:chf", "sw:code", "ch-open", "chw-next", "chw-back", "chw-save", "chf-eye"]); // the eye shows only what the owner just pasted, never a saved secret
  on("ch-open", (el) => openChatWizard(el.dataset.v));
  on("chw-next", () => next());
  on("chw-back", () => { const w = S.chw; vals = {}; w.step = Math.max(0, w.step - 1); w.error = ""; w.result = null; draw(); });
  on("chw-save", () => finish());
  on("chf-eye", (el) => { const field = document.querySelector(`[data-chf="${CSS.escape(el.dataset.k)}"]`); if (field) field.type = field.type === "password" ? "text" : "password"; });
  document.addEventListener("input", onInput);
  document.addEventListener("paste", (e) => {
    if (e.target.dataset?.code == null || !S.chw) return;
    const digits = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
    if (!digits) return;
    e.preventDefault();
    S.chw.code = digits;
    draw();
  });
  document.addEventListener("click", (e) => { if (e.target.closest?.('[data-act="dlg-close"]')) { vals = {}; S.chw = null; } }, true);
}
