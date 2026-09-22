// Optional typed decisions through the owner's JEV installation. Branch keeps no JEV credential:
// the program reads its own configuration, and every bounded state value goes over stdin.
import { t } from "/i18n.js";
import { segmented, dropdown } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
const say = (key, english) => { const translated = t(key); return translated === key ? english : translated; };

async function api(body) {
  const response = await fetch("/api/jev", {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || say("jev.failed", "That could not be saved."));
  return data;
}

function worded(tag, key, english, className = "") {
  const node = document.createElement(tag);
  node.textContent = say(key, english);
  node.dataset.t = key;
  if (className) node.className = className;
  return node;
}

function labelled(id, key, english, control) {
  const label = worded("label", key, english);
  label.htmlFor = id;
  control.id = id;
  return [label, control];
}

function input(type, properties = {}) {
  const node = document.createElement("input");
  node.type = type;
  Object.assign(node, properties);
  return node;
}

function buildCard() {
  if ($("jev-decisions-card")) return $("jev-decisions-card");
  const card = document.createElement("section");
  card.className = "card";
  card.id = "jev-decisions-card";
  card.dataset.home = "settings:advanced";
  const mode = segmented({ id: "jev-mode", value: "off" });
  const command = input("text", { maxLength: 500, autocomplete: "off", spellcheck: false });
  const args = document.createElement("textarea");
  Object.assign(args, { rows: 3, maxLength: 4000, spellcheck: false });
  const provider = dropdown({ id: "jev-provider", value: "auto", options: [
    ["auto", "jev.provider.auto", "Use JEV's default"], ["typesafe", "jev.provider.typesafe", "TypeSafe"],
    ["openrouter", "jev.provider.openrouter", "OpenRouter"],
  ] });
  const model = input("text", { maxLength: 100, autocomplete: "off", spellcheck: false });
  const timeout = input("number", { min: "0.5", max: "30", step: "0.5" });
  const retries = input("number", { min: "0", max: "3", step: "1" });
  const confidence = input("number", { min: "50", max: "99", step: "1" });
  const save = worded("button", "action.save-this-setting", "Save this setting");
  save.type = "button";
  const status = document.createElement("p");
  status.id = "jev-decisions-status";
  status.className = "subtle";
  status.setAttribute("role", "status");
  card.append(worded("h2", "jev.title", "JEV decision support"), worded("p", "jev.lead", "Use a small decision model for bounded yes, pick or score questions. Low-confidence answers always come back for review."),
    ...labelled("jev-mode", "jev.field.mode", "Use JEV for bounded decisions", mode),
    ...labelled("jev-command", "jev.field.command", "Program", command),
    ...labelled("jev-args", "jev.field.args", "Arguments, one per line", args),
    worded("p", "jev.args.note", "For WSL on Windows, use wsl.exe with --exec and jev on separate lines.", "field-note"),
    ...labelled("jev-provider", "jev.field.provider", "Provider", provider),
    ...labelled("jev-model", "jev.field.model", "Model, optional", model),
    ...labelled("jev-timeout", "jev.field.timeout", "Timeout in seconds", timeout),
    ...labelled("jev-retries", "jev.field.retries", "Retries", retries),
    ...labelled("jev-confidence", "jev.field.confidence", "Minimum confidence percent", confidence),
    worded("p", "jev.credentials", "Configure credentials in your terminal with jev auth set. Branch never reads or stores them.", "subtle"),
    save, status);
  save.addEventListener("click", () => void store());
  ($("approval-reviewer-card") ?? $("event-loop-card") ?? $("workspace"))?.after(card);
  return card;
}

function fill(settings) {
  $("jev-mode").value = settings.mode;
  $("jev-command").value = settings.command;
  $("jev-args").value = settings.args.join("\n");
  $("jev-provider").value = settings.provider;
  $("jev-model").value = settings.model;
  $("jev-timeout").value = String(settings.timeoutMs / 1000);
  $("jev-retries").value = String(settings.retries);
  $("jev-confidence").value = String(Math.round(settings.minConfidence * 100));
}

function formSettings() {
  return {
    mode: $("jev-mode").value,
    command: $("jev-command").value.trim(),
    args: $("jev-args").value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    provider: $("jev-provider").value,
    model: $("jev-model").value.trim(),
    timeoutMs: Math.round(Number($("jev-timeout").value) * 1000),
    retries: Number($("jev-retries").value),
    minConfidence: Number($("jev-confidence").value) / 100,
  };
}

async function store() {
  const status = $("jev-decisions-status");
  try {
    fill(await api(formSettings()));
    status.textContent = say("folder-trust.saved", "Saved.");
  } catch (error) { status.textContent = error.message; }
}

async function refresh() {
  buildCard();
  if (!sessionStorage.getItem("branch-token")) return;
  try { fill(await api()); } catch { /* signed out, household profile or offline */ }
}

async function afterSignIn() {
  for (let left = 20; left > 0 && !sessionStorage.getItem("branch-token"); left--)
    await new Promise((done) => setTimeout(done, 250));
  await refresh();
}

buildCard();
void refresh();
const workspace = $("workspace");
if (workspace) new MutationObserver(() => { if (!workspace.hidden) void afterSignIn(); })
  .observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
document.addEventListener("branch-profile", (event) => {
  const card = buildCard();
  card.hidden = event.detail?.owner === false;
  if (!card.hidden) void refresh();
});

globalThis.branchJevDecisions = { refresh };
