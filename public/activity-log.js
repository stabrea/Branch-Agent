import { t } from "./i18n.js";
/**
 * mac7/diagnostics: Settings › Advanced › Activity log, Settings › Updates & about › Report a
 * problem, and the window's own errors written to the log. Nothing here sends anything outside
 * this computer: the report is shown in full, the owner removes what they like, and then saves a
 * zip or opens GitHub's issue form in their own browser, where they press Submit themselves.
 */
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
    status.textContent = data.lines.length ? `${data.lines.length} lines, newest first.`
      : data.settings.mode === "off" ? "The activity log is off. Turn it on above to start keeping one." : "Nothing matches yet.";
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
    status.textContent = saved.mode === "off" ? "Saved. The activity log is off." : "Saved. The activity log is on this computer only.";
  } catch (e) { status.textContent = e.message; }
}
async function clearLog() {
  if (!confirm("Clear the activity log? Every line and crash note goes; this cannot be undone.")) return;
  try { await api("diagnostics/log/clear", {}); await loadLog(); } catch (e) { $("activity-log-status").textContent = e.message; }
}

/* ---------- Report a problem ---------- */
let items = [];
const removed = new Set();
async function gather() {
  const status = $("problem-report-status");
  status.textContent = "Gathering… nothing is being sent.";
  removed.clear();
  try {
    items = (await api("diagnostics/report", {})).items;
    renderItems();
    status.textContent = `${items.length} parts. Read each one; press Remove on anything you would rather not share.`;
    $("problem-report-actions").hidden = false;
  } catch (e) { status.textContent = t("activityLog.status.reportFailed", { message: e.message }); }
}
function renderItems() {
  $("problem-report-items").replaceChildren(...items.map((item) => {
    const box = document.createElement("details");
    box.className = "report-item";
    if (removed.has(item.id)) box.classList.add("removed");
    const summary = document.createElement("summary");
    summary.textContent = removed.has(item.id) ? `${item.title} (removed)` : item.title;
    const why = document.createElement("p");
    why.className = "subtle";
    why.textContent = item.why;
    const text = document.createElement("pre");
    text.textContent = item.text;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = removed.has(item.id) ? "Put back" : "Remove";
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
    status.textContent = `Saved as ${saved.name} (a copy is also in ${saved.path}). Nothing was sent.`;
  } catch (e) { status.textContent = t("activityLog.status.zipFailed", { message: e.message }); }
}
async function openIssue() {
  const status = $("problem-report-status");
  try {
    const { url } = await api("diagnostics/report/issue", chosen());
    if (window.branchDesktop && window.branchDesktop.openExternal) await window.branchDesktop.openExternal(url);
    else window.open(url, "_blank", "noopener");
    status.textContent = "GitHub's issue form is open in your browser with a title and description filled in. Save the zip and attach it there; nothing is sent until you press Submit.";
  } catch (e) { status.textContent = t("activityLog.status.issueFailed", { message: e.message }); }
}

$("activity-log-show")?.addEventListener("click", loadLog);
$("activity-log-save")?.addEventListener("click", saveLogSettings);
$("activity-log-clear")?.addEventListener("click", clearLog);
$("problem-report-gather")?.addEventListener("click", gather);
$("problem-report-save")?.addEventListener("click", saveZip);
$("problem-report-issue")?.addEventListener("click", openIssue);
// The log card fills itself the first time it is scrolled into view, not on every page load.
const card = $("activity-log-card");
if (card && "IntersectionObserver" in window) {
  const seen = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { seen.disconnect(); void loadLog(); } });
  seen.observe(card);
}
