// Moving in: bring your chats, memory, instructions, skills and tool servers over from another
// assistant. The first-run card offers it in one sentence; the card under Settings shows a preview
// first, lets you tick what to bring, and says afterwards what came, what did not and why.
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const maximumUpload = 32 * 1024 * 1024;

async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function make(tag, text = "", className = "") {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
/** A node whose words live behind a key, so switching the language redraws it. */
function keyed(tag, key, className = "") {
  const node = make(tag, t(key), className);
  node.dataset.t = key;
  return node;
}
function button(key, onClick, className = "") {
  const node = keyed("button", key, className);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}
const say = (message) => { const node = $("move-in-status"); if (node) node.textContent = message; };

/* ------------------------------------------------------------------ the card */

function field(id, labelKey) {
  const input = make("input");
  input.id = id;
  const label = keyed("label", labelKey);
  label.htmlFor = id;
  return [label, input];
}

const modes = ["off", "when-needed", "on"];
let mode = "off";

function switchField() {
  const label = keyed("label", "field.movein-mode");
  const select = make("select");
  select.id = label.htmlFor = "move-in-mode";
  for (const value of modes) {
    const option = keyed("option", `memory.movein.mode.${value}`);
    option.value = value;
    select.append(option);
  }
  select.addEventListener("change", async () => {
    try { ({ mode } = await api("move-in/switch", { mode: select.value })); await refresh(); }
    catch (error) { say(error.message); }
  });
  return [label, select];
}

/** Shows what the switch allows: nothing when off, a "look" button when needed, the list when on. */
function showMode() {
  $("move-in-mode").value = mode;
  $("move-in-body").hidden = mode === "off";
  $("move-in-look").hidden = mode !== "when-needed";
  const hint = $("move-in-mode-hint"), key = mode === "on" ? "" : `memory.movein.${mode}`;
  hint.hidden = !key;
  hint.textContent = key ? t(key) : "";
  if (key) hint.dataset.t = key; else delete hint.dataset.t;
}

function buildCard() {
  const card = make("section", "", "card");
  card.id = "move-in-card";
  // Where the redesigned window places this card: Settings, among the things about your data.
  card.dataset.home = "settings:data";
  const [pathLabel, path] = field("move-in-path", "field.movein-path");
  path.placeholder = t("memory.movein.path-hint");
  path.dataset.tPlaceholder = "memory.movein.path-hint";
  path.maxLength = 4096;
  const [fileLabel, file] = field("move-in-file", "field.movein-file");
  file.type = "file";
  file.accept = ".zip,.tar,.tgz,.gz";
  const row = make("div", "", "input-row");
  row.append(path, button("action.movein-look-here", () => preview({ path: path.value.trim() }), "quiet-button"));
  const status = make("p", "", "subtle");
  status.id = "move-in-status";
  status.setAttribute("role", "status");
  const [sourcesBox, previewBox, broughtBox, body] = ["move-in-sources", "move-in-preview", "move-in-brought", "move-in-body"]
    .map((id) => Object.assign(make("div"), { id }));
  sourcesBox.className = "card-list";
  const look = button("action.movein-look-for", () => showSources(true).catch((error) => say(error.message)), "quiet-button");
  look.id = "move-in-look";
  const modeHint = make("p", "", "subtle");
  modeHint.id = "move-in-mode-hint";
  body.append(look, sourcesBox, pathLabel, row, fileLabel, file, status, previewBox, broughtBox);
  card.append(keyed("h2", "memory.movein.title"), keyed("p", "memory.movein.lead", "subtle"),
    ...switchField(), modeHint, body);
  file.addEventListener("change", () => openFile(file.files?.[0]));
  return card;
}

async function openFile(chosen) {
  if (!chosen) return;
  if (chosen.size > maximumUpload) { say(t("memory.movein.too-large")); return; }
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(chosen);
  });
  await preview({ archive: { name: chosen.name, data } });
}

let sources = [];

async function showSources(asked = false) {
  if (mode === "off" || (mode === "when-needed" && !asked)) { sources = []; $("move-in-sources").replaceChildren(); return; }
  ({ sources } = await api(asked ? "move-in?look=1" : "move-in"));
  const where = $("move-in-sources");
  where.replaceChildren();
  for (const entry of sources.filter((item) => item.found)) {
    const row = make("div", "", "card-row");
    const moved = Object.values(entry.moved).reduce((sum, count) => sum + count, 0);
    const words = moved ? t("memory.movein.found-moved", { folder: entry.folder, count: moved })
      : t("memory.movein.found", { folder: entry.folder });
    row.append(make("h4", entry.name), make("p", words, "subtle"),
      button("action.movein-see-what-is-there", () => preview({ source: entry.source }), "quiet-button"));
    where.append(row);
  }
  if (!where.children.length) where.append(keyed("p", "memory.movein.none-found", "subtle"));
}

/* ------------------------------------------------------------------ the preview */

let lastRequest = null;

function itemRow(item) {
  const label = make("label", "", "check-row");
  const box = make("input");
  box.type = "checkbox";
  box.value = item.key;
  box.checked = !item.blocked && !item.alreadyMoved;
  box.disabled = item.blocked || item.alreadyMoved;
  const detail = item.alreadyMoved ? t("memory.movein.already") : item.detail;
  const needs = item.needsKeys.length ? ` ${t("memory.movein.needs", { keys: item.needsKeys.join(", ") })}` : "";
  label.append(box, make("span", item.title), make("span", ` — ${detail}${needs}`, "subtle"));
  return label;
}

