import { t } from "/i18n.js";
import { popover } from "/popover.js";

const $ = (id) => document.getElementById(id);
const say = (key, fallback) => t(key) === key ? fallback : t(key);
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function chevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("lx-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", "M6 9l6 6 6-6");
  svg.append(path);
  return svg;
}

function menuButton(text, role = "menuitem") {
  const row = element("button", "lx-more-item", text);
  row.type = "button";
  row.setAttribute("role", role);
  return row;
}

function menuKeys(event, menu, close) {
  if (event.key === "Tab") return close();
  const items = [...menu.querySelectorAll('[role^="menuitem"]:not(:disabled)')];
  const at = items.indexOf(document.activeElement);
  const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
  if (next === undefined || !items.length) return;
  event.preventDefault();
  items[(next + items.length) % items.length].focus();
}

function activeModel(models, session) {
  if (!$("model-controls")?.hidden && session?.effective) return session.effective;
  const active = models?.activePreset ?? models?.defaultPreset;
  return models?.presets?.find((preset) => preset.id === active) ?? null;
}

function modelChoice(option, select, close) {
  const row = menuButton(option.textContent.trim(), "menuitemradio");
  row.setAttribute("aria-checked", String(option.value === select.value));
  row.addEventListener("click", () => {
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    if (select.id === "models-active") $("models-form")?.requestSubmit();
    close();
  });
  return row;
}

function paintModelMenu(menu, close) {
  const select = $("model-controls")?.hidden ? $("models-active") : $("session-model");
  if (!select) return;
  const heading = element("p", "lx-more-head", say("composer.modelForConversation", "Model for this conversation"));
  heading.dataset.t = "composer.modelForConversation";
  const manage = menuButton(say("composer.manageModels", "Manage models…"));
  manage.dataset.t = "composer.manageModels";
  manage.addEventListener("click", () => { close(); globalThis.branchLayout?.go("settings:models"); });
  menu.replaceChildren(heading, ...[...select.options].map((option) => modelChoice(option, select, close)), element("hr", "lx-menu-rule"), manage);
}

function installModelPicker() {
  const old = $("lx-model-chip");
  if (!old || old.closest(".lx-model-wrap")) return;
  const chip = old.cloneNode(false);
  old.replaceWith(chip);
  const wrap = element("div", "lx-model-wrap");
  const name = element("span", "lx-model-name");
  const menu = element("div", "mode-menu lx-model-menu");
  menu.id = "lx-model-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  let models = globalThis.branchModelsNow ?? null;
  let session = null;
  let controller;
  const close = () => controller?.close();
  controller = popover(chip, menu, { onOpen: () => paintModelMenu(menu, close), afterOpen: () => menu.querySelector('[role^="menuitem"]')?.focus() });
  menu.addEventListener("keydown", (event) => menuKeys(event, menu, close));
  chip.replaceChildren(name, chevron());
  chip.setAttribute("aria-haspopup", "menu");
  wrap.append(chip, menu);
  $("send")?.before(wrap);
  const sync = () => {
    const active = activeModel(models, session);
    const practice = active?.provider === "offline-demo-fixture";
    name.textContent = practice ? say("composer.practiceModel", "Practice") : active?.model || say("composer.noModel", "Connect a model");
    chip.setAttribute("aria-label", `${say("composer.changeModel", "Change the model")}: ${name.textContent}`);
  };
  document.addEventListener("branch-models", (event) => { models = event.detail; sync(); });
  document.addEventListener("branch-session-model", (event) => { session = event.detail; sync(); });
  document.addEventListener("branch-language", sync);
  sync();
}

function action(target, key, fallback, close) {
  const row = menuButton(say(key, fallback));
  row.dataset.t = key;
  row.disabled = Boolean($(target)?.disabled);
  row.addEventListener("click", () => { $(target)?.click(); close(); });
  return row;
}

function assistant(option, select, close) {
  const row = menuButton(`${option.textContent}${option.selected ? "  ✓" : ""}`);
  row.addEventListener("click", () => {
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    close();
  });
  return row;
}

