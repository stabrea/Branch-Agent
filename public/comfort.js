/**
 * R17-S-C: comfort. The cards for shortcuts and vim keys, the status line and message times,
 * notifications, sound and updates, the push-to-talk key and the longest recording, the browser's
 * care, the proxy and certificates, ignore files and the tool servers' start-up time. The values
 * live on the server (src/comfort/); this file shows them, sends changes back, and puts them to work
 * in the window.
 *
 * Each card says where it lives with `data-home` (docs/places.md). Every control is described by
 * the sentence right after it, linked with aria-describedby. Every word is behind a key.
 *
 * Nothing here plays a sound, shows a notification or installs anything by itself in a test: a
 * sound goes through `branchComfort.player`, a notification is public/app.js's own (this only tells
 * it to stay quiet), and updates go through `window.branchDesktop`; a test replaces the first and
 * the last.
 */
import { t, formatDate } from "/i18n.js";
import { dropdown } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
let view = null;
const token = () => sessionStorage.getItem("branch-token") || "";

async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || t("comfort.failed"));
  return data;
}
function keyed(tag, key, className, values) {
  const node = document.createElement(tag);
  node.textContent = t(key, values);
  if (!values) node.dataset.t = key;
  if (className) node.className = className;
  return node;
}

/* ---------- the cards ---------- */
const sw = (name, def) => ({ name, kind: "switch", def });
const pick = (name, def, options) => ({ name, kind: "select", def, options });
const combo = (name, def) => ({ name, kind: "keys", def });
const CARDS = [
  { id: "keys", card: "keys", home: "settings:general", fields: [
    combo("palette", "Ctrl+K"), combo("newConversation", "Ctrl+N"), combo("appearance", "Ctrl+,"), combo("sidePane", "Ctrl+Shift+K"),
    sw("vim", false)] },
  { id: "files", card: "files", home: "settings:general", fields: [sw("respectGitignore", true), { name: "extraIgnoreFiles", kind: "lines", def: [] }] },
  { id: "display", card: "display", home: "settings:appearance", fields: [{ name: "statusLine", kind: "status", def: null }, sw("timestamps", false)] },
  { id: "notify", card: "notify", home: "settings:notifications", fields: [pick("method", "system", ["system", "window"]), pick("sound", "off", ["off", "chime", "knock"])] },
  // Redesign phase 1: three choice cards rather than a list, with the one Branch recommends marked.
  { id: "updates", card: "notify", home: "settings:about", fields: [{ name: "autoUpdate", kind: "cards", def: "off", options: ["off", "check", "install"], recommended: "install" }] },
  { id: "voice", card: "voice", home: "settings:voice", fields: [combo("pushToTalkKey", ""), { name: "maxRecordingSeconds", kind: "number", min: 5, max: 600, def: null }] },
  { id: "browser", card: "browser", home: "settings:computer", warn: "comfort.warn.owner", fields: [
    sw("confirmSensitive", false), sw("blockUploads", false), pick("dialogs", "dismiss", ["dismiss", "accept"])] },
  { id: "network", card: "network", home: "settings:computer", warn: "comfort.warn.owner",
    // Integration review: what a proxy and an added certificate can see, in plain words, before anything is set.
    dangers: ["comfort.warn.proxy", "comfort.warn.certificates"], fields: [
    { name: "proxy", kind: "text", def: null }, { name: "noProxy", kind: "lines", def: [] }, { name: "caCertificates", kind: "certs", def: [] }] },
  { id: "mcp", card: "mcp", home: "customize:connections", fields: [{ name: "startupTimeoutSeconds", kind: "number", min: 1, max: 300, def: 10 }] },
];

function note(id, key) {
  const text = keyed("p", key, "subtle field-note");
  text.id = `${id}-note`;
  return text;
}
function labelled(id, name, control) {
  const label = keyed("label", `comfort.field.${name}`);
  label.htmlFor = id;
  control.id = id;
  control.setAttribute("aria-describedby", `${id}-note`);
  return [label, control, note(id, `comfort.note.${name}`)];
}
function option(value, key) {
  const node = keyed("option", key);
  node.value = value;
  return node;
}

