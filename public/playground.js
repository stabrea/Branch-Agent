/**
 * Settings → Developer → Try things out. Pick any tool, fill in the boxes its own description asks
 * for, and run it — under exactly the same permission rules the assistant works under, so a tool
 * your settings say to ask about stops and asks. Below that, the same question put to two models
 * side by side, when this workspace has that switched on.
 */
import { t, formatNumber } from "/i18n.js";
import { fillMarkdown } from "/markdown.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
let tools = [], chosen = null;
const status = (message) => { $("play-status").textContent = message; };

/** One input per property the tool's description asks for; everything else falls back to text. */
function field(name, property, required) {
  const wrap = el("div", undefined, "play-field");
  const id = "play-field-" + name;
  const label = el("label", `${name}${required ? " *" : ""}`);
  label.htmlFor = id;
  const type = property?.type;
  const node = el(type === "boolean" ? "input" : Array.isArray(property?.enum) ? "select" : "input");
  node.id = id;
  node.dataset.field = name;
  node.dataset.jsonType = Array.isArray(type) ? type[0] : type || "string";
  if (type === "boolean") node.type = "checkbox";
  else if (type === "number" || type === "integer") node.type = "number";
  else if (Array.isArray(property?.enum)) for (const option of property.enum) node.append(new Option(String(option), String(option)));
  else node.type = "text";
  if (property?.description) node.title = String(property.description);
  wrap.append(label, node);
  if (property?.description) wrap.append(el("span", property.description, "meta"));
  return wrap;
}
/** Reads the filled-in boxes back out as the object the tool expects. */
function collect() {
  const args = {};
  for (const node of $("play-form").querySelectorAll("[data-field]")) {
    const kind = node.dataset.jsonType;
    if (kind === "boolean") { if (node.checked) args[node.dataset.field] = true; continue; }
    const raw = node.value.trim();
    if (!raw) continue;
    if (kind === "number" || kind === "integer") args[node.dataset.field] = Number(raw);
    else if (kind === "array" || kind === "object") { try { args[node.dataset.field] = JSON.parse(raw); } catch { args[node.dataset.field] = raw; } }
    else args[node.dataset.field] = raw;
  }
  return args;
}
function drawForm() {
  const form = $("play-form");
  form.replaceChildren();
  if (!chosen) return;
  form.append(el("p", chosen.description, "meta"));
  form.append(el("p", `${chosen.permission} · ${chosen.readOnly ? t("playground.readOnly") : t("playground.changes")}`, "meta"));
  const properties = chosen.schema?.properties ?? {};
  const required = new Set(chosen.schema?.required ?? []);
  for (const [name, property] of Object.entries(properties)) form.append(field(name, property, required.has(name)));
  if (!Object.keys(properties).length) form.append(el("p", "This tool takes nothing.", "meta"));
}
/** Shows what came back, and the question when the settings say to ask first. */
function drawResult(outcome, args) {
  const box = $("play-result");
  box.replaceChildren(el("h3", t("playground.result")));
  if (outcome.status === "asked") {
    box.append(el("p", t("playground.asked")), el("p", outcome.question));
    const yes = el("button", t("playground.confirm"));
    yes.type = "button";
    yes.id = "play-confirm";
    yes.addEventListener("click", () => void run(args, true));
    const no = el("button", t("playground.cancel"), "text-button");
    no.type = "button";
    no.addEventListener("click", () => box.replaceChildren());
    box.append(yes, no);
    return;
  }
  if (outcome.status === "refused") { box.append(el("p", outcome.reason, "inspect-bad")); return; }
  box.append(el("p", `${outcome.status === "ran" ? "Finished" : "Did not work"} · ${formatNumber(outcome.milliseconds)} ms`, "meta"));
  const body = outcome.status === "ran" ? JSON.stringify(outcome.result, null, 2) : outcome.error;
  box.append(fillMarkdown(el("div"), "```json\n" + body + "\n```"));
}
async function run(args, confirm) {
  if (!chosen) return;
  status("");
  try { drawResult(await api("tools/try", { name: chosen.name, arguments: args, confirm }), args); }
  catch (error) { status(error.message); }
}
/** Two models, the same question, side by side; only when the workspace has comparing switched on. */
async function compare() {
  const prompt = $("play-compare-text").value.trim();
  if (!prompt) return;
  const box = $("play-compare-result");
  box.replaceChildren(el("p", "Asking…", "meta"));
  try {
    const view = await api("evaluation", { prompt, cases: [{ id: "playground", prompt }] });
    box.replaceChildren();
    for (const result of view.results ?? view.cases ?? [view])
      box.append(fillMarkdown(el("div", undefined, "play-compare-one"), "```json\n" + JSON.stringify(result, null, 2) + "\n```"));
  } catch { box.replaceChildren(el("p", t("playground.compareNone"), "meta")); }
}
/** Loads the tool list the first time the screen is opened. */
export async function renderPlayground() {
  if (tools.length) return;
  try {
    tools = (await api("tools/forms")).tools;
    const picker = $("play-tool");
    picker.replaceChildren(new Option("—", ""));
    for (const tool of tools) picker.append(new Option(tool.name, tool.name));
  } catch (error) { status(error.message); }
}
$("play-tool").addEventListener("change", (event) => {
  chosen = tools.find((tool) => tool.name === event.target.value) ?? null;
  $("play-result").replaceChildren();
  drawForm();
});
$("play-run").addEventListener("click", () => void run(collect(), false));
$("play-compare-run").addEventListener("click", () => void compare());
globalThis.branchPlayground = { render: renderPlayground };
