/* Wave mac3 (commands): the slash commands in the app window and on the phone.

   Three jobs, all reading the one table every surface shares (src/commands/catalog.ts):
   1. The "/" menu. Typing "/" at the start of the message box lists the commands this window offers,
      narrowed as you type; up and down choose, Tab or Enter fills one in, Esc closes. It appears only
      once the owner has switched the shared commands on (or to "when needed").
   2. Carrying a command out. The line goes to /api/commands/run with this tab's key, so the key's own
      limits apply; the answer is shown, and anything the page itself must do (open a place, tick a
      box, save a file) is done here with the same controls a person would use.
   3. The card. Settings › General gets "Typed commands": the three-way switch, and what works where. */
import { api, displayView, openConversation, loadSlashCommands, SLASH_COMMANDS } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const say = (key, english, values) => { const word = t(key, values); return word === key ? english : word; };
const toast = (text) => (typeof globalThis.toast === "function" ? globalThis.toast(text) : console.warn(text));
function make(tag, className, key, english) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  return node;
}
const surface = () => globalThis.branchSlashCommands?.surface?.() ?? "window";

/* ---------- carrying a command out ---------- */

function download(name, text) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
function toggle(action) {
  if (action.what === "pane") {
    const trigger = action.tab ? document.querySelector(`#lx-pane-tabs [data-pane="${action.tab}"]`) : $("aside-toggle");
    trigger?.click();
    return;
  }
  const box = action.what === "temporary" ? $("temporary-toggle") : null;
  if (box) {
    if (box.disabled) { toast(say("commands.temporaryLate", "A conversation becomes temporary when it starts: /new, then /temporary.")); return; }
    box.checked = action.on ?? !box.checked;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  const plan = $("session-plan-mode");
  if (!plan) return;
  const on = action.on ?? plan.value !== "show-plan";
  plan.value = on ? "show-plan" : "just-do-it";
  plan.dispatchEvent(new Event("change", { bubbles: true }));
}
const CLIENT = {
  go: (action) => displayView(action.home),
  toggle,
  new: () => $("new-session")?.click(),
  attach: () => $("composer-attach")?.click(),
  "refresh-model": () => globalThis.branchRefreshSessionModel?.(),
  download: (action) => download(action.name, action.text),
  "open-session": (action) => openConversation(action.id),
  theme: (action) => {
    const tile = document.querySelector(`#lx-theme-gallery .lx-tile[data-family="${CSS.escape(action.name)}"]`);
    if (tile) tile.click();
    else displayView("settings:appearance");
  },
  help: () => undefined,
};

/** Every key sends with POST, so what was typed never lands in an address; the server says what the key may do. */
const send = (line, sessionId) => api("commands/run", { surface: surface(), line, ...(sessionId ? { sessionId } : {}) });
globalThis.branchCatalogCommand = async function branchCatalogCommand(typed, sessionId) {
  try {
    const outcome = await send(typed, sessionId);
    if (!outcome.handled) return false;
    if (outcome.text) toast(outcome.text);
    if (outcome.client && !outcome.refused) await CLIENT[outcome.client.do]?.(outcome.client);
  } catch (error) { toast(error.message); }
  return true;
};

/* ---------- the "/" menu ---------- */

let menu = null, choices = [], selected = 0;
function closeMenu() {
  menu?.remove();
  menu = null;
  choices = [];
  $("prompt")?.removeAttribute("aria-activedescendant");
  $("prompt")?.setAttribute("aria-expanded", "false");
}
function drawMenu() {
  const box = $("prompt");
  if (!menu) {
    menu = make("ul", "slash-menu");
    menu.id = "slash-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", say("commands.menu", "Commands"));
    box.closest("form")?.prepend(menu);
    box.setAttribute("aria-controls", "slash-menu");
    box.setAttribute("aria-expanded", "true");
  }
  menu.replaceChildren(...choices.map(([name, what, details], index) => {
    const item = make("li", "slash-choice");
    item.id = `slash-choice-${index}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === selected));
    const title = make("strong");
    title.textContent = `${name}${details?.args ? ` ${details.args}` : ""}`;
    const about = make("span", "subtle");
    about.textContent = what;
    item.append(title, about);
    item.addEventListener("mousedown", (event) => { event.preventDefault(); fill(index); });
    return item;
  }));
  box.setAttribute("aria-activedescendant", `slash-choice-${selected}`);
}
function fill(index) {
  const [name] = choices[index] ?? [];
  if (!name) return;
  $("prompt").value = `${name} `;
  closeMenu();
  $("prompt").focus();
}
async function update() {
  const box = $("prompt");
  const typed = box.value;
  if (!/^\/[\w?-]*$/.test(typed)) { closeMenu(); return; }
  await loadSlashCommands();
  const mode = SLASH_COMMANDS.find(([, , details]) => details)?.[2]?.mode ?? "off";
  if (mode === "off") { closeMenu(); return; }
  const word = typed.slice(1).toLowerCase();
  const shown = SLASH_COMMANDS.filter(([, , details]) => !details || details.listed);
  /* A name that starts with what was typed comes before a command found by one of its other names. */
  choices = [...shown.filter(([name]) => name.slice(1).startsWith(word)),
    ...shown.filter(([name, , details]) => !name.slice(1).startsWith(word) && details?.aliases?.some((alias) => alias.startsWith(word)))].slice(0, 12);
  selected = 0;
  if (!choices.length) { closeMenu(); return; }
  drawMenu();
}
function onKey(event) {
  if (!menu) return;
  const moves = { ArrowDown: 1, ArrowUp: -1 };
  if (event.key in moves) {
    selected = (selected + moves[event.key] + choices.length) % choices.length;
    drawMenu();
  } else if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && $("prompt").value.trim() !== choices[selected]?.[0])) {
    fill(selected);
  } else if (event.key === "Escape") {
    closeMenu();
  } else return;
  event.preventDefault();
  event.stopImmediatePropagation();
}
function wireMenu() {
  const box = $("prompt");
  if (!box || box.dataset.slashMenu) return;
  box.dataset.slashMenu = "1";
  box.setAttribute("aria-autocomplete", "list");
  box.addEventListener("input", () => void update());
  /* Capture, so the menu answers Enter before the message box sends. */
  box.addEventListener("keydown", onKey, true);
  box.addEventListener("blur", () => setTimeout(closeMenu, 100));
}

/* ---------- the card ---------- */

const POSITIONS = [
  ["off", "field.switch-off", "Off"],
  ["on", "field.switch-on", "On"],
  ["when-needed", "field.switch-when-needed", "Only when it is needed"],
];
const NOTES = {
  off: ["commands.card.off", "Off: each place keeps only the commands it always had."],
  on: ["commands.card.on", "On: every command below works where it is listed, and every list shows it."],
  "when-needed": ["commands.card.whenNeeded", "When needed: every command works when you type it, but the lists show only the everyday ones; /help all shows the rest."],
};
const WHERE = {
  window: ["commands.where.window", "window"], phone: ["commands.where.phone", "phone"], terminal: ["commands.where.terminal", "terminal"],
  chat: ["commands.where.chat", "chat apps"], dashboard: ["commands.where.dashboard", "dashboard"],
};
function noteFor(node, mode) {
  const [key, english] = NOTES[mode] ?? NOTES.off;
  node.dataset.t = key;
  node.textContent = say(key, english);
}
function whereList(table) {
  const list = make("ul", "commands-where");
  for (const command of table.commands) {
    const item = make("li");
    const name = make("code");
    name.textContent = `/${command.name}`;
    const where = make("span", "subtle");
    where.textContent = ` ${command.surfaces.map((place) => say(...WHERE[place])).join(", ")} — ${say(command.key, command.english)}`;
    item.append(name, where);
    list.append(item);
  }
  const details = make("details");
  details.append(make("summary", "", "commands.card.where", "What works where"), list);
  return details;
}
function buildCard(settings, table) {
  const card = make("section", "card");
  card.id = "commands-card";
  card.dataset.home = "settings:general";
  card.append(make("h2", "", "commands.card.title", "Typed commands"),
    make("p", "subtle", "commands.card.purpose", "Commands that start with a slash, such as /status or /help, and work the same in this window, on your phone, in the terminal and in chat apps."));
  const label = make("label", "", "commands.card.switch", "The shared commands");
  label.htmlFor = "commands-mode";
  const select = document.createElement("select");
  select.id = "commands-mode";
  for (const [value, key, english] of POSITIONS) {
    const option = make("option", "", key, english);
    option.value = value;
    option.selected = value === settings.mode;
    select.append(option);
  }
  const note = make("p", "field-note");
  noteFor(note, settings.mode);
  select.addEventListener("change", () => noteFor(note, select.value));
  card.append(label, select, note, ...saveRow(select, settings), whereList(table));
  return card;
}
function saveRow(select, settings) {
  const status = make("p", "subtle");
  status.setAttribute("role", "status");
  const save = make("button", "", "action.save", "Save");
  save.type = "button";
  save.id = "commands-save";
  save.disabled = settings.access !== "full";
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await api("commands/settings", { mode: select.value });
      await loadSlashCommands(true);
      status.dataset.t = "commands.card.saved";
      status.textContent = say("commands.card.saved", "Saved.");
    } catch (error) {
      delete status.dataset.t;
      status.textContent = error.message;
    } finally { save.disabled = false; }
  });
  return [save, status];
}
async function drawCard() {
  let settings, table;
  try { [settings, table] = await Promise.all([api("commands/settings"), api("commands/table")]); } catch { return; }
  $("commands-card")?.remove();
  document.body.append(buildCard(settings, table));
}

function whenReady(work) {
  const ready = () => document.body.classList.contains("lx-ready") && $("workspace") && !$("workspace").hidden;
  if (ready()) { work(); return; }
  const watch = new MutationObserver(() => {
    if (!ready()) return;
    watch.disconnect();
    work();
  });
  watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  if ($("workspace")) watch.observe($("workspace"), { attributes: true, attributeFilter: ["hidden"] });
}
wireMenu();
whenReady(() => {
  void loadSlashCommands(true);
  void drawCard();
});
