/* The dashboard's two footholds in the app window (served as /dashboard-card.js, so it is there even
   while the dashboard itself is switched off):

   1. The switch. A card in Customize → Channels, beside the other pages that reach Branch, with the
      owner's three-way switch — off, on, when needed — and a way to open the dashboard. It declares
      its home with data-home and public/layout.js moves it there; nothing here touches the layout.
   2. The way back in. Every link on the dashboard points at this window with #open=<place:tab> or
      #task=<id>. Once the window is ready and signed in, the place opens (through displayView, the
      same call the sidebar makes) or the task's "Look inside" sheet does, and the address is tidied. */
import { api, displayView } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const say = (key, english) => { const word = t(key); return word === key ? english : word; };
function make(tag, className, key, english) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  return node;
}

const POSITIONS = [
  ["off", "field.switch-off", "Off"],
  ["on", "field.switch-on", "On"],
  ["when-needed", "field.switch-when-needed", "Only when it is needed"],
];
const NOTES = {
  off: ["dashboard.card.off", "Off: the page is not served at all."],
  on: ["dashboard.card.on", "On: the page keeps itself up to date while it is open, with live updates of what is happening."],
  "when-needed": ["dashboard.card.whenNeeded", "When needed: the page reads everything once when you open it or press Refresh, and keeps nothing open in between."],
};

function noteFor(node, mode) {
  const [key, english] = NOTES[mode] ?? NOTES.off;
  node.dataset.t = key;
  node.textContent = say(key, english);
}

function buildCard(settings) {
  const card = make("section", "card");
  card.id = "dashboard-card";
  card.dataset.home = "customize:channels";
  card.append(make("h2", "", "dashboard.card.title", "Dashboard in the browser"),
    make("p", "", "dashboard.card.purpose", "One page that shows what Branch is doing, whether it is healthy and what it has cost — for a phone, another computer or a screen on the wall."));
  const label = make("label", "", "dashboard.card.switch", "The dashboard");
  label.htmlFor = "dashboard-mode";
  const select = document.createElement("select");
  select.id = "dashboard-mode";
  for (const [value, key, english] of POSITIONS) {
    const option = make("option", "", key, english);
    option.value = value;
    option.selected = value === settings.mode;
    select.append(option);
  }
  const note = make("p", "field-note");
  noteFor(note, settings.mode);
  select.addEventListener("change", () => noteFor(note, select.value));
  const where = make("p", "subtle", "dashboard.card.where", "It opens at /dashboard on this computer, and on your phone through the same paired address as the app, behind the same key.");
  card.append(label, select, note, where, ...actions(card, select, settings));
  return card;
}

function actions(card, select, settings) {
  const status = make("p", "subtle");
  status.setAttribute("role", "status");
  const save = make("button", "", "action.save", "Save");
  save.type = "button";
  const open = make("button", "quiet-button", "dashboard.card.open", "Open the dashboard");
  open.type = "button";
  open.id = "dashboard-open";
  open.hidden = settings.mode === "off";
  /* The same tab, so the key this tab holds comes along. */
  open.addEventListener("click", () => location.assign("/dashboard"));
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const saved = await api("dashboard/settings", { mode: select.value });
      open.hidden = saved.mode === "off";
      status.dataset.t = "dashboard.card.saved";
      status.textContent = say("dashboard.card.saved", "Saved.");
    } catch (error) {
      delete status.dataset.t;
      status.textContent = error.message;
    } finally { save.disabled = false; }
  });
  const row = document.createElement("div");
  row.className = "identity-actions";
  row.append(save, open);
  return [row, status];
}

/** Draws the card once the window is signed in; a failed read simply leaves it out. */
async function drawCard() {
  let settings;
  try { settings = await api("dashboard/settings"); } catch { return; }
  $("dashboard-card")?.remove();
  document.body.append(buildCard(settings));
}

/** #open=inbox:needs, #open=settings:data, #task=<id> — only names the window already knows. */
function followLink() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const route = hash.get("open"), task = hash.get("task");
  if (!route && !task) return;
  history.replaceState(null, "", location.pathname + location.search);
  const homes = globalThis.branchLayout?.homes?.() ?? [];
  if (route && homes.includes(route)) displayView(route);
  if (task && /^[a-f0-9-]{36}$/.test(task)) {
    displayView("inbox:history");
    globalThis.branchInspector?.open(task);
  }
}

/** Waits for the window to be built and signed in, then does both jobs. */
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

whenReady(() => {
  void drawCard();
  followLink();
});
addEventListener("hashchange", () => whenReady(followLink));
