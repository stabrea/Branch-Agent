/* Automations, pass 17 (patch17b.js, SHOWCASE17 rows 8, 10, 14, 16, 17, 165, 167 and 168).
   - Scheduled › Standing orders and loops: the owner's standing orders (GET /api/autonomy/orders), each paused or kept
     again (POST /api/autonomy/orders/<id>/pause|resume, which the engine refuses in its own words while standing orders
     are switched off), and each conversation's /loop or /heartbeat (GET /api/autonomy/loops), stopped with POST
     /api/autonomy/loops/stop. A stopped loop only starts again from /loop in its conversation, so Start stays greyed, and
     so does "Add it": a standing order needs a start the engine can read, and nothing turns words into one yet.
   - Scheduled › Running on its own, more (Advanced): Pause all (POST /api/dashboard/automations, whose paused record is in
     GET /api/dashboard; the engine refuses both while the dashboard is off, and says so), then what an automation needs
     before it runs alone (GET /api/autonomy/readiness) and the ledger of what it decided (GET /api/autonomy/ledger), the
     days off schedules skip (GET /api/calendar), watches (GET /api/monitors), leads (GET /api/asks/leads) and forecasts
     (GET /api/asks/forecasts). Adding a day off or a watch, exporting leads and saving a forecast stay greyed.
   - Triggers › Hooks (Advanced): addresses told when something happens (GET /api/webhooks) and the owner's hooks
     (GET /api/hooks). Sending a test reaches another computer and switching a hook on runs a program here, so both stay
     greyed for the security review; the engine has no route that runs the hook checks. */

import { esc, renderNow } from "../core/dom.js";
import { level } from "../core/state.js";
import { av, ic, toast, openDlg } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { pill17, btn17 } from "./parts17.js";
import { onDemo17, demoPlace17, demoDlg17 } from "./demo17.js";

const A = { orders: [], loops: [], paused: null, pauseKnown: false };

/* ---------- standing orders and loops ---------- */
const gap = (ms) => { const m = Math.round(Number(ms) / 60000); return m % 60 ? `${m}m` : `${m / 60}h`; };
function orderRow(o) {
  const kept = o.status === "active";
  return `<div class="prow">${av({ kind: "main" }, 30)}<span class="grow"><b>${esc(o.order?.name)}</b><small>${esc(o.pausedBecause || o.order?.authority)}</small></span>${kept ? pill17("ok", "Keeping it") : pill17("idle", "Paused")}${btn17("orderb17", kept ? "Pause" : "Resume", `data-id="${esc(o.id)}" data-v="${kept ? "pause" : "resume"}"`, "btn ghost sm")}</div>`;
}
function loopRow(l) {
  const going = l.status !== "done";
  const button = going ? btn17("loopb17", "Stop", `data-v="${esc(l.kind)}" data-id="${esc(l.sessionId)}"`, "btn ghost sm") : btn17("loopstartb17", "Start", "", "btn ghost sm");
  return `<div class="prow">${av({ kind: "main" }, 30)}<span class="grow"><b><code class="code15">/${esc(l.kind)} ${esc(gap(l.everyMs))} ${esc(l.prompt)}</code></b><small>${esc(l.note)}</small></span>${going ? pill17("work", "Looping") : pill17("idle", "Stopped")}${button}</div>`;
}
export const ordersSection = () => `<div class="sec x15-sec orders-b17"><div class="sec-h15"><h2>Standing orders and loops</h2><button type="button" class="link15" data-act="ordersb17">How they work</button></div><div class="rows">${A.orders.map(orderRow).join("")}${A.loops.map(loopRow).join("")}</div></div>`;

