import { t } from "./i18n.js";
/**
 * mac7/diagnostics: Settings › Advanced › Activity log, Settings › Updates & about › Report a
 * problem, and the window's own errors written to the log. Manual reports are shown in full and
 * sent only by the owner. Automatic reports are a separate, shipped-off setting: the owner chooses
 * a linked destination and report parts, sees the exact preview, then explicitly switches it on.
 */
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

/* ---------- the window's own errors ---------- */
let reported = 0;
function sendWindowError(kind, message, stack, where) {
  // A handful per page is plenty to find a cause; a loop of errors must not flood the log.
  if (++reported > 20 || !sessionStorage.getItem("branch-token")) return;
  api("diagnostics/window-error", { kind, message: String(message || "").slice(0, 2000), stack: String(stack || "").slice(0, 8000), where: String(where || "").slice(0, 200) })
    .catch(() => undefined);
}
window.addEventListener("error", (event) =>
  sendWindowError("error", event.message, event.error && event.error.stack, `${(event.filename || "").split("/").pop()}:${event.lineno || 0}`));
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  sendWindowError("unhandledrejection", reason && reason.message ? reason.message : String(reason), reason && reason.stack, "");
});

/* ---------- the activity log ---------- */
async function loadLog() {
  const status = $("activity-log-status");
  const query = new URLSearchParams();
  for (const [name, id] of [["component", "activity-log-component"], ["level", "activity-log-level"], ["task", "activity-log-task"]])
    if ($(id).value.trim()) query.set(name, $(id).value.trim());
  try {
    const data = await api("diagnostics/log?" + query.toString());
    if (document.activeElement !== $("activity-log-mode")) $("activity-log-mode").value = data.settings.mode;
    if (document.activeElement !== $("activity-log-days")) $("activity-log-days").value = String(data.settings.keepDays);
    if (document.activeElement !== $("activity-log-crashes")) $("activity-log-crashes").value = data.settings.crashCapture || "off";
    fillComponents(data.components);
    const list = $("activity-log-lines");
    list.replaceChildren(...data.lines.map(lineItem));
    status.textContent = data.lines.length ? t("activityLog.status.lines", { count: data.lines.length })
      : data.settings.mode === "off" ? t("activityLog.status.off") : t("activityLog.status.noMatch");
  } catch (e) { status.textContent = e.message; }
}
function fillComponents(names) {
  const select = $("activity-log-component");
  const chosen = select.value;
  const first = select.options[0];
  select.replaceChildren(first, ...names.map((name) => new Option(name, name)));
  select.value = names.includes(chosen) ? chosen : "";
}
function lineItem(line) {
  const item = document.createElement("li");
  item.className = `activity-log-line level-${line.level}`;
  const when = new Date(line.at).toLocaleString();
  const where = [line.taskId ? `task ${line.taskId.slice(0, 8)}` : "", line.requestId ? `request ${line.requestId}` : ""].filter(Boolean).join(", ");
  item.textContent = `${when} · ${line.level} · ${line.component} · ${line.message}${where ? ` (${where})` : ""}`;
  if (line.fields) item.title = JSON.stringify(line.fields, null, 1);
  return item;
}
async function saveLogSettings() {
  const status = $("activity-log-status");
  try {
    const saved = await api("diagnostics/log/settings", { mode: $("activity-log-mode").value, keepDays: Number($("activity-log-days").value) || 14,
      crashCapture: $("activity-log-crashes").value === "on" ? "on" : "off" });
    status.textContent = saved.mode === "off" ? t("activityLog.status.savedOff") : t("activityLog.status.savedLocal");
  } catch (e) { status.textContent = e.message; }
}
async function clearLog() {
  if (!confirm(t("activityLog.confirm.clear"))) return;
  try { await api("diagnostics/log/clear", {}); await loadLog(); } catch (e) { $("activity-log-status").textContent = e.message; }
}

/* ---------- Report a problem ---------- */
let items = [];
const removed = new Set();
async function gather() {
  const status = $("problem-report-status");
  status.textContent = t("activityLog.status.gathering");
  removed.clear();
  try {
    items = (await api("diagnostics/report", {})).items;
    renderItems();
    status.textContent = t("activityLog.status.parts", { count: items.length });
    $("problem-report-actions").hidden = false;
  } catch (e) { status.textContent = t("activityLog.status.reportFailed", { message: e.message }); }
}
function renderItems() {
  $("problem-report-items").replaceChildren(...items.map((item) => {
    const box = document.createElement("details");
    box.className = "report-item";
    if (removed.has(item.id)) box.classList.add("removed");
    const summary = document.createElement("summary");
    summary.textContent = removed.has(item.id) ? t("activityLog.item.removed", { title: item.title }) : item.title;
    const why = document.createElement("p");
    why.className = "subtle";
    why.textContent = item.why;
    const text = document.createElement("pre");
    text.textContent = item.text;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = removed.has(item.id) ? t("activityLog.action.putBack") : t("activityLog.action.remove");
    toggle.addEventListener("click", () => { removed.has(item.id) ? removed.delete(item.id) : removed.add(item.id); renderItems(); });
    box.append(summary, why, toggle, text);
    return box;
  }));
}
const chosen = () => ({ removed: [...removed], items, summary: $("problem-report-summary").value });
async function saveZip() {
  const status = $("problem-report-status");
  try {
    const saved = await api("diagnostics/report/save", chosen());
    const bytes = Uint8Array.from(atob(saved.base64), (c) => c.charCodeAt(0));
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    link.download = saved.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    status.textContent = t("activityLog.status.savedZip", { name: saved.name, path: saved.path });
  } catch (e) { status.textContent = t("activityLog.status.zipFailed", { message: e.message }); }
}
async function openIssue() {
  const status = $("problem-report-status");
  try {
    const { url } = await api("diagnostics/report/issue", chosen());
    if (window.branchDesktop && window.branchDesktop.openExternal) await window.branchDesktop.openExternal(url);
    else window.open(url, "_blank", "noopener");
    status.textContent = t("activityLog.status.issueOpen");
  } catch (e) { status.textContent = t("activityLog.status.issueFailed", { message: e.message }); }
}

