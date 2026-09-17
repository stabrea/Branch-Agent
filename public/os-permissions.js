// Settings → "What this computer allows" (macOS and Linux) and "Passwords from your Mac's Keychain"
// (macOS). Both cards are built here and placed after "Using your screen and keyboard"; on Windows
// neither appears. The owner's off / when needed / on choice for screen control is added to that
// card on every computer. Every word goes through a key.
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

/* ---------- the owner's three-way switch ---------- */

const modes = ["off", "when-needed", "on"];

/** Off / When needed / On, with its label; `save` is called with the mode chosen. */
function modeSwitch(id, labelKey, save) {
  const select = el("select", { id });
  for (const mode of modes) select.append(worded("option", `switch.${mode}`, { value: mode }));
  select.addEventListener("change", () => void save(select.value));
  return [worded("label", labelKey, { htmlFor: id }), select];
}

/** The screen-control card keeps its tick box; the three-way choice sits under it. */
function placeScreenSwitch() {
  if ($("desktop-mode")) return;
  const tick = $("desktop-enabled")?.closest("label");
  if (!tick) return;
  tick.after(...modeSwitch("desktop-mode", "field.feature-switch", async (mode) => {
    try {
      await api("desktop/settings", { mode });
      await window.branchScreenControl?.render();
    } catch (e) {
      $("desktop-status").textContent = e.message;
    }
  }));
  $("desktop-enabled").addEventListener("change", () => setTimeout(() => void renderScreenSwitch(), 400));
}

async function renderScreenSwitch() {
  const settings = await api("desktop/settings");
  if ($("desktop-mode")) $("desktop-mode").value = settings.mode ?? (settings.enabled ? "when-needed" : "off");
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

function permissionsCard() {
  return el("section", { id: "os-permissions-card", className: "card", hidden: true },
    worded("h2", "settings.card.what-this-computer-allows"),
    worded("p", "settings.intro.what-this-computer-allows", { className: "subtle" }),
    el("div", { id: "os-permissions-list", className: "card-list" }),
    el("p", { id: "os-permissions-status", className: "subtle", role: "status" }));
}

/** Opens one System Settings page, only because the owner pressed the button, through the app's own opener. */
async function openSettings(link, where) {
  const say = (text) => { $("os-permissions-status").textContent = text; };
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
    const button = worded("button", "action.open-system-settings", { type: "button" });
    button.addEventListener("click", () =>
      void openSettings(item.settingsLink, t("permissions.where", { page: title.textContent })));
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
  const add = worded("button", "action.add-keychain-entry", { type: "button", id: "keychain-add" });
  const save = worded("button", "action.save-keychain-list", { type: "button", id: "keychain-save" });
  add.addEventListener("click", addEntry);
  save.addEventListener("click", () => void saveKeychain({ entries: keychain.entries }));
  return el("section", { id: "keychain-card", className: "card", hidden: true },
    worded("h2", "settings.card.keychain"),
    worded("p", "settings.intro.keychain", { className: "subtle" }),
    ...modeSwitch("keychain-mode", "field.feature-switch", (mode) => saveKeychain({ mode })),
    el("div", { id: "keychain-list", className: "card-list" }),
    ...keychainFields.flatMap(field),
    add, save,
    el("p", { id: "keychain-status", className: "subtle", role: "status" }));
}

function entryRow(entry, index) {
  const remove = worded("button", "action.remove-keychain-entry", { type: "button" });
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
  $("keychain-mode").value = keychain.mode ?? (keychain.enabled ? "when-needed" : "off");
  const rows = keychain.entries.map(entryRow);
  $("keychain-list").replaceChildren(...(rows.length ? rows : [worded("p", "keychain.empty", { className: "subtle" })]));
}

function addEntry() {
  const value = (name) => $(`keychain-${name}`).value.trim();
  const entry = { name: value("name"), service: value("service"), note: value("note") };
  if (value("account")) entry.account = value("account");
  if (!entry.name || !entry.service) {
    $("keychain-status").textContent = t("keychain.status.missing");
    return;
  }
  keychain.entries = [...keychain.entries.filter((one) => one.name !== entry.name), entry];
  for (const name of keychainFields) $(`keychain-${name}`).value = "";
  showKeychain();
  $("keychain-status").textContent = t("keychain.status.added");
}

async function saveKeychain(next) {
  try {
    keychain = await api("keychain/settings", next);
    showKeychain();
    $("keychain-status").textContent = t(keychain.enabled ? "keychain.status.saved" : "keychain.status.off");
  } catch (e) {
    $("keychain-status").textContent = e.message;
  }
}

async function renderKeychain() {
  keychain = await api("keychain/settings");
  $("keychain-card").hidden = !keychain.available;
  if (keychain.available) showKeychain();
}

/* ---------- putting the cards on the page ---------- */

function place() {
  if ($("os-permissions-card")) return true;
  const anchor = $("desktop-card");
  if (!anchor) return false;
  anchor.after(permissionsCard(), keychainCard());
  return true;
}

async function render() {
  if (!place()) return;
  placeScreenSwitch();
  $("os-permissions-status").textContent = "";
  $("keychain-status").textContent = "";
  await renderPermissions().catch((e) => { $("os-permissions-status").textContent = e.message; });
  await renderKeychain().catch((e) => { $("keychain-status").textContent = e.message; });
  await renderScreenSwitch().catch(() => undefined);
}

// app.js asks the screen-control card to draw itself whenever Settings is drawn; these two cards sit
// under it, so they are drawn at the same moment.
const screenControl = window.branchScreenControl;
if (screenControl?.render) {
  const drawn = screenControl.render;
  screenControl.render = async (...args) => { await drawn(...args); await render(); };
}
window.branchOsPermissions = { render };
// The desktop app sends its token itself; a browser that is already signed in draws the cards now.
if (token()) void render();