/** A box that takes the keys pressed in it ("Ctrl+Shift+K"); Backspace empties it. */
function keysBox(field, id, value) {
  const input = Object.assign(document.createElement("input"), { type: "text", value: value ?? "", autocomplete: "off" });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if ((event.key === "Backspace" || event.key === "Delete") && !event.ctrlKey && !event.altKey) { input.value = ""; return; }
    const written = comboOf(event);
    if (written) input.value = written;
  });
  return { nodes: labelled(id, field.name, input), read: () => input.value.trim(), set: (v) => { input.value = v ?? ""; } };
}
function statusBox(field, id, value) {
  const box = document.createElement("fieldset");
  box.append(keyed("legend", "comfort.field.statusLine"));
  const own = dropdown({
    id: `${id}-mode`,
    options: [["always", "comfort.option.as-always"], ["mine", "comfort.option.my-choice"]],
    value: "always"
  });
  own.setAttribute("aria-describedby", `${id}-note`);
  const ownLabel = keyed("label", "comfort.field.statusMode");
  ownLabel.htmlFor = own.id;
  box.append(ownLabel, own);
  const ticks = (view?.statusItems ?? ["model", "context", "folder", "cost", "time"]).map((item) => {
    const tick = Object.assign(document.createElement("input"), { type: "checkbox", id: `${id}-${item}`, value: item });
    tick.setAttribute("aria-describedby", `${id}-note`);
    const label = keyed("label", `comfort.status.item.${item}`);
    label.prepend(tick);
    box.append(label);
    return tick;
  });
  const set = (v) => {
    own.value = v === null ? "always" : "mine";
    for (const tick of ticks) { tick.checked = v === null ? false : v.includes(tick.value); tick.disabled = v === null; }
  };
  own.addEventListener("change", () => set(own.value === "always" ? null : ["model", "context", "cost"]));
  set(value);
  const read = () => (own.value === "always" ? null : ticks.filter((tick) => tick.checked).map((tick) => tick.value));
  return { nodes: [box, note(id, "comfort.note.statusLine")], read, set };
}

function control(field, value) {
  const id = `comfort-${field.name}`;
  if (field.kind === "switch" || field.kind === "select") {
    const optionsList = field.kind === "switch" ? ["on", "off"] : field.options;
    const select = dropdown({
      id: id,
      options: optionsList.map(one => [one, `comfort.option.${one}`]),
      value: field.kind === "switch" ? (value ? "on" : "off") : value
    });
    const read = () => (field.kind === "switch" ? select.value === "on" : select.value);
    const set = (v) => { select.value = field.kind === "switch" ? (v ? "on" : "off") : v; };
    return { nodes: labelled(id, field.name, select), read, set };
  }
  if (field.kind === "number" || field.kind === "text") {
    const input = document.createElement("input");
    Object.assign(input, field.kind === "number" ? { type: "number", min: String(field.min), max: String(field.max), step: "1" } : { type: "text", autocomplete: "off" });
    input.value = value === null || value === undefined ? "" : String(value);
    if (field.def === null) input.placeholder = t("comfort.placeholder.none");
    const read = () => (input.value.trim() === "" ? field.def : field.kind === "number" ? Number(input.value) : input.value.trim());
    return { nodes: labelled(id, field.name, input), read, set: (v) => { input.value = v === null ? "" : String(v); } };
  }
  if (field.kind === "lines") {
    const area = Object.assign(document.createElement("textarea"), { rows: 3, value: (value ?? []).join("\n") });
    const read = () => area.value.split(/[\s,]+/).filter(Boolean);
    return { nodes: labelled(id, field.name, area), read, set: (v) => { area.value = v.join("\n"); } };
  }
  if (field.kind === "keys") return keysBox(field, id, value);
  if (field.kind === "cards") return choiceCards(field, id, value);
  if (field.kind === "status") return statusBox(field, id, value);
  return certificates(field, id, value);
}

