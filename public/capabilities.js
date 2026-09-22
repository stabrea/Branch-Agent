/**
 * Owner item 17: Settings › Capabilities. Everything the assistant can switch on, each one a plain
 * on/off switch, grouped, with the one Tool loading switch at the top (src/capabilities.ts,
 * src/feature-switches.ts). The detailed cards elsewhere keep their own settings; this page is where
 * each thing is switched.
 */
import { t, formatNumber } from "/i18n.js";
import { switchControl } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
/** An element whose words follow a language change (data-t), with values for the ones that carry numbers. */
function worded(tag, key, className, values) {
  const node = document.createElement(tag);
  node.textContent = t(key, values);
  if (!values) node.dataset.t = key;
  if (className) node.className = className;
  return node;
}

const GROUPS = ["computer", "accounts", "work", "research", "memory", "files", "automations", "agents", "trunks", "reach", "flows", "helpers", "safety", "add-ons"];
let last = null;

function card(id, titleKey, introKey) {
  const node = document.createElement("section");
  node.className = "card capability-card";
  node.id = id;
  node.dataset.home = "settings:capabilities";
  node.append(worded("h2", titleKey));
  if (introKey) node.append(worded("p", introKey, "subtle"));
  return node;
}

function loadingCard(cost) {
  const node = card("capabilities-loading", "capabilities.tool-loading.title", "capabilities.tool-loading.intro");
  const row = document.createElement("div");
  row.className = "capability-row";
  const label = worded("label", "capabilities.field.tool-loading");
  label.htmlFor = "capabilities-tool-loading";
  const status = document.createElement("p");
  status.className = "subtle";
  status.setAttribute("role", "status");
  const control = switchControl({ id: "capabilities-tool-loading", checked: cost.mode !== "eager", onChange: async (deferred) => {
    try { await api("tool-loading", { mode: deferred ? "deferred" : "eager" }); await refresh(); }
    catch (error) { control.checked = !deferred; status.textContent = error.message; }
  } });
  row.append(label, control);
  // What off costs now, in the model's own room: the owner decides knowing it.
  const costLine = cost.tools
    ? worded("p", cost.fits ? "capabilities.tool-loading.cost-fits" : "capabilities.tool-loading.cost-too-big", "field-note",
      { tools: formatNumber(cost.tools), tokens: formatNumber(cost.tokens), limit: formatNumber(cost.limit) })
    : worded("p", "capabilities.tool-loading.cost-none", "field-note");
  const meaning = worded("p", cost.mode === "eager" ? "capabilities.tool-loading.off" : "capabilities.tool-loading.on", "field-note");
  meaning.id = "capabilities-tool-loading-note";
  control.setAttribute("aria-describedby", meaning.id);
  node.append(row, meaning, costLine, status);
  return node;
}

function rowFor(entry) {
  const row = document.createElement("div");
  row.className = "capability-row";
  row.dataset.key = entry.key;
  const id = "capability-" + entry.key.replace(/[^a-z0-9]+/gi, "-");
  const label = document.createElement("label");
  label.htmlFor = id;
  // Its name in the language chosen; the server's English name only if a language file lacks it.
  label.textContent = t(entry.labelKey) === entry.labelKey ? entry.label : t(entry.labelKey);
  label.dataset.t = entry.labelKey;
  const status = document.createElement("p");
  status.className = "field-note";
  status.setAttribute("role", "status");
  const control = switchControl({ id, checked: entry.on, onChange: async (on) => {
    try { await api("capabilities", { key: entry.key, on }); await refresh(); }
    catch (error) { control.checked = !on; status.textContent = error.message; }
  } });
  control.disabled = entry.locked;
  row.append(label, control);
  // One short line saying what switching it on brings, and why it cannot be switched when it cannot.
  const notes = [entry.group === "files" ? worded("p", "capabilities.row.file", "field-note")
    : entry.tools ? worded("p", entry.tools === 1 ? "capabilities.row.tool" : "capabilities.row.tools", "field-note", { tools: formatNumber(entry.tools) })
    // A switch with no tools of its own (Trunks, Rooms …): what switching it does, not a tool count.
    : worded("p", "capabilities.row.no-tools", "field-note")];
  if (entry.locked) notes.push(worded("p", "capabilities.row.locked", "field-note"));
  else if (entry.needs) notes.push(worded("p", "capabilities.row.needs", "field-note", { name: t(entry.needs.labelKey) }));
  else if (entry.always) notes.push(worded("p", "capabilities.row.always", "field-note"));
  notes.forEach((note, at) => { note.id = `${id}-note-${at}`; });
  control.setAttribute("aria-describedby", notes.map((note) => note.id).join(" "));
  return [row, ...notes, status];
}

function render(view) {
  document.querySelectorAll(".capability-card").forEach((node) => node.remove());
  const cards = [loadingCard(view.toolLoading)];
  for (const group of GROUPS) {
    const rows = view.rows.filter((entry) => entry.group === group);
    if (!rows.length) continue;
    const node = card(`capabilities-${group}`, `capabilities.group.${group}`);
    for (const entry of rows) node.append(...rowFor(entry));
    cards.push(node);
  }
  // Sent to the Capabilities page by the layout (data-home), in this order.
  document.body.append(...cards);
}

export async function refresh() {
  if (!sessionStorage.getItem("branch-token")) return;
  try { last = await api("capabilities"); render(last); } catch { /* the page keeps what it last showed */ }
}
document.addEventListener("branch-language", () => { if (last) render(last); });
globalThis.branchCapabilities = { refresh };
void refresh();
