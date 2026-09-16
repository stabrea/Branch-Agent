/* The app shell: one rail (brand, quiet actions, sections, projects, conversations,
   the owner at the foot), one reading column, one context pane, and Ctrl+K to reach
   anything. No section hides behind a drop-down. */
import { api, displayView, openConversation, titles } from "/app.js";

const $ = (id) => document.getElementById(id);
const ICONS = {
  chat: "M4 5h16v10H8l-4 4z",
  runs: "M4 17l5-6 4 4 7-8",
  usage: "M5 19V9m7 10V5m7 14v-6",
  memory: "M12 4a4 4 0 00-4 4v8a4 4 0 008 0V8a4 4 0 00-4-4zm-4 6h8",
  skills: "M12 3l2.5 5.5L20 10l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-1.5z",
  documents: "M6 4h9l4 4v12H6zm9 0v4h4",
  specialists: "M9 11a3 3 0 100-6 3 3 0 000 6zm-5 8a5 5 0 0110 0m4-8h4m-4 4h4",
  procedures: "M6 4h9l4 4v12H6zm9 0v4h4M9 13h7M9 16h5",
  schedules: "M12 21a9 9 0 100-18 9 9 0 000 18zm0-14v5l3 2",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM4 12h2m12 0h2M12 4v2m0 12v2M6 6l1.5 1.5M16.5 16.5L18 18M18 6l-1.5 1.5M7.5 16.5L6 18",
  folder: "M4 6h6l2 2h8v10H4z",
  default: "M5 6h14M5 12h14M5 18h14",
};
const DAY = 86400000;

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name] ?? ICONS.default);
  svg.append(path);
  return svg;
}

/* ---------- the section rows ---------- */
for (const node of document.querySelectorAll(".nav")) {
  const label = document.createElement("span");
  label.textContent = node.textContent.trim();
  node.replaceChildren(icon(node.dataset.view), label);
  node.title = titles[node.dataset.view] ?? label.textContent;
}

/* ---------- groups that fold, and remember ---------- */
for (const head of document.querySelectorAll(".group-head")) {
  const key = "branch-group-" + head.dataset.toggle;
  const group = head.closest(".rail-group");
  const apply = (open) => {
    head.setAttribute("aria-expanded", String(open));
    group.dataset.open = String(open);
  };
  apply(localStorage.getItem(key) !== "closed");
  head.addEventListener("click", () => {
    const open = head.getAttribute("aria-expanded") !== "true";
    apply(open);
    localStorage.setItem(key, open ? "open" : "closed");
  });
}

/* ---------- the two panes that fold away ---------- */
const overlayRail = () => globalThis.innerWidth <= 860;
function pane(key, toggleId, className, onToggle) {
  const open = localStorage.getItem(key) !== "closed";
  document.body.classList.toggle(className, !open);
  $(toggleId).setAttribute("aria-pressed", String(open));
  $(toggleId).addEventListener("click", () => {
    if (onToggle?.()) return;
    const closed = document.body.classList.toggle(className);
    $(toggleId).setAttribute("aria-pressed", String(!closed));
    localStorage.setItem(key, closed ? "closed" : "open");
  });
}
/* On a narrow window the rail slides over the page instead of taking a column. */
pane("branch-rail", "rail-toggle", "no-rail", () => {
  if (!overlayRail()) return false;
  const open = document.body.classList.toggle("rail-open");
  $("rail-toggle").setAttribute("aria-pressed", String(open));
  return true;
});
pane("branch-aside", "aside-toggle", "no-aside");
const closeRailOverlay = () => document.body.classList.remove("rail-open");

