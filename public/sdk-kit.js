// Bucket 21: two cards, each placed by its `data-home` (docs/places.md):
//   settings:advanced        "Building on Branch": the switch, the clients for each language, the tools to share
//   automations:procedures   "Flows as files": write a saved flow out as YAML, or read one back as a new flow
// Both ship off. Every word goes through a key, and every colour comes from the page's tokens.
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const token = () => sessionStorage.getItem("branch-token") || "";

async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}
function worded(tag, key, props = {}) {
  const node = el(tag, { ...props, textContent: t(key) });
  node.dataset.t = key;
  return node;
}
const field = (key, control) => [worded("label", key, { htmlFor: control.id }), control];
function card(id, home, name, ...controls) {
  const section = el("section", { id, className: "card" },
    worded("h2", `settings.card.${name}`), worded("p", `settings.intro.${name}`, { className: "subtle" }), ...controls,
    el("p", { id: `${id}-status`, className: "subtle", role: "status" }));
  section.dataset.home = home;
  return section;
}
const status = (id, text) => { const node = $(`${id}-status`); if (node) node.textContent = text; };
function button(key, primary, action, id) {
  const node = worded("button", key, { type: "button", className: primary ? "primary" : "" });
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { status(id, await action()); } catch (error) { status(id, error.message); } finally { node.disabled = false; }
  });
  return node;
}

/* ---------- building on Branch ---------- */

function kitCard() {
  const id = "sdk-kit-card";
  const mode = el("select", { id: "sdk-kit-mode" });
  for (const value of ["off", "when-needed", "on"]) mode.append(worded("option", `switch.${value}`, { value }));
  const clients = el("ul", { id: "sdk-kit-clients", className: "subtle" });
  const tools = el("p", { id: "sdk-kit-tools", className: "subtle" });
  // A choice not yet saved is kept: a redraw still on its way must not put the old value back.
  mode.addEventListener("change", () => { mode.dataset.edited = "1"; });
  const save = button("action.save-switch", true, async () => {
    const saved = await api("sdk-kit", { mode: mode.value });
    delete mode.dataset.edited;
    drawKit(saved);
    return t("sdk-kit.saved");
  }, id);
  return card(id, "settings:advanced", "sdk-kit", ...field("field.feature-switch", mode), worded("h3", "sdk-kit.clients"), clients, tools, save);
}
function drawKit(view) {
  if (!$("sdk-kit-mode").dataset.edited) $("sdk-kit-mode").value = view.settings.mode;
  $("sdk-kit-clients").replaceChildren(...Object.entries(view.packages).map(([language, entry]) =>
    el("li", {}, el("strong", { textContent: t(`sdk-kit.language.${language}`) }), " ", el("code", { textContent: entry.folder }))));
  $("sdk-kit-tools").textContent = t("sdk-kit.tools", { tools: view.tools.join(", ") });
}

/* ---------- flows as files ---------- */

function flowsCard() {
  const id = "flow-yaml-card";
  const pick = el("select", { id: "flow-yaml-pick" });
  const text = el("textarea", { id: "flow-yaml-text", rows: 10, spellcheck: false, maxLength: 512 * 1024 });
  const writeOut = button("flow-yaml.write-out", false, async () => {
    if (!pick.value) return t("flow-yaml.none");
    text.value = (await api(`flows/${encodeURIComponent(pick.value)}/yaml`)).yaml;
    return t("flow-yaml.written");
  }, id);
  const readBack = button("flow-yaml.read-back", true, async () => {
    const saved = await api("flows/yaml", { yaml: text.value });
    await fillFlows();
    return t("flow-yaml.saved", { name: saved.name });
  }, id);
  return card(id, "automations:procedures", "flow-yaml",
    ...field("flow-yaml.pick", pick), writeOut, ...field("flow-yaml.text", text), readBack);
}
async function fillFlows() {
  const { flows } = await api("flows");
  const pick = $("flow-yaml-pick");
  const chosen = pick.value;
  pick.replaceChildren(...flows.map((flow) => el("option", { value: flow.id, textContent: flow.name })));
  if (flows.some((flow) => flow.id === chosen)) pick.value = chosen;
}

/** Adds the cards once (layout.js moves each to its home), then fills them with what is saved now. */
async function render() {
  if (!token()) return;
  if (!$("sdk-kit-card")) document.body.append(kitCard());
  if (!$("flow-yaml-card")) document.body.append(flowsCard());
  await api("sdk-kit").then(drawKit).catch((error) => status("sdk-kit-card", error.message));
  await fillFlows().catch((error) => status("flow-yaml-card", error.message));
}

// Filled again whenever a place, a tab or a Settings page is opened, so a flow saved a moment ago is
// in the list; and once now, for a window that is already connected.
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest(".lx-gear, .lx-place-link, .lx-tab, .lx-settings-link, .nav")) void render();
});
// The language lines and the tool list are put together here, so they are drawn again in a new language.
document.addEventListener("branch-language", () => void render());
void render();