/** Redesign phase 1: one card per choice, each saying what it does; picking one saves it at once. */
function choiceCards(field, id, value) {
  const group = document.createElement("fieldset");
  group.className = "choice-cards";
  group.id = id;
  group.setAttribute("role", "radiogroup");
  group.append(keyed("legend", `comfort.field.${field.name}`));
  const radios = field.options.map((choice) => {
    const card = document.createElement("label");
    card.className = "choice-card";
    const radio = Object.assign(document.createElement("input"), { type: "radio", name: id, value: choice, checked: choice === value });
    const title = document.createElement("b");
    title.append(keyed("span", `comfort.update.${choice}`));
    if (choice === field.recommended) title.append(" ", keyed("span", "suggest.recommended", "choice-recommended"));
    const words = document.createElement("span");
    const said = keyed("small", `comfort.update.${choice}.note`);
    said.id = `${id}-${choice}-note`;
    radio.setAttribute("aria-describedby", said.id);
    words.append(title, said);
    card.append(radio, words);
    group.append(card);
    return radio;
  });
  const read = () => radios.find((radio) => radio.checked)?.value ?? field.def;
  const set = (v) => { for (const radio of radios) radio.checked = radio.value === v; };
  return { nodes: [group], read, set, instant: true };
}

/** The owner's extra certificates: each one listed with what it is, and a way to add another. */
function certificates(field, id, value) {
  let list = [...(value ?? [])];
  const holder = document.createElement("div");
  holder.id = `${id}-list`;
  const name = Object.assign(document.createElement("input"), { type: "text", autocomplete: "off" });
  const pem = Object.assign(document.createElement("textarea"), { rows: 4, placeholder: "-----BEGIN CERTIFICATE-----" });
  const draw = () => {
    holder.replaceChildren();
    for (const entry of list) {
      const row = document.createElement("div");
      row.className = "comfort-cert";
      const about = (view?.certificates ?? []).find((one) => one.name === entry.name);
      row.append(Object.assign(document.createElement("strong"), { textContent: entry.name }),
        Object.assign(document.createElement("span"), { className: "subtle", textContent: about?.problem ?? about?.subject ?? "" }));
      const remove = keyed("button", "comfort.action.remove", "quiet-button");
      remove.type = "button";
      remove.addEventListener("click", () => { list = list.filter((one) => one !== entry); draw(); });
      row.append(remove);
      holder.append(row);
    }
  };
  draw();
  const read = () => (pem.value.trim() ? [...list, { name: name.value.trim() || t("comfort.cert.unnamed"), pem: pem.value.trim() }] : list);
  const set = (v) => { list = [...v]; name.value = ""; pem.value = ""; draw(); };
  return { nodes: [keyed("h4", "comfort.field.caCertificates", "settings-card-subtitle"), holder,
    ...labelled(`${id}-name`, "caName", name), ...labelled(`${id}-pem`, "caPem", pem)], read, set };
}