/* ---------- the small menus ---------- */
function menu(buttonId, menuId, fill) {
  const trigger = $(buttonId), panel = $(menuId);
  const close = () => {
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!panel.hidden) return close();
    fill?.(panel);
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  });
  panel.addEventListener("click", () => close());
  document.addEventListener("click", () => {
    if (!panel.hidden) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) close();
  });
  return close;
}
menu("owner-menu-button", "owner-menu");
menu("app-switcher", "app-menu", (panel) => {
  panel.replaceChildren();
  const note = document.createElement("p");
  note.className = "menu-note";
  note.textContent = "Project";
  panel.append(note);
  for (const project of projects) {
    const row = document.createElement("button");
    row.type = "button";
    row.setAttribute("role", "menuitem");
    row.textContent = project.name;
    if (project.id === activeProject) row.setAttribute("aria-current", "true");
    row.addEventListener("click", () => switchProject(project.id));
    panel.append(row);
  }
  const manage = document.createElement("button");
  manage.type = "button";
  manage.setAttribute("role", "menuitem");
  manage.textContent = "Manage projects…";
  manage.addEventListener("click", () => displayView("settings"));
  panel.append(manage);
});
$("menu-settings").addEventListener("click", () => displayView("settings"));
$("menu-appearance").addEventListener("click", () => $("appearance-shortcut").click());
$("menu-updates").addEventListener("click", () => {
  displayView("settings");
  $("updates-check")?.click();
});
$("menu-about").addEventListener("click", () => {
  displayView("settings");
  globalThis.toast?.("Branch Agent by KeepOak — a personal assistant that runs on this computer.");
});
$("composer-attach").addEventListener("click", () => displayView("documents"));
$("context-change-model").addEventListener("click", () => displayView("settings"));
for (const chip of document.querySelectorAll(".chip[data-prompt]"))
  chip.addEventListener("click", () => {
    $("prompt").value = chip.dataset.prompt;
    $("prompt").focus();
  });

/** The suggestion chips prefer the owner's own recipes over the stock prompts. */
function suggestRecipes(procedures) {
  const chips = [...document.querySelectorAll(".chip[data-prompt]")];
  procedures.slice(0, chips.length).forEach((record, index) => {
    const name = record.data?.definition?.name;
    if (!name) return;
    chips[index].textContent = name;
    chips[index].dataset.prompt = `Run my “${name}” recipe.`;
  });
}

/* ---------- projects ---------- */
let projects = [], activeProject = null;
async function switchProject(id) {
  try {
    const active = await api("projects/active", { active: id });
    globalThis.toast?.(`Now working in ${active.name}.`);
    location.reload();
  } catch (error) {
    globalThis.toast?.(error.message);
  }
}
function drawProjects() {
  const list = $("rail-projects");
  list.replaceChildren();
  if (!projects.length) {
    const empty = document.createElement("p");
    empty.className = "rail-empty";
    empty.textContent = "No project folders yet.";
    list.append(empty);
    return;
  }
  for (const project of projects) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "rail-row";
    const label = document.createElement("span");
    label.textContent = project.name;
    row.append(icon("folder"), label);
    if (project.id === activeProject) row.setAttribute("aria-current", "true");
    row.addEventListener("click", () => switchProject(project.id));
    list.append(row);
  }
}