function groupBlock(group) {
  const block = make("details");
  block.open = group.kind !== "chat" || group.items.length <= 20;
  const open = group.items.filter((item) => !item.blocked && !item.alreadyMoved).length;
  const extra = open !== group.items.length ? `, ${t("memory.movein.can-come", { count: open })}` : "";
  block.append(make("summary", `${t(`memory.movein.kind.${group.kind}`)} (${group.items.length}${extra})`));
  const tick = (value) => () => block.querySelectorAll("input:not([disabled])").forEach((box) => { box.checked = value; });
  const actions = make("div", "", "identity-actions");
  actions.append(button("action.movein-tick-all", tick(true), "quiet-button"),
    button("action.movein-tick-none", tick(false), "quiet-button"));
  block.append(actions);
  for (const item of group.items) block.append(itemRow(item));
  return block;
}

function keysBlock(keys, headingKey) {
  const block = make("div");
  if (!keys.length) return block;
  const list = make("ul");
  for (const key of keys) list.append(make("li", `${key.name} — ${key.why}`));
  block.append(keyed("h3", headingKey), list, keyed("p", "memory.movein.keys-where", "subtle"));
  return block;
}

async function preview(request) {
  say(t("memory.movein.reading"));
  $("move-in-preview").replaceChildren();
  try {
    const found = await api("move-in/preview", request);
    lastRequest = { ...request, source: found.source };
    const where = $("move-in-preview");
    where.append(make("h3", t("memory.movein.from", { name: found.name })), make("p", found.from, "subtle"));
    for (const group of found.groups) where.append(groupBlock(group));
    where.append(keysBlock(found.keys, "memory.movein.keys-used"));
    for (const note of found.notes) where.append(make("p", note, "subtle"));
    if (found.groups.length) where.append(button("action.movein-bring", bring));
    say(t(found.groups.length ? "memory.movein.tick-then-bring" : "memory.movein.nothing"));
  } catch (error) { say(error.message); }
}

async function bring() {
  const items = [...$("move-in-preview").querySelectorAll("input[type=checkbox]:checked")].map((box) => box.value);
  if (!items.length) { say(t("memory.movein.tick-first")); return; }
  say(t("memory.movein.bringing", { count: items.length }));
  try {
    const receipt = await api("move-in/import", { ...lastRequest, items });
    const where = $("move-in-preview");
    where.replaceChildren(make("h3", t("memory.movein.brought-from", { name: receipt.name })));
    const list = make("ul");
    for (const entry of receipt.brought) list.append(make("li", `${entry.title} → ${entry.target}`));
    for (const entry of receipt.skipped)
      list.append(make("li", t("memory.movein.not-brought", { title: entry.title, reason: entry.reason })));
    where.append(list, keysBlock(receipt.keys, "memory.movein.keys-needed"));
    say(t("memory.movein.summary", { brought: receipt.brought.length, skipped: receipt.skipped.length }));
    await refresh();
  } catch (error) { say(error.message); }
}

/* ------------------------------------------------------------------ tool servers that came over */

async function showBrought() {
  const { servers, settings } = await api("move-in/brought");
  const where = $("move-in-brought");
  where.replaceChildren();
  if (settings.model)
    where.append(make("p", t("memory.movein.model", { source: settings.model.source, model: settings.model.value })));
  if (!servers.length) return;
  where.append(keyed("h3", "memory.movein.servers"), keyed("p", "memory.movein.servers-how", "subtle"));
  for (const entry of servers) {
    const row = make("details", "", "card-row");
    row.append(make("summary", t("memory.movein.server-from", { name: entry.name, source: entry.source })),
      make("pre", JSON.stringify(entry.server.connection, null, 2)));
    where.append(row);
  }
}

/* ------------------------------------------------------------------ the first-run offer */

function offerWords() {
  if (mode !== "on") return null;
  const waiting = sources.filter((entry) => entry.found && !Object.keys(entry.moved).length).map((entry) => entry.name);
  if (!waiting.length) return null;
  const names = waiting.length === 1 ? waiting[0]
    : `${waiting.slice(0, -1).join(", ")} ${t("memory.movein.or")} ${waiting[waiting.length - 1]}`;
  return t("memory.movein.offer", { names });
}

function showOffer() {
  const firstRun = $("first-run"), words = offerWords();
  $("move-in-offer")?.remove();
  if (!words || !firstRun) return;
  const line = make("p", "", "first-run-lead");
  line.id = "move-in-offer";
  const go = make("button", words, "quiet-button");
  go.type = "button";
  go.addEventListener("click", () => {
    document.querySelector('button.nav[data-view="settings"]')?.click();
    $("move-in-card")?.scrollIntoView({ block: "start" });
  });
  line.append(go);
  firstRun.querySelector(".doors")?.after(line);
}

async function refresh() {
  ({ mode } = await api("move-in/switch"));
  showMode();
  await Promise.all([showSources(), showBrought()]);
  showOffer();
}

async function start() {
  const settings = $("settings");
  if (!settings || $("move-in-card")) return;
  settings.append(buildCard());
  // Words built from values are redrawn when the language changes; keyed ones redraw themselves.
  document.addEventListener("branch-language", () => refresh().catch(() => undefined));
  // Before the owner has signed in the requests are refused, so the card is drawn again each time the
  // app, the Memory screen or the first-run card comes into view, and a refused draw is tried again a
  // few times while the sign-in finishes.
  let drawing = null;
  const redraw = (tries = 10) => {
    drawing ??= refresh().then(() => { drawing = null; }, () => {
      drawing = null;
      if (tries > 1) setTimeout(() => redraw(tries - 1), 1500);
    });
  };
  const watch = new MutationObserver((changes) => {
    if (changes.some((change) => !change.target.hidden)) redraw();
  });
  for (const node of [$("workspace"), settings, $("first-run")])
    if (node) watch.observe(node, { attributes: true, attributeFilter: ["hidden"] });
  redraw();
}

window.branchMoveIn = { render: () => refresh() };

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
