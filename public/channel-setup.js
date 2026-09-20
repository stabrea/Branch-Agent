// Set up a chat app (mac7/connect). For each chat app Branch supports: the one command to paste into a
// terminal, the official app for this computer, two square codes for the phone (get the app, make the
// bot), and a paste box whose "Check and save" asks the app's own service, keeps the token in the
// locker and switches the app on only when asked. The work happens on the server (src/channel-setup/).
// Its card lives in Customize, Chat apps; the Telegram card and each "More chat apps" row get the same
// panel. The square codes are drawn black on white on purpose, like the phone code in deployment.js.
import { api, ownerAtWindow } from "/app.js";
import { t } from "/i18n.js";
import { dropdown } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
const MODES = ["off", "when-needed", "on"];
const state = { list: null, chosen: "telegram", panels: new Map(), said: new Map() };

function make(tag, key, className) {
  const node = document.createElement(tag);
  if (key) { node.dataset.t = key; node.textContent = t(key); }
  if (className) node.className = className;
  return node;
}
/** A sentence from a recipe: its French when the language file has one, else the recipe's own English. */
function recipeWords(view, part, english) {
  const key = `channel-setup.r.${view.id}.${part}`;
  const node = document.createElement("span");
  const word = t(key);
  node.textContent = word === key ? english : word;
  if (word !== key) node.dataset.t = key;
  return node;
}
function status(text = "") {
  const node = make("p", null, "subtle");
  node.setAttribute("role", "status");
  node.textContent = text;
  return node;
}
function quiet(key, onClick) {
  const node = make("button", key, "quiet-button");
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}
function link(key, href) {
  const node = make("a", key);
  Object.assign(node, { href, target: "_blank", rel: "noreferrer noopener" });
  return node;
}
function labelled(id, key, control) {
  const label = make("label", key);
  label.htmlFor = id;
  control.id = id;
  return [label, control];
}

export function viewerSystem(agent = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "") {
  if (/win/i.test(agent)) return "windows";
  if (/mac|iphone|ipad/i.test(agent)) return "mac";
  return "linux";
}

/** Black squares on white with a quiet border, which every phone camera reads in any theme. */
function drawCode(code, labelKey) {
  const figure = document.createElement("figure");
  const canvas = document.createElement("canvas");
  const quietZone = 4, scale = Math.max(3, Math.floor(180 / (code.size + quietZone * 2)));
  canvas.width = canvas.height = (code.size + quietZone * 2) * scale;
  const paint = canvas.getContext("2d");
  if (paint) {
    paint.fillStyle = "#ffffff";
    paint.fillRect(0, 0, canvas.width, canvas.height);
    paint.fillStyle = "#000000";
    code.rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === "1") paint.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale); });
  }
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", t(labelKey));
  figure.append(canvas, make("figcaption", labelKey));
  return figure;
}

function commandBlock(view, place) {
  const system = viewerSystem();
  const line = system === "windows" ? view.command.windows : view.command.posix;
  const code = make("code", null, "channel-setup-command");
  code.textContent = line;
  const said = status();
  const copy = quiet("channel-setup.copy", async () => {
    try { await navigator.clipboard.writeText(line); said.textContent = t("channel-setup.copied"); }
    catch { said.textContent = t("channel-setup.copy-failed"); }
  });
  copy.id = `channel-setup-copy-${place}`;
  const nodes = [make("p", "channel-setup.command-lead", "field-note"), code, copy, said];
  if (system === "windows") nodes.push(make("p", "channel-setup.windows-note", "field-note"));
  return nodes;
}

function appBlock(view) {
  const lead = make("p", "channel-setup.app-lead", "field-note");
  if (!view.app) return [lead, wrap("p", "subtle", recipeWords(view, "noApp", view.noApp))];
  const system = viewerSystem();
  const line = document.createElement("p");
  const pkg = system === "windows" ? view.app.winget && `winget install --exact --id ${view.app.winget} --source winget`
    : system === "mac" ? view.app.brew && `brew install --cask ${view.app.brew}`
    : view.app.flatpak ? `flatpak install --user flathub ${view.app.flatpak}` : view.app.snap && `sudo snap install ${view.app.snap}`;
  if (pkg) { const code = make("code", null, "channel-setup-command"); code.textContent = pkg; line.append(code); }
  else line.append(make("span", "channel-setup.no-package"));
  return [lead, line, link("channel-setup.download", view.app.download)];
}

