// Settings → "What this computer allows" (macOS and Linux) and "Passwords from your Mac's Keychain"
// (macOS). Both cards are built here and placed after "Using your screen and keyboard". On Windows
// neither appears, so that screen stays exactly as it was.
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

/* ---------- what this computer allows ---------- */

const macSettingsPrefix = "x-apple.systempreferences:com.apple.preference.security?Privacy_";
const names = {
  darwin: { microphone: "Microphone", camera: "Camera", screen: "Screen & System Audio Recording", accessibility: "Accessibility" },
  linux: { microphone: "Microphone", camera: "Camera", screen: "Your screen", accessibility: "Pressing keys in other apps" },
};
const sessions = {
  x11: "Your desktop session is X11.",
  wayland: "Your desktop session is Wayland.",
  none: "There is no desktop session on this computer.",
};

function permissionsCard() {
  return el("section", { id: "os-permissions-card", className: "card", hidden: true },
    el("h2", { textContent: "What this computer allows" }),
    el("p", { textContent: "Besides Branch's own switches, this computer has switches of its own. Branch never changes them and never asks for them by itself; this list says what each one is for and where to find it." }),
    el("p", { id: "os-permissions-session", className: "subtle", hidden: true }),
    el("div", { id: "os-permissions-list", className: "card-list" }),
    el("p", { id: "os-permissions-status", className: "subtle", role: "status" }));
}

/** Opens one System Settings page, only because the owner pressed the button, through the app's own opener. */
async function openSettings(link, where) {
  const say = (text) => { $("os-permissions-status").textContent = text; };
  if (typeof link !== "string" || !link.startsWith(macSettingsPrefix)) return say("That page cannot be opened from here.");
  try {
    if (globalThis.branchDesktop?.openExternal) await globalThis.branchDesktop.openExternal(link);
    else el("a", { href: link }).click();
    say("");
  } catch {
    say(`Branch could not open System Settings from here. Open it yourself: ${where}.`);
  }
}

function permissionRow(item, platform) {
  const title = names[platform]?.[item.capability] ?? item.capability;
  const row = el("div", { className: "card-row" },
    el("strong", { textContent: title }),
    el("p", { className: "subtle", textContent: item.explanation }));
  if (item.message) row.append(el("p", { textContent: item.message }));
  if (platform === "darwin" && item.settingsLink) {
    const where = `System Settings, Privacy & Security, ${title}`;
    const button = el("button", { type: "button", textContent: "Open System Settings" });
    button.addEventListener("click", () => void openSettings(item.settingsLink, where));
    row.append(button);
  }
  return row;
}

async function renderPermissions() {
  const data = await api("os-permissions");
  const shown = data.platform === "darwin" || data.platform === "linux";
  $("os-permissions-card").hidden = !shown;
  if (!shown) return data;
  const session = $("os-permissions-session");
  session.hidden = data.platform !== "linux";
  session.textContent = sessions[data.session] ?? "";
  $("os-permissions-list").replaceChildren(...data.permissions.map((item) => permissionRow(item, data.platform)));
  return data;
}

/* ---------- the Keychain list on a Mac ---------- */

let keychain = { enabled: false, entries: [] };

function field(id, label, placeholder) {
  return [el("label", { htmlFor: id, textContent: label }), el("input", { id, maxLength: 200, placeholder })];
}

function keychainCard() {
  const toggle = el("input", { type: "checkbox", id: "keychain-enabled" });
  const add = el("button", { type: "button", id: "keychain-add", textContent: "Add this entry" });
  const save = el("button", { type: "button", id: "keychain-save", textContent: "Save the Keychain list" });
  toggle.addEventListener("change", () => void saveKeychain({ enabled: toggle.checked }));
  add.addEventListener("click", addEntry);
  save.addEventListener("click", () => void saveKeychain({ enabled: toggle.checked, entries: keychain.entries }));
  return el("section", { id: "keychain-card", className: "card", hidden: true },
    el("h2", { textContent: "Passwords from your Mac's Keychain" }),
    el("p", { textContent: "Branch can read a password out of this Mac's Keychain, but only for the entries you list here, and only when a task uses one. This list holds names, never passwords, and every read is written down." }),
    el("label", { className: "check-row" }, toggle, el("span", { textContent: " Let Branch read the Keychain entries listed here" })),
    el("div", { id: "keychain-list", className: "card-list" }),
    el("h3", { textContent: "Add an entry" }),
    ...field("keychain-name", "Short name (used as secret://keychain/name)", "for example github"),
    ...field("keychain-service", "The Keychain item's name (its Where)", "for example api.github.com"),
    ...field("keychain-account", "Its account, if more than one item has that name", "Leave empty if there is only one"),
    ...field("keychain-note", "What it is for", "Optional"),
    add, save,
    el("p", { id: "keychain-status", className: "subtle", role: "status" }));
}

function entryRow(entry, index) {
  const remove = el("button", { type: "button", textContent: "Remove" });
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
  $("keychain-enabled").checked = Boolean(keychain.enabled);
  const rows = keychain.entries.map(entryRow);
  $("keychain-list").replaceChildren(...(rows.length ? rows : [el("p", { className: "subtle", textContent: "No entries yet." })]));
}

function addEntry() {
  const value = (id) => $(id).value.trim();
  const entry = { name: value("keychain-name"), service: value("keychain-service"), note: value("keychain-note") };
  if (value("keychain-account")) entry.account = value("keychain-account");
  if (!entry.name || !entry.service) {
    $("keychain-status").textContent = "Give the entry a short name and the Keychain item's name.";
    return;
  }
  keychain.entries = [...keychain.entries.filter((one) => one.name !== entry.name), entry];
  for (const id of ["keychain-name", "keychain-service", "keychain-account", "keychain-note"]) $(id).value = "";
  showKeychain();
  $("keychain-status").textContent = "Added. Press Save to keep it.";
}

async function saveKeychain(next) {
  try {
    keychain = await api("keychain/settings", next);
    showKeychain();
    $("keychain-status").textContent = keychain.enabled ? "Saved." : "Saved. Branch will not read from your Keychain.";
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
  $("os-permissions-status").textContent = "";
  $("keychain-status").textContent = "";
  await renderPermissions().catch((e) => { $("os-permissions-status").textContent = e.message; });
  await renderKeychain().catch((e) => { $("keychain-status").textContent = e.message; });
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