function actions(spec, controls, status) {
  const row = document.createElement("div");
  row.className = "identity-actions";
  const send = async (body, done) => {
    try {
      view = await api("comfort", body);
      apply();
      draw();
      // The card was drawn again with what is now in force; its fresh status line says so.
      const fresh = $(`comfort-${spec.id}-card`)?.querySelector("[role=status]") ?? status;
      fresh.textContent = t(done);
      fresh.dataset.t = done;
    } catch (error) { status.textContent = error.message; delete status.dataset.t; }
  };
  const save = keyed("button", "comfort.action.save");
  save.type = "button";
  save.addEventListener("click", () => send({ card: spec.card, values: Object.fromEntries(controls.map(([field, c]) => [field.name, c.read()])) }, "comfort.saved"));
  const reset = keyed("button", "comfort.action.reset", "quiet-button");
  reset.type = "button";
  reset.addEventListener("click", () => {
    for (const [field, c] of controls) c.set(field.def);
    void send({ card: spec.card, values: Object.fromEntries(spec.fields.map((field) => [field.name, field.def])) }, "comfort.reset-done");
  });
  row.append(save, reset);
  return row;
}
function buildCard(spec) {
  const card = document.createElement("section");
  card.className = "card";
  card.id = `comfort-${spec.id}-card`;
  card.dataset.home = spec.home;
  const settings = spec.home.startsWith("settings:");
  card.append(keyed(settings ? "h3" : "h2", `comfort.${spec.id}.title`, settings ? "settings-card-title" : ""),
    keyed("p", `comfort.${spec.id}.lead`, "subtle"));
  if (spec.warn) card.append(keyed("p", spec.warn, "field-note"));
  for (const danger of spec.dangers ?? []) card.append(keyed("p", danger, "field-note local-warning"));
  if (spec.id === "network" && view.network.proxy === "needs a newer Node") card.append(keyed("p", "comfort.network.old-node", "field-note"));
  const controls = spec.fields.map((field) => [field, control(field, view.values[spec.card][field.name])]);
  for (const [, c] of controls) card.append(...c.nodes);
  if (spec.id === "notify") card.append(tryButton());
  const status = document.createElement("p");
  status.className = "subtle";
  status.setAttribute("role", "status");
  const row = actions(spec, controls, status);
  card.append(row, status);
  /* A card of choices saves the moment one is picked, as the sample's update cards do. */
  if (controls.some(([, c]) => c.instant))
    card.addEventListener("change", (event) => { if (event.target.type === "radio") row.querySelector("button")?.click(); });
  /* DG-184: the sample saves how Branch gets your attention as you choose (DG-025), so that card has no Save. */
  if (spec.id === "notify") {
    const save = row.querySelector("button");
    save.remove(); // still pressed below, out of sight
    card.addEventListener("change", (event) => { if (event.target.matches("select")) save.click(); });
  }
  return card;
}
function tryButton() {
  const button = keyed("button", "comfort.action.try-sound", "quiet-button");
  button.type = "button";
  button.addEventListener("click", () => comfort.player($("comfort-sound")?.value || "chime"));
  return button;
}
function place(card) {
  const existing = $(card.id);
  if (existing) existing.replaceWith(card); else document.body.append(card);
}
function draw() {
  if (!view) return;
  for (const spec of CARDS) place(buildCard(spec));
}

/* ---------- R17-S15: shortcuts and vim keys ---------- */
const keyName = (key) => (key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key);
/** The keys of a key press, written the way the settings store them, or "" for a lone modifier. */
export function comboOf(event) {
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return "";
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  const name = keyName(event.key);
  if (!parts.length && !/^F([1-9]|1[0-2])$/.test(name)) return "";
  return [...parts, name].join("+");
}
const defaults = { palette: "Ctrl+K", newConversation: "Ctrl+N", appearance: "Ctrl+,", sidePane: "Ctrl+Shift+K" };
const bound = (action) => view?.values.keys[action] ?? view?.values.voice[action] ?? defaults[action] ?? "";
/** True when this key press is the owner's keys for an action. */
function pressed(event, action) {
  const keys = bound(action);
  return !!keys && comboOf(event).toLowerCase() === keys.toLowerCase();
}
/** The keys for an action as the palette shows them ("Ctrl N"), or "" when none. */
const hint = (action) => bound(action).replaceAll("+", " ");