function ordersDlg() {
  const rows = A.orders.map((o) => `<div class="prow">${av({ kind: "main" }, 28)}<span class="grow"><b>${esc(o.order?.name)}</b><small>${esc(o.order?.authority)}</small><small class="how-b17">${esc((o.order?.escalation ?? []).join(" · "))}</small></span></div>`).join("");
  openDlg({ title: "Standing orders and loops",
    body: `<p class="lead-b17">A standing order is a rule a Trunk keeps: when something happens, it does something. When it reaches its escalate line, it pauses and asks you.</p><div class="rows">${rows}</div><p class="lead-b17">A loop repeats a prompt on a clock until you stop it: <code class="code15">/loop 10m check the build</code>.</p><div class="ctl"><b>New standing order</b><span class="right"><input class="inp" id="order-in-b17" placeholder="When…, do…" aria-label="New standing order"></span><small>Say it in words; Branch writes the rule and shows it before it starts.</small></div>`,
    foot: '<button class="btn ghost" type="button" data-act="dlg-close">Close</button><button class="btn pri" type="button" data-act="orderaddb17">Add it</button>' });
}

async function changeOrder(el) {
  el.disabled = true;
  try { await api(`autonomy/orders/${encodeURIComponent(el.dataset.id)}/${el.dataset.v === "pause" ? "pause" : "resume"}`, {}); } catch (error) { toast(error.message); }
  await readKept();
  renderNow();
}
async function stopLoop(el) {
  el.disabled = true;
  try { await api("autonomy/loops/stop", { kind: el.dataset.v, sessionId: el.dataset.id }); } catch (error) { toast(error.message); }
  await readKept();
  renderNow();
}

/* ---------- running on its own, more ---------- */
function pauseRow() {
  const p = Boolean(A.paused);
  return `<div class="prow"><span class="ico-tile">${ic("pause", "s")}</span><span class="grow"><b>${p ? "Every automation is paused" : "Pause every automation"}</b><small>${p ? "Schedules, triggers, check-ins and standing orders wait until you resume." : "One switch for schedules, triggers, check-ins and standing orders."}</small></span>${btn17("pauseallb17", p ? "Resume all" : "Pause all", `data-v="${p ? "resume" : "pause"}"`)}</div>`;
}
const DEMOS = [
  ["readiness", "check", ["Ready to run alone?", "Checks what an automation needs before it runs unattended, and keeps a ledger of what it decided alone.", "Check"]],
  ["holidays", "clock", ["Days off and holidays", "Schedules skip or move around the days you mark. Public holidays are filled in.", "See the calendar"]],
  ["watches", "eye", ["Watches", "A Trunk keeps an eye on a page, a price or a folder and speaks up when it changes.", "See"]],
  ["leads", "users", ["Leads", "A list a Trunk keeps up to date, such as suppliers to call back, and can export.", "Open the list"]],
  ["forecast", "spark", ["Forecasts", "A figure it projects from what it already knows, with how sure it is.", "See one"]],
];
export const onItsOwnSection = () => (level() >= 1 ? `<div class="sec x15-sec"><h2>Running on its own, more</h2><div class="rows">${pauseRow()}${DEMOS.map(([k, i, w]) => demoPlace17(k, i, w)).join("")}</div></div>` : "");

async function pauseAll(el) {
  el.disabled = true;
  try { await api("dashboard/automations", { paused: el.dataset.v === "pause" }); } catch (error) { toast(error.message); }
  await readPaused();
  renderNow();
}

/* ---------- triggers › hooks ---------- */
const HOOKS = [
  ["outhook", "globe", ["Tell another app when something happens", "An address Branch calls when a task finishes, needs you, or fails.", "Add one"]],
  ["hooks", "term", ["Before and after each step", "A script of yours that runs when a task starts, before a tool runs, or when it ends.", "See hooks"]],
  ["turnhook", "chat", ["After each answer", "Runs something every time a Trunk finishes a reply, such as copying it to your notes.", "Set one up"]],
];
export const hooksSection = () => (level() >= 1 ? `<div class="sec x15-sec"><h2>Hooks</h2><div class="rows">${HOOKS.map(([k, i, w]) => demoPlace17(k, i, w)).join("")}</div></div>` : "");

const onOff = (on) => (on ? ["ok", "On"] : ["idle", "Off"]);
const dayWords = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

