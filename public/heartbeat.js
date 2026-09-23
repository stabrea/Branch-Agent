/**
 * Quiet background work, in the Schedules view: the check-in card (how often, which hours, the
 * checklist), how each schedule is doing at a glance, and the owner's yes to a job's check script.
 * It only reads and writes /api/heartbeat and /api/schedules/<id>/gate. Each card names its home
 * (docs/places.md) and nothing else on the page has to know about it. Every word goes through a key.
 */
import { api, toast } from "/app.js";
import { t } from "/i18n.js";
import { segmented } from "/control-makers.js";

const healthKeys = { healthy: "schedules.health.healthy", failing: "schedules.health.failing", "never-run": "schedules.health.never-run", held: "schedules.health.held" };
const modeKeys = { off: "schedules.switch.off", on: "schedules.switch.on", "when-needed": "schedules.switch.when-needed" };
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
function button(key, handler, className) {
  const made = node("button", key, className);
  made.type = "button";
  made.addEventListener("click", async () => {
    made.disabled = true;
    /* The card stays as it is until the save has landed: cleared first, the window's refresh could
       redraw it from the old answer while the save was still on its way (ci-flakes-3). */
    try {
      await handler();
      delete made.closest("section")?.dataset.editing;
    } catch (error) { toast(error.message); } finally { made.disabled = false; }
  });
  return made;
}

/** "Healthy · 12 runs · 92% of the last 10 worked · about 3 s each". */
function healthLine(health) {
  const parts = [health.heldBecause ? `${t(healthKeys.held)}: ${health.heldBecause}` : t(healthKeys[health.state] ?? health.state), t("schedules.health.runs", { count: health.runCount })];
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

function checkInFields(settings, mode) {
  const fields = {
    mode: modeSelect("heartbeat-mode", mode),
    every: control("heartbeat-every", "number", settings.everyMinutes),
    from: control("heartbeat-from", "time", settings.activeHours?.from ?? ""),
    to: control("heartbeat-to", "time", settings.activeHours?.to ?? ""),
    zone: control("heartbeat-zone", "text", settings.timezone),
    list: control("heartbeat-list", "textarea", settings.checklist),
  };
  fields.every.min = "5";
  fields.list.rows = 6;
  return fields;
}
function lastWords(state) {
  if (state.lastReason) return state.lastReason;
  return state.lastOutcome ? t("schedules.checkin.last", { outcome: state.lastOutcome }) : t("schedules.checkin.none-yet");
}
function modeSelect(id, value) {
  const select = segmented({
    id: id,
    options: [["off", modeKeys.off], ["on", modeKeys.on], ["when-needed", modeKeys["when-needed"]]],
    value: value
  });
  return select;
}

/**
 * Where the checklist comes from: HEARTBEAT.md in the workspace, or the list typed here. The one
 * switch for that file is Legion's "What to check when it wakes" card (#context-heartbeat), in the
 * same place; this card only says what it chose and points there.
 */
function fileLink() {
  const link = node("a", "schedules.checkin.file-link");
  link.href = "#context-heartbeat";
  link.addEventListener("click", (event) => {
    const target = document.getElementById("context-heartbeat");
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ block: "nearest" });
    document.getElementById("context-switch-heartbeat")?.focus();
  });
  return link;
}
function fileWords(file) {
  if (!file || file.setting === "off") return t("schedules.checkin.file-off");
  if (file.outcome === "not trusted") return t("schedules.checkin.file-untrusted");
  return file.name ? t("schedules.checkin.file-found", { name: file.name }) : t("schedules.checkin.file-missing");
}
/* automations:scheduled — the check-in itself, beside the HEARTBEAT.md switch it reads from (not a second copy of it). */
function fillCheckIn(card, { settings, mode, state, health }, switches, file) {
  const fields = checkInFields(settings, switches.checkIn ?? mode);
  const source = plain("p", fileWords(file), "subtle");
  source.append(" ", fileLink());
  card.replaceChildren(node("h2", "schedules.checkin.title"), node("p", "schedules.checkin.intro", "subtle"),
    field("schedules.switch.check-in", fields.mode), field("schedules.checkin.every", fields.every),
    field("schedules.checkin.from", fields.from), field("schedules.checkin.to", fields.to),
    field("schedules.checkin.zone", fields.zone), source, field("schedules.checkin.list", fields.list),
    badge(health), plain("p", lastWords(state), "subtle"));
  card.append(button("action.save-check-in", async () => {
    const hours = fields.from.value && fields.to.value ? { from: fields.from.value, to: fields.to.value } : null;
    await api("heartbeat/switches", { checkIn: fields.mode.value });
    await api("heartbeat", { ...settings, everyMinutes: Number(fields.every.value), activeHours: hours,
      timezone: fields.zone.value, checklist: fields.list.value });
    toast(t("schedules.checkin.saved"));
    await load();
  }), button("action.check-in-now", async () => {
    const { outcome } = await api("heartbeat/check", {});
    toast(outcome === "notified" ? t("schedules.checkin.needs-you") : t("schedules.checkin.finished", { outcome }));
    await load();
  }, "quiet-button"));
}

