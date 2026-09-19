// This computer's own cards, each placed by its `data-home` (docs/places.md):
//   settings:computer  what this computer allows (macOS and Linux), and how Branch uses the screen
//   settings:voice     the computer's own voice: off, when needed or on
//   settings:secrets   the Keychain entries Branch may read (macOS)
// Every word goes through a key, and every colour comes from the page's tokens.
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const token = () => sessionStorage.getItem("branch-token") || "";

async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + token(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
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
/** An element whose words come from a key, so switching language redraws it. */
function worded(tag, key, props = {}) {
  const node = el(tag, { ...props, textContent: t(key) });
  node.dataset.t = key;
  return node;
}
/** A card in the shape every card has: a title, one sentence, then its controls. */
function card(id, home, name, ...controls) {
  const section = el("section", { id, className: "card" },
    worded("h2", `settings.card.${name}`), worded("p", `settings.intro.${name}`), ...controls,
    el("p", { id: `${id}-status`, className: "subtle", role: "status" }));
  section.dataset.home = home;
  return section;
}
const status = (id, text) => { $(`${id}-status`).textContent = text; };

/* ---------- the owner's three-way switch ---------- */

const modes = ["off", "when-needed", "on"];

function modeSelect(id) {
  const select = el("select", { id });
  for (const mode of modes) select.append(worded("option", `switch.${mode}`, { value: mode }));
  return [worded("label", "field.feature-switch", { htmlFor: id }), select];
}

/** A card that is only the switch, and the one button that saves it. */
function switchCard(id, home, name, save) {
  const button = worded("button", "action.save-switch", { type: "button" });
  const section = card(id, home, name, ...modeSelect(`${id}-mode`), button);
  button.addEventListener("click", async () => {
    try {
      await save($(`${id}-mode`).value);
      choiceSaved(`${id}-mode`);
      status(id, t("keychain.status.saved"));
    } catch (e) {
      status(id, e.message);
    }
  });
  return section;
}

/**
 * ci-flakes-3: these cards are drawn again by the window's refresh every 3 seconds. A choice made here
 * and not yet saved must survive that: the saved answer is written in only while the choice on screen
 * is still the one this file last wrote. Otherwise Save sent the old value back.
 */
const lastDrawn = new Map();
function showChoice(id, value) {
  const choice = $(id);
  if (!choice) return;
  if (lastDrawn.has(id) && choice.value !== lastDrawn.get(id)) return; // their own unsaved choice
  choice.value = value;
  lastDrawn.set(id, choice.value);
}
/** Once a choice is saved it is the one on screen, so the next refresh may write over it again. */
const choiceSaved = (id) => lastDrawn.set(id, $(id)?.value);

async function renderSwitches() {
  const screen = await api("desktop/settings");
  showChoice("screen-switch-card-mode", screen.mode ?? (screen.enabled ? "when-needed" : "off"));
  const voice = await api("voice/plan");
  showChoice("system-voice-card-mode", voice.settings?.systemVoice ?? "off");
}

/* ---------- what this computer allows ---------- */

const macSettingsPrefix = "x-apple.systempreferences:com.apple.preference.security?Privacy_";
const nameKey = (platform, capability) =>
  capability === "screen" && platform === "darwin" ? "permissions.name.screen-mac" : `permissions.name.${capability}`;
function explainKey(platform, capability, session) {
  if (platform === "darwin") return `permissions.explain.mac.${capability}`;
  if (capability === "screen") return `permissions.explain.linux.screen.${session ?? "none"}`;
  return `permissions.explain.linux.${capability}`;
}

/** Opens one System Settings page, only because the owner pressed the button, through the app's own opener. */
async function openSystemSettings(link, where) {
  const say = (text) => status("os-permissions-card", text);
  if (typeof link !== "string" || !link.startsWith(macSettingsPrefix)) return say(t("permissions.status.cannot-open"));
  try {
    if (globalThis.branchDesktop?.openExternal) await globalThis.branchDesktop.openExternal(link);
    else el("a", { href: link }).click();
    say("");
  } catch {
    say(t("permissions.status.open-yourself", { where }));
  }
}

function permissionRow(item, platform, session) {
  const title = worded("strong", nameKey(platform, item.capability));
  const row = el("div", { className: "card-row" }, title,
    worded("p", explainKey(platform, item.capability, session), { className: "subtle" }));
  if (!item.allowed && platform === "darwin") row.append(worded("p", "permissions.refused"));
  if (platform === "darwin" && item.settingsLink) {
    const button = worded("button", "action.open-system-settings", { type: "button", className: "quiet-button" });
    button.addEventListener("click", () =>
      void openSystemSettings(item.settingsLink, t("permissions.where", { page: title.textContent })));
    row.append(button);
  }
  return row;
}

async function renderPermissions() {
  const data = await api("os-permissions");
  const shown = data.platform === "darwin" || data.platform === "linux";
  $("os-permissions-card").hidden = !shown;
  if (!shown) return;
  $("os-permissions-list").replaceChildren(...data.permissions.map((item) => permissionRow(item, data.platform, data.session)));
}

/* ---------- the Keychain list on a Mac ---------- */

let keychain = { enabled: false, entries: [] };
const keychainFields = ["name", "service", "account", "note"];

function field(name) {
  const id = `keychain-${name}`;
  const input = el("input", { id, maxLength: 200, placeholder: t(`keychain.placeholder.${name}`) });
  input.dataset.tPlaceholder = `keychain.placeholder.${name}`;
  return [worded("label", `field.keychain-${name}`, { htmlFor: id }), input];
}

function keychainCard() {
  const add = worded("button", "action.add-keychain-entry", { type: "button", id: "keychain-add", className: "quiet-button" });
  const save = worded("button", "action.save-keychain-list", { type: "button", id: "keychain-save" });
  add.addEventListener("click", addEntry);
  save.addEventListener("click", () => void saveKeychain({ mode: $("keychain-card-mode").value, entries: keychain.entries })
    .finally(() => choiceSaved("keychain-card-mode")));
  const section = card("keychain-card", "settings:secrets", "keychain",
    ...modeSelect("keychain-card-mode"),
    el("div", { id: "keychain-list", className: "card-list" }),
    ...keychainFields.flatMap(field), add, save);
  section.hidden = true;
  return section;
}

function entryRow(entry, index) {
  const remove = worded("button", "action.remove-keychain-entry", { type: "button", className: "quiet-button" });
  remove.addEventListener("click", () => {
    keychain.entries = keychain.entries.filter((_, at) => at !== index);
    showKeychain();
  });
  const what = entry.account ? `${entry.service} (${entry.account})` : entry.service;
  return el("div", { className: "card-row" },
    el("strong", { textContent: `secret://keychain/${entry.name}` }),
    el("p", { className: "subtle", textContent: [what, entry.note].filter(Boolean).join(" · ") }),
    remove);
}

function showKeychain() {
  showChoice("keychain-card-mode", keychain.mode ?? (keychain.enabled ? "when-needed" : "off"));
  const rows = keychain.entries.map(entryRow);
  $("keychain-list").replaceChildren(...(rows.length ? rows : [worded("p", "keychain.empty", { className: "subtle" })]));
}

function addEntry() {
  const value = (name) => $(`keychain-${name}`).value.trim();
  const entry = { name: value("name"), service: value("service"), note: value("note") };
  if (value("account")) entry.account = value("account");
  if (!entry.name || !entry.service) return status("keychain-card", t("keychain.status.missing"));
  keychain.entries = [...keychain.entries.filter((one) => one.name !== entry.name), entry];
  for (const name of keychainFields) $(`keychain-${name}`).value = "";
  showKeychain();
  status("keychain-card", t("keychain.status.added"));
}

async function saveKeychain(next) {
  try {
    keychain = await api("keychain/settings", next);
    showKeychain();
    status("keychain-card", t(keychain.enabled ? "keychain.status.saved" : "keychain.status.off"));
  } catch (e) {
    status("keychain-card", e.message);
  }
}

async function renderKeychain() {
  keychain = await api("keychain/settings");
  $("keychain-card").hidden = !keychain.available;
  if (keychain.available) showKeychain();
}

/* ---------- putting the cards on the page ---------- */

/** The cards are added to the Settings window once; `layout.js` takes each to its home. */
function place() {
  if ($("os-permissions-card")) return true;
  const settings = $("settings");
  if (!settings) return false;
  const permissions = card("os-permissions-card", "settings:computer", "what-this-computer-allows",
    el("div", { id: "os-permissions-list", className: "card-list" }));
  permissions.hidden = true;
  settings.append(
    permissions,
    switchCard("screen-switch-card", "settings:computer", "screen-switch", (mode) => api("desktop/settings", { mode })),
    switchCard("system-voice-card", "settings:voice", "system-voice", (mode) => api("voice/settings", { systemVoice: mode })),
    keychainCard());
  return true;
}

async function render() {
  if (!place()) return;
  for (const id of ["os-permissions-card", "screen-switch-card", "system-voice-card", "keychain-card"]) status(id, "");
  await renderPermissions().catch((e) => status("os-permissions-card", e.message));
  await renderKeychain().catch((e) => status("keychain-card", e.message));
  await renderSwitches().catch((e) => status("screen-switch-card", e.message));
}

// app.js asks the screen-control card to draw itself whenever Settings is drawn; these cards are
// drawn at the same moment, without touching that card.
const screenControl = window.branchScreenControl;
if (screenControl?.render) {
  const drawn = screenControl.render;
  screenControl.render = async (...args) => { await drawn(...args); await render(); };
}
window.branchOsPermissions = { render };
// The desktop app sends its token itself; a browser that is already signed in draws the cards now.
if (token()) void render();