const vim = { mode: "insert", pending: "" };
function vimIndicator(box) {
  let badge = $("comfort-vim-mode");
  if (!badge) {
    badge = document.createElement("span");
    badge.id = "comfort-vim-mode";
    badge.className = "meta";
    box.closest("form")?.after(badge);
  }
  const key = vim.mode === "normal" ? "comfort.vim.normal" : "comfort.vim.insert";
  badge.textContent = t(key);
  badge.dataset.t = key;
  badge.hidden = !view?.values.keys.vim;
  box.dataset.vimMode = vim.mode;
}
const lineStart = (text, at) => text.lastIndexOf("\n", at - 1) + 1;
const lineEnd = (text, at) => { const end = text.indexOf("\n", at); return end === -1 ? text.length : end; };
function vertical(text, at, down) {
  const start = lineStart(text, at), column = at - start;
  if (down) { const end = lineEnd(text, at); if (end >= text.length) return at; const next = end + 1; return Math.min(next + column, lineEnd(text, next)); }
  if (start === 0) return at;
  const previous = lineStart(text, start - 1);
  return Math.min(previous + column, start - 1);
}
/** Where a normal-mode motion puts the cursor, or null when the key is not a motion. */
export function vimMotion(text, at, key) {
  switch (key) {
    case "h": return Math.max(lineStart(text, at), at - 1);
    case "l": return Math.min(Math.max(lineStart(text, at), lineEnd(text, at) - 1), at + 1);
    case "0": return lineStart(text, at);
    case "$": return Math.max(lineStart(text, at), lineEnd(text, at) - 1);
    case "j": return vertical(text, at, true);
    case "k": return vertical(text, at, false);
    case "w": { const found = /\s\S/.exec(text.slice(at)); return found ? at + found.index + 1 : text.length; }
    case "b": { const before = text.slice(0, at).replace(/\S*\s*$/, ""); return before.length === at ? Math.max(0, at - 1) : before.length; }
    default: return null;
  }
}
/** Carries out one normal-mode key on the box. */
function vimKey(box, key) {
  const text = box.value, at = box.selectionStart ?? 0;
  const put = (value, cursor) => { box.value = value; box.setSelectionRange(cursor, cursor); box.dispatchEvent(new Event("input", { bubbles: true })); };
  const moved = vimMotion(text, at, key);
  if (moved !== null) { box.setSelectionRange(moved, moved); return; }
  if (key === "d" && vim.pending !== "d") { vim.pending = "d"; return; }
  const pending = vim.pending;
  vim.pending = "";
  if (key === "d" && pending === "d") {
    const start = lineStart(text, at), end = Math.min(text.length, lineEnd(text, at) + 1);
    return put(text.slice(0, start) + text.slice(end), Math.min(start, text.length - (end - start)));
  }
  if (key === "x") return put(text.slice(0, at) + text.slice(at + 1), Math.min(at, Math.max(0, text.length - 2)));
  const insertAt = { i: at, a: Math.min(text.length, at + 1), I: lineStart(text, at), A: lineEnd(text, at) }[key];
  if (insertAt !== undefined) { vim.mode = "insert"; box.setSelectionRange(insertAt, insertAt); return vimIndicator(box); }
  if (key === "o" || key === "O") {
    const where = key === "o" ? lineEnd(text, at) : lineStart(text, at);
    put(text.slice(0, where) + "\n" + text.slice(where), key === "o" ? where + 1 : where);
    vim.mode = "insert";
    vimIndicator(box);
  }
}
function onVimKey(event) {
  const box = event.target;
  if (!view?.values.keys.vim || box?.id !== "prompt") return;
  if (event.key === "Escape" && vim.mode === "insert") {
    event.preventDefault();
    event.stopImmediatePropagation();
    vim.mode = "normal";
    vim.pending = "";
    return vimIndicator(box);
  }
  if (vim.mode !== "normal" || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "Escape") return; // a second Esc leaves the box, as it always has
  if (event.key.length !== 1 && event.key !== "Enter" && event.key !== "Backspace") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.key.length === 1) vimKey(box, event.key);
}

