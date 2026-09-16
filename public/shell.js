/* The app shell: a thin icon column for the sections, a rail of conversations,
   one main pane, a context pane that folds away, and Ctrl+K to reach anything.
   No section hides behind a drop-down. */
import { api, displayView, openConversation, titles } from "/app.js";

const $ = (id) => document.getElementById(id);
const ICONS = {
  chat: "M4 5h16v10H8l-4 4z",
  runs: "M4 17l5-6 4 4 7-8",
  usage: "M5 19V9m7 10V5m7 14v-6",
  memory: "M12 4a4 4 0 00-4 4v8a4 4 0 008 0V8a4 4 0 00-4-4zm-4 6h8",
  skills: "M12 3l2.5 5.5L20 10l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-1.5z",
  specialists: "M9 11a3 3 0 100-6 3 3 0 000 6zm-5 8a5 5 0 0110 0m4-8h4m-4 4h4",
  procedures: "M6 4h9l4 4v12H6zm9 0v4h4M9 13h7M9 16h5",
  schedules: "M12 21a9 9 0 100-18 9 9 0 000 18zm0-14v5l3 2",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM4 12h2m12 0h2M12 4v2m0 12v2M6 6l1.5 1.5M16.5 16.5L18 18M18 6l-1.5 1.5M7.5 16.5L6 18",
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

/* ---------- the icon column ---------- */
for (const button of document.querySelectorAll(".nav")) {
  button.prepend(icon(button.dataset.view));
  button.title = titles[button.dataset.view] ?? button.textContent.trim();
}

/* ---------- the two panes that fold away ---------- */
const overlayRail = () => globalThis.innerWidth <= 1000;
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

/* ---------- the conversation rail ---------- */
let conversations = [];
function dayName(time) {
  const start = new Date().setHours(0, 0, 0, 0);
  if (time >= start) return "Today";
  if (time >= start - DAY) return "Yesterday";
  if (time >= start - 6 * DAY) return "Earlier this week";
  if (time >= start - 30 * DAY) return "Earlier this month";
  return "Older";
}
function railItem(entry) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "rail-item";
  button.textContent = entry.preview || "Empty conversation";
  button.title = button.textContent;
  button.addEventListener("click", async () => {
    displayView("chat");
    try {
      await openConversation(entry.sessionId);
    } catch (error) {
      globalThis.toast?.(error.message);
    }
    document.body.classList.remove("rail-open");
  });
  return button;
}
function drawRail() {
  const list = $("rail-list");
  list.replaceChildren();
  if (!conversations.length) {
    const empty = document.createElement("p");
    empty.className = "rail-empty";
    empty.textContent = "No saved conversations yet. Start one and it appears here.";
    list.append(empty);
    return;
  }
  let group = "";
  for (const entry of conversations) {
    const name = dayName(new Date(entry.createdAt).getTime());
    if (name !== group) {
      group = name;
      const heading = document.createElement("p");
      heading.className = "rail-group";
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
}
$("rail-new").addEventListener("click", () => {
  displayView("chat");
  $("new-session").click();
  document.body.classList.remove("rail-open");
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
  for (const heading of document.querySelectorAll("#procedures-list h3"))
    found.push({ label: heading.textContent, hint: "Recipe", run: () => displayView("procedures") });
  for (const heading of document.querySelectorAll("#skills-list h3"))
    found.push({ label: heading.textContent, hint: "Skill", run: () => displayView("skills") });
  for (const entry of conversations)
    found.push({
      label: entry.preview || "Empty conversation",
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
  if (key === "escape" && document.body.classList.contains("rail-open"))
    document.body.classList.remove("rail-open");
});

/* ---------- fill the rail once the workspace opens ---------- */
const workspace = $("workspace");
if (!workspace.hidden) void loadRail();
new MutationObserver(() => {
  if (!workspace.hidden) void loadRail();
}).observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