function registerDemos() {
  onDemo17("readiness", { open: async () => {
    const { skills } = await api("autonomy/readiness");
    demoDlg17("readiness", { title: "Ready to run alone?", go: "Open the ledger",
      rows: skills.map((s) => [s.name, (s.missing ?? []).map((m) => m.fix || m.name).join(" · "), s.ready ? ["ok", "Ready"] : null]) });
  }, go: async () => {
    const { entries } = await api("autonomy/ledger?status=all");
    demoDlg17("ledger", { title: "Ready to run alone?", lead: "The ledger lists every choice an automation made without you, newest first.", rows: entries.map((e) => [e.title, e.detail, ["idle", e.status]]) });
  } });
  onDemo17("holidays", { open: async () => {
    const { settings } = await api("calendar");
    demoDlg17("holidays", { title: "Days off and holidays", lead: "Coming up:", go: "Add a day off", rows: (settings?.daysOff ?? []).map((d) => [dayWords(d), "", ["idle", "Skips"]]) });
  } });
  onDemo17("watches", { open: async () => {
    const { monitors } = await api("monitors");
    demoDlg17("watches", { title: "Watches", lead: "What your Trunks are watching:", go: "Add a watch", rows: monitors.map((m) => [m.label || m.target, m.target, ["ok", "Watching"]]) });
  } });
  onDemo17("leads", { open: async () => {
    const { top } = await api("asks/leads");
    demoDlg17("leads", { title: "Leads", go: "Export as CSV", rows: top.map((l) => [l.name, l.company, ["idle", "Open"]]) });
  } });
  onDemo17("forecast", { open: async () => {
    const { open } = await api("asks/forecasts");
    demoDlg17("forecast", { title: "Forecasts", go: "Save to Library", rows: open.map((f) => [f.question, f.resolveBy ? dayWords(f.resolveBy.slice(0, 10)) : "", ["idle", `${Math.round(f.probability * 100)}%`]]) });
  } });
  onDemo17("outhook", { open: async () => {
    const { webhooks } = await api("webhooks");
    demoDlg17("outhook", { title: "Tell another app when something happens", lead: "Branch sends a short message to this address:", go: "Send a test",
      rows: webhooks.map((w) => [w.name, [w.url, (w.events ?? []).join(", ")].filter(Boolean).join(" · "), onOff(w.enabled !== false)]) });
  } });
  onDemo17("hooks", { open: async () => {
    const { hooks } = await api("hooks");
    demoDlg17("hooks", { title: "Before and after each step", lead: "Hooks on this computer:", go: "Run the checks", rows: hooks.map((h) => [h.event, h.executable, onOff(h.enabled)]) });
  } });
  onDemo17("turnhook", { open: async () => {
    const { hooks } = await api("hooks");
    demoDlg17("turnhook", { title: "After each answer", go: "Turn it on", rows: hooks.filter((h) => h.event === "run.finished").map((h) => [h.executable, h.lastError ?? "", onOff(h.enabled)]) });
  } });
}

/* ---------- reading ---------- */
async function readKept() {
  const [orders, loops] = await Promise.all([api("autonomy/orders"), api("autonomy/loops")]);
  A.orders = orders.orders ?? [];
  A.loops = loops.loops ?? [];
}
/* The paused record lives in the dashboard's summary; with the dashboard off the engine refuses it, and Pause all says
   the engine's words when pressed. */
async function readPaused() {
  try { A.paused = (await api("dashboard")).paused ?? null; } catch { A.paused = null; }
  A.pauseKnown = true;
}

export async function readAutomations17(tab) {
  if (tab !== "scheduled") return { changed: false };
  const before = JSON.stringify(A);
  try {
    await readKept();
    if (level() >= 1) await readPaused();
  } catch (error) { return { changed: false, error }; }
  return { changed: JSON.stringify(A) !== before };
}

export function initAutomations17() {
  markLive(["ordersb17", "orderb17", "loopb17", "pauseallb17"]);
  on("ordersb17", () => ordersDlg());
  on("orderb17", (el) => changeOrder(el));
  on("loopb17", (el) => stopLoop(el));
  on("pauseallb17", (el) => pauseAll(el));
  registerDemos();
}