/* ---------- the conversation rows ---------- */
let conversations = [];
function dayName(time) {
  const start = new Date().setHours(0, 0, 0, 0);
  if (time >= start) return "Today";
  if (time >= start - DAY) return "Yesterday";
  if (time >= start - 6 * DAY) return "Earlier this week";
  if (time >= start - 30 * DAY) return "Earlier this month";
  return "Older";
}
/** One conversation: a single line, with rename, pin and delete revealed on hover. */
function railItem(entry) {
  const line = document.createElement("div");
  line.className = "rail-line";
  const name = titleOf(entry);
  const open = document.createElement("button");
  open.type = "button";
  open.className = "rail-item";
  open.textContent = (pinned.has(entry.sessionId) ? "📌 " : "") + name;
  open.title = name;
  open.addEventListener("click", async () => {
    displayView("chat");
    try {
      await openConversation(entry.sessionId);
    } catch (error) {
      globalThis.toast?.(error.message);
    }
    closeRailOverlay();
  });
  const actions = document.createElement("div");
  actions.className = "row-actions";
  actions.append(
    rowAction("✎", `Rename “${name}”`, () => renameConversation(entry, name)),
    rowAction("📌", `Pin “${name}”`, () => togglePin(entry.sessionId)),
    rowAction("✕", `Remove “${name}” from this list`, () => hideConversation(entry, name)),
  );
  line.append(open, actions);
  return line;
}
function rowAction(glyph, label, run) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = glyph;
  node.setAttribute("aria-label", label);
  node.title = label;
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    void run();
  });
  return node;
}
/* Names and pins are this browser's own labels; the conversation itself is untouched. */
const names = new Map(Object.entries(JSON.parse(localStorage.getItem("branch-names") || "{}")));
const pinned = new Set(JSON.parse(localStorage.getItem("branch-pins") || "[]"));
const buried = new Set(JSON.parse(localStorage.getItem("branch-buried") || "[]"));
const titleOf = (entry) => names.get(entry.sessionId) || entry.preview || "Empty conversation";
function renameConversation(entry, current) {
  const value = globalThis.prompt?.("Name for this conversation", current);
  if (value === null || value === undefined) return;
  if (value.trim()) names.set(entry.sessionId, value.trim());
  else names.delete(entry.sessionId);
  localStorage.setItem("branch-names", JSON.stringify(Object.fromEntries(names)));
  drawRail();
}
function togglePin(id) {
  if (pinned.has(id)) pinned.delete(id);
  else pinned.add(id);
  localStorage.setItem("branch-pins", JSON.stringify([...pinned]));
  drawRail();
}
/* Takes the row off this list only. The conversation is still in Saved conversations. */
function hideConversation(entry, name) {
  if (!globalThis.confirm?.(`Take “${name}” off this list? You can still find it under Saved conversations.`)) return;
  buried.add(entry.sessionId);
  localStorage.setItem("branch-buried", JSON.stringify([...buried]));
  drawRail();
}
function drawRail() {
  const list = $("rail-list");
  list.replaceChildren();
  const shown = conversations.filter((entry) => !buried.has(entry.sessionId));
  if (!shown.length) {
    const empty = document.createElement("p");
    empty.className = "rail-empty";
    empty.textContent = "No saved conversations yet. Start one and it appears here.";
    list.append(empty);
    return;
  }
  const order = [...shown].sort(
    (a, b) => Number(pinned.has(b.sessionId)) - Number(pinned.has(a.sessionId)),
  );
  let group = "";
  for (const entry of order) {
    const name = pinned.has(entry.sessionId) ? "Pinned" : dayName(new Date(entry.createdAt).getTime());
    if (name !== group) {
      group = name;
      const heading = document.createElement("p");
      heading.className = "rail-day";
      heading.textContent = name;
      list.append(heading);
    }
    list.append(railItem(entry));
  }
}
export async function loadRail() {
  try {
    const value = await api("sessions/search", { query: "", offset: 0 });
    conversations = value.sessions ?? [];
    drawRail();
  } catch {
    /* Not connected yet; the rail fills in once the workspace opens. */
  }
  try {
    const state = await api("state");
    projects = state.project?.all ?? [];
    activeProject = state.project?.active?.id ?? null;
    drawProjects();
    suggestRecipes(state.procedures ?? []);
    const owner = state.identity?.name || "Branch Agent";
    $("owner-name").textContent = state.project?.active?.name || "Your workspace";
    $("owner-initial").textContent = owner.slice(0, 1).toUpperCase();
  } catch {
    /* the owner row keeps its resting labels */
  }
}
$("rail-new").addEventListener("click", () => {
  displayView("chat");
  $("new-session").click();
  closeRailOverlay();
  setTimeout(loadRail, 400);
});
$("rail-find").addEventListener("click", () => openPalette());
$("cmd-open").addEventListener("click", () => openPalette());