/* DG-175: "How it should work" and "Check back with me" become the + menu's choices; each sets the real select. */
function choices(id, close) {
  const select = $(id);
  if (!select) return [];
  const heading = element("p", "lx-more-head", document.querySelector(`label[for="${id}"]`)?.textContent.trim() ?? "");
  return [heading, ...[...select.options].map((option) => {
    const row = menuButton(option.textContent.trim(), "menuitemradio");
    row.setAttribute("aria-checked", String(option.value === select.value));
    row.disabled = select.disabled;
    row.addEventListener("click", () => {
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      close();
    });
    return row;
  })];
}
function planRows(close) {
  if (document.documentElement.dataset.everything !== "on" || !$("plan-controls")) return [];
  const project = menuButton($("plan-mode-project").textContent.trim());
  project.addEventListener("click", () => { $("plan-mode-project").click(); close(); });
  return [element("hr", "lx-menu-rule"), ...choices("session-plan-mode", close), ...choices("session-autonomy", close), project];
}

function paintPlusMenu(menu, close) {
  const select = $("composer-specialist");
  const assistants = select ? [...select.options].map((option) => assistant(option, select, close)) : [];
  const heading = element("p", "lx-more-head", say("more.assistant", "Who should answer"));
  heading.dataset.t = "more.assistant";
  menu.replaceChildren(
    action("composer-attach", "more.attach", "Attach a document…", close),
    action("composer-media", "more.picture", "Add a picture or a sound…", close),
    element("hr", "lx-menu-rule"),
    action("ask-first-toggle", "more.askFirst", "Ask me questions first", close),
    action("temporary-toggle", "more.temporaryLong", "Temporary: forget this conversation afterwards", close),
    ...planRows(close),
    ...(assistants.length ? [element("hr", "lx-menu-rule"), heading, ...assistants] : []),
  );
}

function installPlusMenu() {
  const old = document.querySelector(".lx-plus-wrap");
  if (!old) return;
  const wrap = element("div", "lx-plus-wrap");
  const plus = old.querySelector("#lx-plus").cloneNode(true);
  const menu = element("div", "lx-pop lx-plus-menu");
  menu.id = "lx-plus-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", plus.getAttribute("aria-label"));
  let controller;
  const close = () => controller?.close();
  controller = popover(plus, menu, { onOpen: () => paintPlusMenu(menu, close), afterOpen: () => menu.querySelector('[role^="menuitem"]')?.focus() });
  menu.addEventListener("keydown", (event) => menuKeys(event, menu, close));
  wrap.append(plus, menu);
  old.replaceWith(wrap);
}

/* ---------- DG-175: the line under the box, as the sample's with Show everything on ---------- */
function footChip(target, key, fallback) {
  const chip = element("button", "lx-foot-chip", say(key, fallback));
  chip.type = "button";
  chip.dataset.t = key;
  chip.dataset.target = target;
  chip.addEventListener("click", () => { $(target)?.click(); syncFootChips(); });
  return chip;
}
function syncFootChips() {
  for (const chip of document.querySelectorAll(".lx-foot-chip[data-target]"))
    chip.setAttribute("aria-pressed", String(Boolean($(chip.dataset.target)?.checked)));
  const who = $("composer-specialist"), chip = document.querySelector(".lx-foot-assistant");
  if (chip) chip.textContent = who?.selectedOptions[0]?.textContent.trim() || say("composer.assistantItself", "Your assistant");
}
function installFootChips() {
  const foot = document.querySelector(".composer-foot");
  if (!foot || foot.querySelector(".lx-foot-chips")) return;
  const chips = element("span", "lx-foot-chips");
  chips.append(footChip("ask-first-toggle", "more.askFirst", "Ask me questions first"),
    footChip("temporary-toggle", "composer.chip.temporary", "Temporary"), element("span", "lx-foot-chip lx-foot-assistant"));
  foot.prepend(chips);
  document.addEventListener("change", (event) => {
    if (["ask-first-toggle", "temporary-toggle", "composer-specialist"].includes(event.target?.id)) syncFootChips();
  });
  document.addEventListener("branch-language", syncFootChips);
  syncFootChips();
}

export function installGrownComposer() {
  installModelPicker();
  installPlusMenu();
  installFootChips();
}