/* ---------- R17-S16: the status line and message times ---------- */
const sessionNow = () => $("conversation")?.dataset.sessionId || "";
function statusPiece(item, facts) {
  if (item === "context") return t("comfort.status.context", { percent: Math.round(Math.min(1, facts.used / 128000) * 100) });
  if (item === "folder") return facts.folder.split(/[\\/]/).filter(Boolean).pop() || facts.folder;
  if (item === "time") return formatDate(new Date(), { timeStyle: "short" });
  return facts[item] ?? "";
}
function paintStatus(status) {
  let line = $("comfort-status");
  if (!line) {
    const foot = document.querySelector(".composer-foot");
    if (!foot) return;
    line = document.createElement("p");
    line.id = "comfort-status";
    line.className = "composer-note meta";
    line.setAttribute("aria-live", "polite");
    foot.prepend(line);
  }
  line.hidden = status.items === null;
  if (status.items !== null) line.textContent = status.items.map((item) => statusPiece(item, status.facts)).filter(Boolean).join(" · ");
}
function stamp(node, at) {
  let time = node.querySelector(":scope > .message-time");
  if (!time) {
    time = document.createElement("time");
    time.className = "message-time meta";
    const author = node.querySelector(":scope > small");
    if (author) author.after(time); else node.prepend(time);
  }
  time.dateTime = at;
  time.textContent = formatDate(new Date(at), { timeStyle: "short" });
}
/** Puts each turn's times on its messages: the question when the task started, the answer when it ended. */
function paintTimes(status) {
  const nodes = [...document.querySelectorAll("#conversation > .message.user, #conversation > .message.assistant")];
  if (!status.timestamps) { for (const node of nodes) node.querySelector(":scope > .message-time")?.remove(); return; }
  let turn = -1;
  const lastAnswer = new Map();
  for (const node of nodes) {
    if (node.classList.contains("user")) { turn += 1; node.dataset.turn = String(turn); continue; }
    lastAnswer.set(Math.max(0, turn), node);
  }
  for (const node of nodes) {
    const at = node.classList.contains("user") ? status.turns[Number(node.dataset.turn)]?.startedAt : null;
    if (at) stamp(node, at);
    else if (node.classList.contains("user") && !node.querySelector(":scope > .message-time")) stamp(node, new Date().toISOString());
  }
  for (const [index, node] of lastAnswer) {
    const at = status.turns[index]?.finishedAt;
    if (at) stamp(node, at);
  }
}
let painting = null;
async function refreshStatus() {
  if (!token() || $("workspace")?.hidden) return;
  const here = sessionNow();
  painting ??= api(`comfort/status${here ? `?session=${encodeURIComponent(here)}` : ""}`)
    .then((status) => { paintStatus(status); paintTimes(status); })
    .catch(() => undefined)
    .finally(() => { painting = null; });
  await painting;
}

/* ---------- R17-S17: notifications, sound and updates ---------- */
function playTone(kind) {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Context) return;
  const audio = new Context();
  const tone = audio.createOscillator(), level = audio.createGain();
  tone.frequency.value = kind === "knock" ? 220 : 880;
  level.gain.setValueAtTime(0.15, audio.currentTime);
  level.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + (kind === "knock" ? 0.12 : 0.4));
  tone.connect(level).connect(audio.destination);
  tone.start();
  tone.stop(audio.currentTime + 0.45);
  tone.onended = () => void audio.close();
}
/**
 * Called by public/app.js for each new "your assistant needs you". Plays the owner's sound, and
 * says "handled" when the owner wants the banner only, so no notification comes from the computer.
 */
function attention(item) {
  const choice = view?.values.notify;
  if (!choice) return "default";
  if (choice.sound !== "off") comfort.player(choice.sound);
  if (choice.method === "window") return "handled";
  return "default";
}