/* ---------- the command palette ---------- */
let palette = null;
let matches = [];
let chosen = 0;
function entries() {
  const found = Object.entries(titles).map(([view, label]) => ({
    label,
    hint: "Section",
    run: () => displayView(view),
  }));
  found.push(
    { label: "New conversation", hint: "Ctrl N", run: () => $("rail-new").click() },
    { label: "Appearance settings", hint: "Ctrl ,", run: () => $("appearance-shortcut").click() },
    { label: "Check for updates", hint: "Action", run: () => { displayView("settings"); $("updates-check")?.click(); } },
  );
  for (const project of projects)
    found.push({ label: project.name, hint: "Project", run: () => switchProject(project.id) });
  for (const heading of document.querySelectorAll("#procedures-list h3"))
    found.push({ label: heading.textContent, hint: "Recipe", run: () => displayView("procedures") });
  for (const heading of document.querySelectorAll("#skills-list h3"))
    found.push({ label: heading.textContent, hint: "Skill", run: () => displayView("skills") });
  for (const entry of conversations)
    found.push({
      label: titleOf(entry),
      hint: "Conversation",
      run: () => { displayView("chat"); void openConversation(entry.sessionId); },
    });
  return found;
}
function drawPalette(query) {
  const needle = query.trim().toLowerCase();
  matches = entries().filter((item) => item.label.toLowerCase().includes(needle)).slice(0, 40);
  chosen = 0;
  const list = palette.querySelector(".cmd-list");
  list.replaceChildren();
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "cmd-empty";
    empty.textContent = "Nothing matches that.";
    list.append(empty);
    return;
  }
  matches.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cmd-item";
    button.dataset.target = String(index);
    button.append(document.createTextNode(item.label));
    const hint = document.createElement("small");
    hint.textContent = item.hint;
    button.append(hint);
    button.setAttribute("aria-selected", String(index === chosen));
    button.addEventListener("click", () => choose(index));
    list.append(button);
  });
}
function highlight(step) {
  if (!matches.length) return;
  chosen = (chosen + step + matches.length) % matches.length;
  palette.querySelectorAll(".cmd-item").forEach((node, index) => {
    node.setAttribute("aria-selected", String(index === chosen));
    if (index === chosen) node.scrollIntoView({ block: "nearest" });
  });
}
function choose(index) {
  const item = matches[index];
  closePalette();
  item?.run();
}
function buildPalette() {
  const root = document.createElement("div");
  root.className = "cmd";
  root.id = "cmd";
  root.hidden = true;
  root.innerHTML =
    '<div class="cmd-panel" role="dialog" aria-label="Find anything">' +
    '<input id="cmd-input" type="search" autocomplete="off" placeholder="Jump to a section, a conversation or an action…" aria-label="Find anything" />' +
    '<div class="cmd-list"></div></div>';
  root.addEventListener("click", (event) => {
    if (event.target === root) closePalette();
  });
  document.body.append(root);
  root.querySelector("input").addEventListener("input", (event) => drawPalette(event.target.value));
  return root;
}
export function openPalette() {
  palette ??= buildPalette();
  palette.hidden = false;
  const input = palette.querySelector("input");
  input.value = "";
  drawPalette("");
  input.focus();
}
function closePalette() {
  if (palette) palette.hidden = true;
}

/* ---------- keyboard ---------- */
document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "k") {
    event.preventDefault();
    if (palette?.hidden === false) closePalette();
    else openPalette();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === "n") {
    event.preventDefault();
    $("rail-new").click();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === ",") {
    event.preventDefault();
    $("appearance-shortcut").click();
    return;
  }
  if (palette?.hidden === false) {
    if (key === "escape") closePalette();
    if (key === "arrowdown") { event.preventDefault(); highlight(1); }
    if (key === "arrowup") { event.preventDefault(); highlight(-1); }
    if (key === "enter") { event.preventDefault(); choose(chosen); }
    return;
  }
  if (key === "escape" && document.body.classList.contains("rail-open")) closeRailOverlay();
});

/* ---------- the greeting shows only while the conversation is empty ---------- */
const conversation = $("conversation"), welcome = document.querySelector(".welcome");
const showWelcome = () => {
  welcome.hidden = conversation.childElementCount > 0;
};
showWelcome();
new MutationObserver(showWelcome).observe(conversation, { childList: true });

/* ---------- fill the rail once the workspace opens ---------- */
const workspace = $("workspace");
if (!workspace.hidden) void loadRail();
new MutationObserver(() => {
  if (!workspace.hidden) void loadRail();
}).observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
