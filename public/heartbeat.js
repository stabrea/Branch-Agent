/**
 * Quiet background work, in the Schedules view: the check-in card (how often, which hours, the
 * checklist), how each schedule is doing at a glance, and the owner's yes to a job's check script.
 * It only reads and writes /api/heartbeat and /api/schedules/<id>/gate, and builds its own box so
 * nothing else on the page has to know about it. Every word goes through a key.
 */
import { api, toast } from "/app.js";
import { t } from "/i18n.js";

const healthKeys = { healthy: "schedules.health.healthy", failing: "schedules.health.failing", "never-run": "schedules.health.never-run" };
let latest = null;

function node(tag, key, className) {
  const made = document.createElement(tag);
  if (key) { made.dataset.t = key; made.textContent = t(key); }
  if (className) made.className = className;
  return made;
}
function plain(tag, text, className) {
  const made = document.createElement(tag);
  made.textContent = text;
  if (className) made.className = className;
  return made;
}
function field(key, control) {
  const wrap = document.createElement("div");
  const label = node("label", key);
  label.htmlFor = control.id;
  wrap.append(label, control);
  return wrap;
}
function control(id, type, value) {
  const made = document.createElement(type === "textarea" ? "textarea" : "input");
  made.id = id;
  if (type === "checkbox") {
    made.type = "checkbox";
    made.checked = Boolean(value);
  } else {
    if (type !== "textarea") made.type = type;
    made.value = value ?? "";
  }
  return made;
}
function button(key, handler) {
  const made = node("button", key);
  made.type = "button";
  made.addEventListener("click", async () => {
    made.disabled = true;
    try { await handler(); } catch (error) { toast(error.message); } finally { made.disabled = false; }
  });
  return made;
}

/** "Healthy · 12 runs · 92% of the last 10 worked · about 3 s each". */
function healthLine(health) {
  const parts = [t(healthKeys[health.state] ?? health.state), t("schedules.health.runs", { count: health.runCount })];
  if (health.successRate !== null)
    parts.push(t("schedules.health.worked", { percent: Math.round(health.successRate * 100), recent: health.recent }));
  if (health.averageMs !== null)
    parts.push(t("schedules.health.took", { seconds: Math.max(1, Math.round(health.averageMs / 1000)) }));
  return parts.join(" · ");
}
function badge(health) {
  const made = plain("span", healthLine(health), "status-pill");
  made.dataset.health = health.state;
  return made;
}

function checkInFields(settings) {
  const fields = {
    enabled: control("heartbeat-on", "checkbox", settings.enabled),
    every: control("heartbeat-every", "number", settings.everyMinutes),
    from: control("heartbeat-from", "time", settings.activeHours?.from ?? ""),
    to: control("heartbeat-to", "time", settings.activeHours?.to ?? ""),
    zone: control("heartbeat-zone", "text", settings.timezone),
    list: control("heartbeat-list", "textarea", settings.checklist),
    second: control("heartbeat-second", "checkbox", settings.secondOpinion),
  };
  fields.every.min = "5";
  fields.list.rows = 6;
  return fields;
}
function lastWords(state) {
  if (state.lastReason) return state.lastReason;
  return state.lastOutcome ? t("schedules.checkin.last", { outcome: state.lastOutcome }) : t("schedules.checkin.none-yet");
}

function checkInCard({ settings, state, health }) {
  const card = node("form", undefined, "card");
  const fields = checkInFields(settings);
  card.append(node("h2", "schedules.checkin.title"), node("p", "schedules.checkin.intro", "subtle"),
    field("schedules.checkin.on", fields.enabled), field("schedules.checkin.every", fields.every),
    field("schedules.checkin.from", fields.from), field("schedules.checkin.to", fields.to),
    field("schedules.checkin.zone", fields.zone), field("schedules.checkin.list", fields.list),
    field("schedules.checkin.second", fields.second), badge(health), plain("p", lastWords(state), "subtle"));
  card.append(button("action.save-check-in", async () => {
    const hours = fields.from.value && fields.to.value ? { from: fields.from.value, to: fields.to.value } : null;
    await api("heartbeat", { enabled: fields.enabled.checked, everyMinutes: Number(fields.every.value), activeHours: hours,
      timezone: fields.zone.value, checklist: fields.list.value, secondOpinion: fields.second.checked, deliverTo: settings.deliverTo });
    toast(t("schedules.checkin.saved"));
    await load();
  }), button("action.check-in-now", async () => {
    const { outcome } = await api("heartbeat/check", {});
    toast(outcome === "notified" ? t("schedules.checkin.needs-you") : t("schedules.checkin.finished", { outcome }));
    await load();
  }));
  return card;
}

function scriptRow(item, row) {
  const gate = item.gate;
  const where = gate.network ? "schedules.script.internet" : "schedules.script.no-internet";
  row.append(plain("p", t("schedules.script.runs", { program: [gate.executable, ...gate.args].join(" "), where: t(where) }), "subtle"));
  if (gate.last?.reason) row.append(plain("p", t("schedules.script.last", { reason: gate.last.reason }), "subtle"));
  row.append(button(gate.approved ? "action.withdraw-script-approval" : "action.approve-check-script", async () => {
    await api(`schedules/${item.id}/gate`, { approve: !gate.approved });
    await load();
  }));
}
function scheduleRow(item) {
  const row = document.createElement("div");
  row.className = "card";
  row.append(plain("p", item.prompt), badge(item.health));
  if (item.pausedBecause && item.status === "paused") row.append(plain("p", item.pausedBecause, "subtle"));
  if (item.gate) scriptRow(item, row);
  return row;
}

function render() {
  const list = document.getElementById("schedules-list");
  if (!list || !latest) return;
  let box = document.getElementById("quiet-jobs-container");
  if (!box) {
    box = document.createElement("div");
    box.id = "quiet-jobs-container";
    list.after(box);
  }
  const health = node("div", undefined, "card");
  health.append(node("h2", "schedules.health.title"), node("p", "schedules.health.intro", "subtle"));
  if (!latest.schedules.length) health.append(node("p", "schedules.health.empty", "subtle"));
  for (const item of latest.schedules) health.append(scheduleRow(item));
  box.replaceChildren(checkInCard(latest.heartbeat), health);
}
async function load() {
  if (!document.getElementById("schedules-list")) return;
  latest = await api("heartbeat");
  render();
}

/* Words with numbers in them are written again when the language changes. */
document.addEventListener("branch-language", render);
/* A box that will not load leaves the rest of the page as it is. */
load().catch(() => {});
