// A second look before approvals (wave mac3, tool-safety). Another model can look at a risky step
// before the owner is asked; the deciding happens on the server (src/approval-reviewer.ts). This
// card only shows the saved settings and sends changes back. Every word is behind a key.
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);

async function api(body, path = "approval-reviewer") {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

/** An element whose words come from a key, so a change of language redraws it. */
function worded(tag, key, className) {
  const node = document.createElement(tag);
  node.textContent = t(key);
  node.dataset.t = key;
  if (className) node.className = className;
  return node;
}
function labelled(id, key, control) {
  const label = worded("label", key);
  label.htmlFor = id;
  control.id = id;
  return [label, control];
}
function options(select, pairs) {
  select.replaceChildren(...pairs.map(([value, key, text]) => {
    const option = key ? worded("option", key) : document.createElement("option");
    if (!key) option.textContent = text;
    option.value = value;
    return option;
  }));
}

/** The card, drawn once beside the approval rules; `data-home` puts it on the Permissions page. */
function buildCard() {
  if ($("approval-reviewer-card")) return $("approval-reviewer-card");
  const after = $("policy-card");
  if (!after) return null;
  const card = document.createElement("section");
  card.className = "card";
  card.id = "approval-reviewer-card";
  card.dataset.home = "settings:permissions";
  const mode = document.createElement("select");
  options(mode, ["off", "on", "when-needed"].map((value) => [value, `folder-trust.switch.${value}`]));
  const connection = document.createElement("select");
  const rules = document.createElement("textarea");
  rules.rows = 4;
  rules.maxLength = 4000;
  const ceiling = document.createElement("input");
  Object.assign(ceiling, { type: "number", min: "200", max: "20000", step: "100" });
  const save = worded("button", "action.save-this-setting");
  save.type = "button";
  save.id = "approval-reviewer-save";
  const status = document.createElement("p");
  status.className = "subtle";
  status.id = "approval-reviewer-status";
  status.setAttribute("role", "status");
  card.append(worded("h2", "settings.card.second-look"), worded("p", "reviewer.lead"),
    ...labelled("approval-reviewer-mode", "field.reviewer-mode", mode), worded("p", "reviewer.modes", "field-note"),
    ...labelled("approval-reviewer-connection", "field.reviewer-connection", connection),
    ...labelled("approval-reviewer-rules", "field.reviewer-rules", rules), worded("p", "reviewer.stock-rules", "field-note"),
    ...labelled("approval-reviewer-ceiling", "field.reviewer-ceiling", ceiling),
    worded("p", "reviewer.promise", "subtle"), save, status);
  save.addEventListener("click", () => void store());
  after.after(card);
  return card;
}

function fill(settings, presets) {
  if (!buildCard()) return;
  $("approval-reviewer-mode").value = settings.mode;
  options($("approval-reviewer-connection"), [["", "reviewer.same-connection"],
    ...presets.map((preset) => [preset.id, null, preset.name])]);
  $("approval-reviewer-connection").value = presets.some((preset) => preset.id === settings.preset) ? settings.preset : "";
  $("approval-reviewer-rules").value = settings.rules;
  $("approval-reviewer-ceiling").value = settings.maxTokens;
}

async function store() {
  const status = $("approval-reviewer-status");
  try {
    const saved = await api({
      mode: $("approval-reviewer-mode").value,
      preset: $("approval-reviewer-connection").value || null,
      rules: $("approval-reviewer-rules").value,
      maxTokens: Math.max(200, Math.min(20000, Number($("approval-reviewer-ceiling").value) || 2000)),
    });
    $("approval-reviewer-mode").value = saved.mode;
    status.textContent = t("folder-trust.saved");
  } catch (error) {
    status.textContent = error.message;
  }
}

async function refresh() {
  buildCard();
  if (!sessionStorage.getItem("branch-token")) return;
  try {
    const [settings, state] = await Promise.all([api(), api(undefined, "state")]);
    fill(settings, state.models?.presets ?? []);
  } catch { /* signed out or offline: the next look tries again */ }
}

async function afterSignIn(tries = 20) {
  for (let left = tries; left > 0 && !sessionStorage.getItem("branch-token"); left--)
    await new Promise((done) => setTimeout(done, 250));
  await refresh();
}

void refresh();
const signedIn = $("workspace");
if (signedIn) new MutationObserver(() => { if (!signedIn.hidden) void afterSignIn(); }).observe(signedIn, { attributes: true, attributeFilter: ["hidden"] });
window.branchApprovalReviewer = { refresh };