function scriptRow(item, row) {
  const gate = item.gate;
  const where = gate.network ? "schedules.script.internet" : "schedules.script.no-internet";
  row.append(plain("p", t("schedules.script.runs", { program: [gate.executable, ...gate.args].join(" "), where: t(where) }), "subtle"));
  if (gate.last?.reason) row.append(plain("p", t("schedules.script.last", { reason: gate.last.reason }), "subtle"));
  row.append(button(gate.approved ? "action.withdraw-script-approval" : "action.approve-check-script", async () => {
    await api(`schedules/${item.id}/gate`, { approve: !gate.approved });
    await load();
  }, "text-button"));
}
function scheduleRow(item) {
  const row = document.createElement("div");
  row.append(plain("p", item.prompt), badge(item.health));
  if (item.pausedBecause && item.status === "paused") row.append(plain("p", item.pausedBecause, "subtle"));
  if (item.gate) scriptRow(item, row);
  return row;
}
/* automations:scheduled — how each schedule is doing, and whether check scripts may run. */
function fillHealth(card, schedules, switches) {
  const scripts = modeSelect("quiet-switch-scripts", switches.scriptGates);
  card.replaceChildren(node("h2", "schedules.health.title"), node("p", "schedules.health.intro", "subtle"),
    field("schedules.switch.scripts", scripts));
  if (!schedules.length) card.append(node("p", "schedules.health.empty", "subtle"));
  for (const item of schedules) card.append(scheduleRow(item));
  card.append(button("action.save", async () => {
    await api("heartbeat/switches", { scriptGates: scripts.value });
    toast(t("schedules.switch.saved"));
    await load();
  }));
}
/* settings:notifications — when background work may interrupt the owner. */
function fillInterruptions(card, settings, switches) {
  const gate = modeSelect("quiet-switch-news", switches.notifyGate);
  const second = control("heartbeat-second", "checkbox", settings.secondOpinion);
  card.replaceChildren(node("h2", "schedules.switch.title"), node("p", "schedules.switch.intro", "subtle"),
    field("schedules.switch.news-only", gate), field("schedules.checkin.second", second));
  card.append(button("action.save", async () => {
    await api("heartbeat/switches", { notifyGate: gate.value });
    await api("heartbeat", { ...settings, secondOpinion: second.checked });
    toast(t("schedules.switch.saved"));
    await load();
  }));
}

/** One saved feed address, with a way to drop it before saving. */
function feedRow(card, feeds, url) {
  const row = document.createElement("div");
  const remove = node("button", "schedules.brief.remove", "text-button");
  remove.type = "button";
  remove.addEventListener("click", () => {
    feeds.splice(feeds.indexOf(url), 1);
    card.dataset.editing = "1";
    fillBriefNews(card, { newsFeeds: feeds });
  });
  row.append(plain("span", url), remove);
  return row;
}
/*
 * automations:scheduled — the owner's own RSS/Atom feed addresses the brief's "In the news" section
 * reads. Add and remove only change what is typed on the page; nothing is saved until "Save", which
 * posts the whole list to POST /api/brief (the same route brief.configure already validates: an
 * address that is not http:// or https:// is refused there, and the refusal is shown as a toast).
 */