function codesBlock(view) {
  const box = make("div", null, "channel-setup-codes");
  if (view.codes.ios) box.append(drawCode(view.codes.ios, "channel-setup.code-ios"));
  if (view.codes.android) box.append(drawCode(view.codes.android, "channel-setup.code-android"));
  if (view.codes.create) box.append(drawCode(view.codes.create, "channel-setup.code-create"));
  if (!box.childElementCount) return [];
  return [make("p", "channel-setup.codes-lead", "field-note"), box];
}

function createBlock(view, place) {
  const nodes = [make("p", "channel-setup.create-lead", "field-note")];
  if (!view.create) {
    nodes.push(wrap("p", "subtle", recipeWords(view, "noCreate", view.noCreate)));
    const list = document.createElement("ol");
    view.steps.forEach((step, index) => list.append(wrap("li", null, recipeWords(view, `step-${index + 1}`, step))));
    if (view.steps.length) nodes.push(list);
    return nodes;
  }
  nodes.push(wrap("p", null, recipeWords(view, "how", view.create.how)));
  if (view.create.prefilled) nodes.push(make("p", "channel-setup.prefilled", "subtle"));
  const open = link("channel-setup.open-create", view.create.url ?? "#");
  open.id = `channel-setup-open-${place}`;
  if (!view.create.url) open.hidden = true;
  nodes.push(open);
  return nodes;
}

function wrap(tag, className, child) {
  const node = make(tag, null, className);
  node.append(child);
  return node;
}