let updateTimer = null;
let updateAttempt = false;
function scheduleUpdate() {
  clearTimeout(updateTimer);
  const notify = view?.values.notify;
  if (!notify || notify.autoUpdate === "off" || !window.branchDesktop) return;
  const interval = notify.autoUpdate === "install" ? 30_000
    : notify.releaseChannel !== "stable" ? 5 * 60 * 1000 : 60 * 60 * 1000;
  updateTimer = setTimeout(() => void autoUpdate(), interval);
}
async function autoUpdate() {
  const desktop = window.branchDesktop;
  /* Until the owner's choice has been read, treat it as off: never go looking for an update
     before we know it was wanted. */
  if (updateAttempt || !desktop || !token() || (view?.values.notify.autoUpdate ?? "off") === "off") return;
  clearTimeout(updateTimer);
  updateAttempt = true;
  try {
    let status = await desktop.updateStatus();
    let plan = await api("comfort/update-plan", { updaterPhase: status?.phase });
    if (plan.step === "check") {
      status = await desktop.checkForUpdates();
      plan = await api("comfort/update-plan", { updaterPhase: status?.phase, checked: true });
    }
    // The same path as the Update button: checksum, a try on a copy of your work, a safety copy.
    if (plan.step === "install") await desktop.installUpdate();
    else if (plan.mode === "check" && status?.phase === "available") globalThis.toast?.(t("comfort.update.ready"));
  } catch { /* the next look tries again */ }
  finally {
    updateAttempt = false;
    // The server records completion, so start the next delay after that response, not on a
    // fixed tick that can arrive just before the check is due. Read the latest owner choice:
    // a refresh while this attempt was pending must not revive an old channel or an off timer.
    scheduleUpdate();
  }
}

/* ---------- R17-S18: push-to-talk and the longest recording ---------- */
let talking = false;
const modifiers = ["Control", "Alt", "Shift", "Meta"];
/** Holding the owner's key presses Talk; letting go of it (or of a key held with it) lets Talk go. */
function onTalkKey(event, down) {
  const button = $("voice-talk");
  if (!button || !view?.values.voice.pushToTalkKey) return;
  if (down) {
    if (!pressed(event, "pushToTalkKey")) return;
    event.preventDefault();
    if (event.repeat || talking) return;
  } else {
    const last = bound("pushToTalkKey").split("+").pop().toLowerCase();
    if (!talking || (keyName(event.key).toLowerCase() !== last && !modifiers.includes(event.key))) return;
  }
  talking = down;
  button.dispatchEvent(new PointerEvent(down ? "pointerdown" : "pointerup", { bubbles: true }));
}
const maxRecordingSeconds = () => view?.values.voice.maxRecordingSeconds ?? null;

/* ---------- putting it to work ---------- */
function apply() {
  /* DG-097: anything that shows the owner's keys (the top-bar search box) redraws from `hint`. */
  document.dispatchEvent(new Event("branch-comfort"));
  const box = $("prompt");
  if (box) vimIndicator(box);
  if (!view?.values.keys.vim) vim.mode = "insert";
  void refreshStatus();
  clearTimeout(updateTimer);
  if (view?.values.notify.autoUpdate !== "off" && window.branchDesktop) {
    void autoUpdate();
  }
}
async function refresh() {
  if (!token()) return;
  try { view = await api("comfort"); draw(); apply(); } catch { /* signed out or offline: the next look tries again */ }
}
async function afterSignIn(tries = 20) {
  for (let left = tries; left > 0 && !token(); left--) await new Promise((done) => setTimeout(done, 250));
  await refresh();
}

const comfort = {
  refresh, pressed, hint, attention, maxRecordingSeconds, comboOf, vimMotion, refreshStatus, autoUpdate,
  /** Plays a sound; replaced in tests so nothing is heard. */
  player: playTone,
  get values() { return view?.values ?? null; },
};

if (typeof document !== "undefined") {
  globalThis.branchComfort = comfort;
  document.addEventListener("keydown", onVimKey, true);
  document.addEventListener("keydown", (event) => onTalkKey(event, true), true);
  document.addEventListener("keyup", (event) => onTalkKey(event, false), true);
  document.addEventListener("branch-language", draw);
  void refresh();
  const signedIn = $("workspace");
  if (signedIn) new MutationObserver(() => { if (!signedIn.hidden) void afterSignIn(); }).observe(signedIn, { attributes: true, attributeFilter: ["hidden"] });
  const conversation = $("conversation");
  let soon = null;
  if (conversation) new MutationObserver(() => { clearTimeout(soon); soon = setTimeout(() => void refreshStatus(), 150); })
    .observe(conversation, { childList: true, attributes: true, attributeFilter: ["data-session-id"] });
  setInterval(() => void refreshStatus(), 15000);
}