/* ---------- Automatic problem reports ---------- */
const automaticItems = ["about", "health", "services", "settings", "log", "crashes", "updates", "tasks", "disk", "network"];
const automaticEvents = ["crash", "update"];
const automaticDestinationValue = (destination) => destination ? JSON.stringify(destination) : "";

function automaticSettingsFromForm() {
  const selected = $("automatic-problem-destination").value;
  let destination = null;
  if (selected === "github") destination = {
    kind: "github", repository: $("automatic-problem-repository").value.trim(),
  };
  else if (selected) destination = JSON.parse(selected);
  return {
    mode: $("automatic-problem-mode").value,
    destination,
    events: automaticEvents.filter((name) => $(`automatic-problem-event-${name}`).checked),
    items: automaticItems.filter((name) => $(`automatic-problem-item-${name}`).checked),
  };
}

function option(value, words, key = "") {
  const node = new Option(words, value);
  if (key) node.dataset.t = key;
  return node;
}

function showGitHubRepository() {
  $("automatic-problem-github").hidden = $("automatic-problem-destination").value !== "github";
}

function fillAutomaticForm(data) {
  const { settings, destinations } = data;
  const choices = [option("", t("automatic-report.destination.choose"), "automatic-report.destination.choose")];
  for (const chat of destinations.channels) choices.push(option(
    automaticDestinationValue({ kind: "channel", channel: chat.channel, chatId: chat.chatId }),
    `${chat.title} — ${chat.channel}`,
  ));
  if (destinations.github || settings.destination?.kind === "github")
    choices.push(option("github", t("automatic-report.destination.github"), "automatic-report.destination.github"));
  $("automatic-problem-destination").replaceChildren(...choices);
  $("automatic-problem-mode").value = settings.mode;
  $("automatic-problem-destination").value = settings.destination?.kind === "github"
    ? "github" : automaticDestinationValue(settings.destination);
  $("automatic-problem-repository").value = settings.destination?.kind === "github" ? settings.destination.repository : "";
  for (const name of automaticEvents) $(`automatic-problem-event-${name}`).checked = settings.events.includes(name);
  for (const name of automaticItems) $(`automatic-problem-item-${name}`).checked = settings.items.includes(name);
  showGitHubRepository();
}

let automaticLoaded = false;
async function loadAutomaticSettings() {
  try {
    fillAutomaticForm(await api("diagnostics/report/automatic"));
    automaticLoaded = true;
  } catch (error) { $("automatic-problem-status").textContent = error.message; }
}

async function previewAutomaticReport() {
  const status = $("automatic-problem-status");
  try {
    const preview = await api("diagnostics/report/automatic/preview", {
      settings: automaticSettingsFromForm(),
      kind: $("automatic-problem-preview-kind").value,
      summary: $("automatic-problem-preview-summary").value,
    });
    const shown = $("automatic-problem-preview");
    shown.textContent = [
      `${t("automatic-report.preview.destination")}: ${preview.destination}`,
      `${t("automatic-report.preview.title")}: ${preview.title}`,
      `${t("automatic-report.preview.body")}:`, preview.body,
    ].join("\n\n");
    shown.hidden = false;
    status.textContent = t("automatic-report.preview.ready");
  } catch (error) { status.textContent = error.message; }
}

async function saveAutomaticSettings() {
  const status = $("automatic-problem-status");
  try {
    const saved = await api("diagnostics/report/automatic", automaticSettingsFromForm());
    fillAutomaticForm(saved);
    status.textContent = saved.settings.mode === "on"
      ? t("automatic-report.saved.on") : t("automatic-report.saved.off");
  } catch (error) { status.textContent = error.message; }
}

$("activity-log-show")?.addEventListener("click", loadLog);
$("activity-log-save")?.addEventListener("click", saveLogSettings);
$("activity-log-clear")?.addEventListener("click", clearLog);
$("problem-report-gather")?.addEventListener("click", gather);
$("problem-report-save")?.addEventListener("click", saveZip);
$("problem-report-issue")?.addEventListener("click", openIssue);
$("automatic-problem-destination")?.addEventListener("change", showGitHubRepository);
$("automatic-problem-preview-button")?.addEventListener("click", previewAutomaticReport);
$("automatic-problem-save")?.addEventListener("click", saveAutomaticSettings);
// The log card fills itself the first time it is scrolled into view, not on every page load.
const card = $("activity-log-card");
if (card && "IntersectionObserver" in window) {
  const seen = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { seen.disconnect(); void loadLog(); } });
  seen.observe(card);
}
const problemCard = $("problem-report-card");
if (problemCard && "IntersectionObserver" in window) {
  const seen = new IntersectionObserver((entries) => {
    if (!automaticLoaded && entries.some((entry) => entry.isIntersecting)) void loadAutomaticSettings();
  });
  seen.observe(problemCard);
}