function fillBriefNews(card, settings) {
  const feeds = [...(settings?.newsFeeds ?? [])];
  card.replaceChildren(node("h2", "schedules.brief.title"), node("p", "schedules.brief.intro", "subtle"));
  if (!feeds.length) card.append(plain("p", t("schedules.brief.empty"), "subtle"));
  for (const url of feeds) card.append(feedRow(card, feeds, url));
  const input = control("brief-feed-url", "url", "");
  card.append(field("schedules.brief.add-label", input));
  const add = node("button", "schedules.brief.add", "quiet-button");
  add.type = "button";
  add.addEventListener("click", () => {
    const value = input.value.trim();
    if (!value) return;
    feeds.push(value);
    input.value = "";
    card.dataset.editing = "1";
    fillBriefNews(card, { newsFeeds: feeds });
  });
  card.append(add);
  card.append(button("action.save", async () => {
    await api("brief", { newsFeeds: feeds });
    toast(t("schedules.brief.saved"));
    await load();
  }));
}

/**
 * A card that says where it lives (docs/places.md). The window's layout moves it home; until that
 * layout is on the page it sits with the schedules, where these used to be.
 */
function homedCard(id, home) {
  const found = document.getElementById(id);
  if (found) return found;
  const card = document.createElement("section");
  card.id = id;
  card.className = "card";
  card.dataset.home = home;
  /* A card being changed is not redrawn under the owner's hands until it is saved. */
  card.addEventListener("input", () => { card.dataset.editing = "1"; });
  card.addEventListener("change", () => { card.dataset.editing = "1"; });
  const list = document.getElementById("schedules-list");
  const after = { "quiet-checkin": "schedules-list", "quiet-health": "quiet-checkin", "quiet-interruptions": "quiet-health", "brief-news-card": "quiet-interruptions" }[id];
  if (list) (document.getElementById(after) ?? list).after(card);
  else document.body.append(card);
  return card;
}
function fill(id, home, draw) {
  const card = homedCard(id, home);
  if (!card.dataset.editing) draw(card);
}
function render() {
  if (!latest) return;
  const { switches, heartbeat, schedules, file, brief } = latest;
  fill("quiet-checkin", "automations:scheduled", (card) => fillCheckIn(card, heartbeat, switches, file));
  fill("quiet-health", "automations:scheduled", (card) => fillHealth(card, schedules, switches));
  fill("quiet-interruptions", "settings:notifications", (card) => fillInterruptions(card, heartbeat.settings, switches));
  fill("brief-news-card", "automations:scheduled", (card) => fillBriefNews(card, brief?.settings));
}
async function load() {
  const [overview, files, brief] = await Promise.all([api("heartbeat"), api("context-files").catch(() => null), api("brief").catch(() => null)]);
  latest = { ...overview, file: files?.files?.find((entry) => entry.key === "heartbeat") ?? null, brief };
  render();
}

/* Words with numbers in them are written again when the language changes. */
document.addEventListener("branch-language", render);
/* A card that will not load leaves the rest of the page as it is. Before signing in there is nothing
   to read, so the cards are filled again whenever the owner opens one of their homes. */
const homes = "[data-view='schedules'], [data-place='automations'], .lx-gear, .lx-settings-link[data-page='notifications']";
const loadWhenSignedIn = () => {
  if (!sessionStorage.getItem("branch-token")) return;
  load().catch(() => {});
};
globalThis.branchHeartbeatReady = loadWhenSignedIn;
loadWhenSignedIn();
document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest(homes) || event.target.closest("[data-target='automations']")) loadWhenSignedIn();
  /* The HEARTBEAT.md switch is saved by its own card; read back what it chose once that save is done. */
  if (event.target.closest("#context-heartbeat button")) setTimeout(() => load().catch(() => {}), 500);
});
