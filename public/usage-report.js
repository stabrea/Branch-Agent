/**
 * The usage report card (A0367): one switch, the stretch to cover, and three ways to keep the
 * report — as notes, as a page, or in the print view. It lives in Settings → Data beside the other
 * usage figures, and says nothing is sent anywhere.
 *
 * Also the task counters card (A1751) in Settings → Advanced, beside sending traces: the same
 * counters as the counters page, sent only to the owner's own address, off until switched on.
 */
import { t } from "/i18n.js";
import { segmented, dropdown } from "/control-makers.js";

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

function keyed(tag, key, className = "") {
  const node = document.createElement(tag);
  node.textContent = t(key);
  node.dataset.t = key;
  if (className) node.className = className;
  return node;
}
const say = (message) => { const node = $("usage-report-status"); if (node) node.textContent = message; };

function picker(id, labelKey, values, prefix) {
  const label = keyed("label", labelKey);
  label.htmlFor = id;
  // Detect three-way switch vs multi-option dropdown
  if (JSON.stringify(values) === JSON.stringify(["off", "when-needed", "on"])) {
    const options = values.map((v) => [v, `${prefix}.${v}`]);
    const control = segmented({ id, options, value: "" });
    return [label, control];
  } else {
    const options = values.map((v) => [v, `${prefix}.${v}`]);
    const control = dropdown({ id, options, value: "" });
    return [label, control];
  }
}

/** Hands the owner the file without putting a word of it into an address. */
function handOver(report) {
  if (report.format === "print") {
    const view = globalThis.open("", "_blank", "width=900,height=1000");
    if (!view) throw new Error(t("usage.report.popup"));
    view.document.write(report.body);
    view.document.close();
    return;
  }
  const address = URL.createObjectURL(new Blob([report.body], { type: report.contentType }));
  const link = document.createElement("a");
  link.href = address;
  link.download = report.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(address), 10000);
}

async function make(format) {
  try {
    const report = await api("usage/report", { range: $("usage-report-range").value, format });
    handOver(report);
    say(t("usage.report.saved"));
  } catch (error) { say(error.message); }
}

/* ---------- the task counters, sent to the owner's own address (A1751) ---------- */

const sayCounters = (message) => { const node = $("counters-status"); if (node) node.textContent = message; };

function showCounters(settings) {
  $("counters-mode").value = settings.mode;
  $("counters-send").hidden = settings.mode === "off";
}

function buildCountersCard() {
  const card = document.createElement("section");
  card.className = "card";
  card.id = "counters-card";
  card.dataset.home = "settings:advanced";
  const [modeLabel, mode] = picker("counters-mode", "field.counters-mode", ["off", "when-needed", "on"], "counters.mode");
  mode.addEventListener("change", async () => {
    try { showCounters((await api("usage/counters", { mode: mode.value })).counters); sayCounters(""); }
    catch (error) { sayCounters(error.message); }
  });
  const send = keyed("button", "action.counters-send");
  send.type = "button";
  send.id = "counters-send";
  send.hidden = true;
  send.addEventListener("click", async () => {
    try { sayCounters((await api("usage/counters/send", {})).reason); }
    catch (error) { sayCounters(error.message); }
  });
  const status = document.createElement("p");
  status.id = "counters-status";
  status.className = "subtle";
  status.setAttribute("role", "status");
  card.append(keyed("h2", "counters.title"), keyed("p", "counters.lead"), modeLabel, mode,
    keyed("p", "counters.note", "subtle"), send, status);
  return card;
}

function show(settings) {
  $("usage-report-mode").value = settings.mode;
  $("usage-report-range").value = settings.range;
  $("usage-report-body").hidden = settings.mode === "off";
}

async function save(change) {
  try { show((await api("usage/report/settings", change)).usageReport); say(""); }
  catch (error) { say(error.message); }
}

function buildCard() {
  const card = document.createElement("section");
  card.className = "card";
  card.id = "usage-report-card";
  card.dataset.home = "settings:data";
  const [modeLabel, mode] = picker("usage-report-mode", "field.usage-report-mode", ["off", "when-needed", "on"], "usage.report.mode");
  const [rangeLabel, range] = picker("usage-report-range", "field.usage-report-range", ["7d", "30d", "90d"], "usage.report.range");
  mode.addEventListener("change", () => save({ mode: mode.value }));
  range.addEventListener("change", () => save({ range: range.value }));
  const body = document.createElement("div");
  body.id = "usage-report-body";
  body.hidden = true;
  const make_ = keyed("button", "action.usage-report-page");
  make_.type = "button";
  make_.addEventListener("click", () => make("html"));
  const row = document.createElement("div");
  row.className = "report-actions";
  for (const [format, key] of [["markdown", "action.usage-report-notes"], ["print", "action.usage-report-print"]]) {
    const other = keyed("button", key, "quiet");
    other.type = "button";
    other.addEventListener("click", () => make(format));
    row.append(other);
  }
  row.prepend(make_);
  body.append(rangeLabel, range, row, keyed("p", "usage.report.note", "subtle"));
  const status = document.createElement("p");
  status.id = "usage-report-status";
  status.className = "subtle";
  status.setAttribute("role", "status");
  card.append(keyed("h2", "usage.report.title"), keyed("p", "usage.report.lead"), modeLabel, mode, body, status);
  return card;
}

const draw = () => Promise.all([
  api("usage/report/settings").then(({ usageReport }) => show(usageReport)),
  api("usage/counters").then(({ counters }) => showCounters(counters)),
]);

async function start() {
  const settings = $("settings");
  if (!settings || $("usage-report-card")) return;
  settings.append(buildCard(), buildCountersCard());
  /* Before signing in the question is refused, so the card is drawn again whenever Settings or
     the app comes into view; until then the switch reads off and nothing else shows. */
  const redraw = () => draw().catch(() => undefined);
  const watch = new MutationObserver((changes) => {
    if (changes.some((change) => !change.target.hidden)) redraw();
  });
  for (const node of [$("workspace"), settings])
    if (node) watch.observe(node, { attributes: true, attributeFilter: ["hidden"] });
  redraw();
}

window.branchUsageReport = { render: draw };

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