/** The server a person typed makes the create link for self-hosted apps; only https is used. */
function followServer(view, place, input) {
  input.addEventListener("input", () => {
    const open = $(`channel-setup-open-${place}`);
    const server = input.value.trim().replace(/\/+$/, "");
    if (!open || !view.create?.template) return;
    const good = /^https:\/\/[^\s/?#"'<>]+(\/[^\s?#"'<>]*)?$/.test(server);
    open.hidden = !good;
    if (good) open.href = view.create.template.replace("{{server}}", server);
  });
}

function inputsFor(view, place) {
  const inputs = [];
  const nodes = [];
  for (const field of view.fields) {
    const input = Object.assign(document.createElement("input"), { type: field.kind === "url" ? "url" : "text", autocomplete: "off", spellcheck: false });
    input.dataset.name = field.name;
    const label = document.createElement("label");
    label.htmlFor = input.id = `channel-setup-${place}-${field.name}`;
    label.append(recipeWords(view, `field-${field.name}`, field.what));
    if (field.name === "server") followServer(view, place, input);
    inputs.push(input); nodes.push(label, input);
  }
  for (const paste of view.paste) {
    const input = Object.assign(document.createElement("input"), { type: "password", autocomplete: "off", spellcheck: false });
    input.dataset.name = paste.secret;
    const label = document.createElement("label");
    label.htmlFor = input.id = `channel-setup-${place}-${paste.secret}`;
    label.append(recipeWords(view, `paste-${paste.secret}`, paste.what));
    if (paste.optional) label.append(" ", make("span", "channel-setup.optional"));
    inputs.push(input); nodes.push(label, input);
  }
  return { inputs, nodes };
}

function enableChoice(view, place) {
  if (view.turnOn === "file") return { select: null, nodes: [make("p", "channel-setup.file-note", "field-note")] };
  const options = [
    ["", "channel-setup.enable.leave"],
    ["when-needed", "channel-setup.enable.when-needed"],
    ["on", "channel-setup.enable.on"]
  ];
  const select = dropdown({
    id: `channel-setup-${place}-enable`,
    options,
    value: ""
  });
  return { select, nodes: labelled(`channel-setup-${place}-enable`, "channel-setup.enable-label", select) };
}

function resultLines(view, answer) {
  const lines = [];
  if (answer.checked) lines.push(answer.botName ? t("channel-setup.checked-as", { name: answer.botName }) : t("channel-setup.checked"));
  if (answer.checked === null) lines.push(t("channel-setup.not-checked"));
  if (answer.saved.length) lines.push(t("channel-setup.saved", { names: answer.saved.join(", ") }));
  if (answer.switched) lines.push(t(`channel-setup.switched.${answer.switched}`));
  if (answer.connectNote) lines.push(answer.connectNote);
  return lines;
}

function showResult(view, place, answer) {
  const box = $(`channel-setup-result-${place}`);
  if (!box) return;
  box.replaceChildren(...resultLines(view, answer).map((line) => { const p = make("p", null, "subtle"); p.textContent = line; return p; }));
  if (answer.entry) {
    const code = make("code", null, "channel-setup-command");
    code.textContent = answer.entry;
    box.append(make("p", "channel-setup.entry-lead", "field-note"), code);
  }
  if (answer.pairing) box.append(wrap("p", "subtle", recipeWords(view, "pairing", answer.pairing)));
}

function pasteBlock(view, place) {
  const { inputs, nodes } = inputsFor(view, place);
  const choice = enableChoice(view, place);
  const said = status(state.said.get(place) ?? "");
  state.said.delete(place);
  // One filled button per card: on the Telegram card this one is quiet, because that card has its own.
  const save = make("button", "channel-setup.check-and-save", place === "telegram" ? "quiet-button" : undefined);
  save.type = "button";
  save.id = `channel-setup-save-${place}`;
  const off = (state.list?.mode ?? "off") === "off";
  save.disabled = off;
  save.addEventListener("click", async () => {
    const values = {};
    for (const input of inputs) if (input.value.trim()) values[input.dataset.name] = input.value.trim();
    said.textContent = t("channel-setup.checking");
    try {
      const answer = await api(`channel-setup/${view.id}/check`, { values, ...(choice.select?.value ? { enable: choice.select.value } : {}) });
      for (const input of inputs) if (input.type === "password") input.value = "";
      said.textContent = t("channel-setup.done");
      showResult(view, place, answer);
      if (view.turnOn === "guided") window.branchTelegramSetup?.refresh();
    } catch (error) { said.textContent = error instanceof Error ? error.message : String(error); }
  });
  const result = make("div", null, "channel-setup-result");
  result.id = `channel-setup-result-${place}`;
  return [make("p", "channel-setup.paste-lead", "field-note"), ...(view.paste.length ? [] : [make("p", "channel-setup.nothing-to-paste", "subtle")]),
    ...nodes, ...choice.nodes, ...(off ? [make("p", "channel-setup.off-note", "field-note")] : []),
    ...(view.hasCheck ? [] : [wrap("p", "subtle", recipeWords(view, "noCheck", view.noCheck))]), save, said, result];
}

function sourcesBlock(view) {
  const details = document.createElement("details");
  details.append(make("summary", "channel-setup.sources"));
  const list = document.createElement("ul");
  for (const source of view.sources) {
    const item = document.createElement("li");
    const anchor = Object.assign(document.createElement("a"), { href: source, target: "_blank", rel: "noreferrer noopener", textContent: new URL(source).host });
    item.append(anchor);
    list.append(item);
  }
  details.append(list, make("p", "channel-setup.official-only", "subtle"));
  return [details];
}

function panel(view, place) {
  const box = make("div", null, "channel-setup-panel");
  box.id = `channel-setup-panel-${place}`;
  box.dataset.app = view.id;
  box.append(...commandBlock(view, place), ...appBlock(view), ...codesBlock(view), ...createBlock(view, place),
    ...pasteBlock(view, place), ...sourcesBlock(view));
  return box;
}

async function panelFor(id) {
  if (!state.panels.has(id)) state.panels.set(id, await api(`channel-setup/${id}`));
  return state.panels.get(id);
}

function modeRow() {
  const options = MODES.map((mode) => [mode, `channel-setup.mode.${mode}`]);
  const select = dropdown({
    id: "channel-setup-mode",
    options,
    value: state.list.mode
  });
  const said = status();
  const save = quiet("channel-setup.mode-save", async () => {
    try { state.list = await api("channel-setup", { mode: select.value }); state.said.set("card", t("channel-setup.mode-saved")); await drawCard(); }
    catch (error) { said.textContent = error instanceof Error ? error.message : String(error); }
  });
  save.id = "channel-setup-mode-save";
  return [...labelled("channel-setup-mode", "channel-setup.mode-label", select), make("p", "channel-setup.mode-note", "field-note"), save, said];
}

function picker() {
  const options = state.list.channels.map((channel) => [channel.id, channel.name, channel.name]);
  const select = dropdown({
    id: "channel-setup-app",
    options,
    value: state.chosen
  });
  select.addEventListener("change", () => void choose(select.value, false));
  const label = make("label", "channel-setup.app-label");
  label.htmlFor = "channel-setup-app";
  return [label, select];
}

function card() {
  let node = $("channel-setup-card");
  if (node) return node;
  const after = $("channels-card");
  if (!after) return null;
  node = document.createElement("section");
  node.className = "card";
  node.id = "channel-setup-card";
  node.dataset.home = "customize:channels";
  after.after(node);
  return node;
}

async function drawCardPanel() {
  const slot = $("channel-setup-slot");
  if (!slot) return;
  slot.replaceChildren(panel(await panelFor(state.chosen), "card"));
}

async function drawCard() {
  const node = card();
  if (!node || !state.list) return;
  const slot = make("div");
  slot.id = "channel-setup-slot";
  node.replaceChildren(make("h2", "channel-setup.title"), make("p", "channel-setup.lead"), ...modeRow(), ...picker(), slot,
    make("p", "channel-setup.safety", "subtle"));
  await drawCardPanel();
}

async function choose(id, scroll = true) {
  state.chosen = id;
  const select = $("channel-setup-app");
  if (select) select.value = id;
  await drawCardPanel();
  if (scroll) $("channel-setup-card")?.scrollIntoView({ block: "start" });
}

/** Each "More chat apps" row gets a Set up button that opens this card on that app. */
function hookRows() {
  const list = $("channels-more-list");
  if (!list || !state.list) return;
  for (const select of list.querySelectorAll("details select[name]")) {
    const row = select.closest("details");
    if (!row || row.querySelector(".channel-setup-row") || !state.list.channels.some((each) => each.id === select.name)) continue;
    const button = quiet("channel-setup.row-button", () => void choose(select.name));
    button.classList.add("channel-setup-row");
    row.append(button);
  }
}

/** The Telegram card from never-break gets the same panel, folded, rather than a second Telegram card. */
async function hookTelegram() {
  const node = $("telegram-setup-card");
  if (!node || !state.list || node.querySelector("#channel-setup-panel-telegram")) return;
  const details = make("details", null, "channel-setup-telegram");
  details.append(make("summary", "channel-setup.telegram-summary"), panel(await panelFor("telegram"), "telegram"));
  if (!node.querySelector("#channel-setup-panel-telegram")) node.append(details);
}

let hooking = false;
function hookSoon() {
  if (hooking || !ownerAtWindow()) return;
  hooking = true;
  requestAnimationFrame(() => { hooking = false; hookRows(); hookTelegram().catch(() => {}); });
}

async function load() {
  if (!sessionStorage.getItem("branch-token") || !ownerAtWindow()) return;
  try { state.list = await api("channel-setup"); } catch { return; }
  state.panels.clear();
  await drawCard();
  hookSoon();
}

function addStyles() {
  if (document.querySelector('link[href="/channel-setup.css"]')) return;
  document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/channel-setup.css" }));
}

addStyles();
void load();
new MutationObserver(hookSoon).observe(document.body, { childList: true, subtree: true });
/* household-followups: the chat apps are the owner's. Switched to somebody else, the panels go; back
   to the owner, they are loaded afresh. */
document.addEventListener("branch-profile", (event) => {
  if (event.detail?.owner) { void load(); return; }
  state.list = null;
  state.panels.clear();
  document.querySelectorAll(".channel-setup-telegram, .channel-setup-row").forEach((node) => node.remove());
  $("channel-setup-card")?.replaceChildren();
});
document.addEventListener("branch-language", () => {
  document.querySelectorAll(".channel-setup-telegram").forEach((node) => node.remove());
  drawCard().then(hookSoon, () => {});
});
const signedIn = $("workspace");
if (signedIn) new MutationObserver(() => { if (!signedIn.hidden) setTimeout(() => void load(), 300); })
  .observe(signedIn, { attributes: true, attributeFilter: ["hidden"] });
window.branchChannelSetup = { refresh: load, choose };
