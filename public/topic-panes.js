/* FQ-surfaces.panes: "Compare topics side by side" — a read-only view that opens several
   conversations (topics) as columns next to each other, so the owner can arrange them and check
   what each one really said without losing their place in the one they had open.

   Each column reads its own conversation through GET /api/sessions/:id and paints only into the
   DOM node it was built for; a column never reaches into another column's element or a shared
   "current messages" variable, so a slow reply for one topic (or two topics loading at once) can
   never land in the wrong column. That is the whole gap this closes: arranging several topics side
   by side, and messages staying correctly assigned to their own topic while it does.

   Opened from More → Go to → "Compare topics side by side" (a real, if visually hidden, title-bar
   control other buttons can be pointed at, matching how the rest of the More menu works). New
   surface; nothing existing was rewired to make room for it.

   Only a leaf whose whole text IS one locale string carries `data-t` (i18n.js repaints every
   `[data-t]` node on any insertion or language change); a symbol-only button carries `data-t-label`
   instead so its aria-label, not its glyph, is what gets translated, and dynamic text read out of a
   conversation (titles, message bodies, picker previews) carries neither. */
import { api } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const say = (key, english, values) => {
  const word = t(key, values);
  return word === key ? english.replace(/\{(\w+)\}/g, (whole, name) => (values && name in values ? String(values[name]) : whole)) : word;
};
function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
/** A leaf whose entire text is one static locale string: marked so i18n.js keeps it in step. */
function worded(tag, className, key, english) {
  const node = make(tag, className, say(key, english));
  node.dataset.t = key;
  return node;
}
/** A button whose face is a symbol, not words: only its aria-label follows the language. */
function labelled(node, key, english) {
  node.dataset.tLabel = key;
  node.setAttribute("aria-label", say(key, english));
  return node;
}
const STORE_KEY = "branch-topic-panes";
const store = {
  get() {
    try { const value = JSON.parse(sessionStorage.getItem(STORE_KEY) || "[]"); return Array.isArray(value) ? value.filter((id) => typeof id === "string") : []; }
    catch { return []; }
  },
  set(ids) { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(ids)); } catch { /* a private window forgets, and that is fine */ } },
};

/** Session ids, left to right, in the order their columns are drawn. */
let panes = [];
let overlay = null, grid = null, pickerPop = null, emptyNote = null, returnFocus = null;

function firstLine(text) {
  return String(text ?? "").split("\n").find((line) => line.trim().length) ?? "";
}

/** Builds one column and starts its own, independent load; nothing here is shared with any other column. */
function buildColumn(sessionId) {
  const col = make("section", "topic-pane-col");
  col.dataset.sessionId = sessionId;
  col.setAttribute("role", "group");
  const head = make("header", "topic-pane-head");
  const move = make("div", "topic-pane-move");
  const left = make("button", "topic-pane-arrow", "‹");
  left.type = "button";
  labelled(left, "topicPanes.moveLeft", "Move left");
  left.addEventListener("click", () => movePane(sessionId, -1));
  const right = make("button", "topic-pane-arrow", "›");
  right.type = "button";
  labelled(right, "topicPanes.moveRight", "Move right");
  right.addEventListener("click", () => movePane(sessionId, 1));
  move.append(left, right);
  const title = make("h3", "topic-pane-title", say("topicPanes.loading", "Loading…")); // dynamic once loaded — no data-t
  const refresh = worded("button", "topic-pane-refresh", "topicPanes.refresh", "Refresh");
  refresh.type = "button";
  refresh.addEventListener("click", () => load());
  const close = make("button", "topic-pane-close", "×");
  close.type = "button";
  labelled(close, "topicPanes.remove", "Remove this topic");
  close.addEventListener("click", () => removePane(sessionId));
  head.append(move, title, refresh, close);
  const body = make("div", "topic-pane-body");
  col.append(head, body);

  /* Every read below is scoped to this one call's `sessionId`, `title` and `body` — never to `panes`,
     `grid` or another column's elements — so this closure is the only thing that can paint here. */
  async function load() {
    let view;
    try { view = await api(`sessions/${sessionId}`); }
    catch { title.textContent = say("topicPanes.gone", "This conversation could not be read."); return; }
    if (!panes.includes(sessionId)) return; // the topic was removed while this request was in flight
    const opening = view.messages.find((message) => message.role === "user" || message.role === "assistant");
    title.textContent = firstLine(opening?.content).slice(0, 60) || say("topicPanes.untitled", "Untitled conversation");
    title.title = title.textContent;
    const rows = view.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => {
        const row = make("article", `topic-pane-message topic-pane-${message.role}`);
        row.dataset.sessionId = sessionId;
        row.dataset.messageId = String(message.messageId);
        row.append(message.role === "user" ? worded("p", "topic-pane-role", "topicPanes.you", "You")
          : worded("p", "topic-pane-role", "topicPanes.assistant", "Assistant"));
        row.append(make("p", "topic-pane-text", message.content)); // the conversation's own words — no data-t
        return row;
      });
    body.replaceChildren(...(rows.length ? rows : [worded("p", "topic-pane-empty", "topicPanes.noMessages", "No messages yet.")]));
  }
  void load();
  return col;
}

function syncMoveButtons() {
  const cols = [...grid.children];
  cols.forEach((col, index) => {
    col.querySelector(".topic-pane-arrow:first-child").disabled = index === 0;
    col.querySelector(".topic-pane-arrow:last-child").disabled = index === cols.length - 1;
  });
}
function syncEmptyNote() {
  emptyNote.hidden = panes.length > 0;
}
function addPane(sessionId) {
  if (panes.includes(sessionId)) return;
  panes.push(sessionId);
  store.set(panes);
  grid.append(buildColumn(sessionId));
  syncMoveButtons();
  syncEmptyNote();
}
function removePane(sessionId) {
  if (!panes.includes(sessionId)) return;
  panes = panes.filter((id) => id !== sessionId);
  store.set(panes);
  grid.querySelector(`.topic-pane-col[data-session-id="${sessionId}"]`)?.remove();
  syncMoveButtons();
  syncEmptyNote();
}
function movePane(sessionId, direction) {
  const at = panes.indexOf(sessionId);
  const to = at + direction;
  if (at < 0 || to < 0 || to >= panes.length) return;
  [panes[at], panes[to]] = [panes[to], panes[at]];
  store.set(panes);
  const col = grid.querySelector(`.topic-pane-col[data-session-id="${sessionId}"]`);
  if (direction < 0) col.previousElementSibling?.before(col);
  else col.nextElementSibling?.after(col);
  syncMoveButtons();
}

/** The short list of other conversations the owner can add; excludes topics already open. */
async function buildPicker() {
  const list = make("div", "topic-pane-picker-list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", say("topicPanes.pickPrompt", "Choose a conversation to add"));
  let recent;
  try { recent = (await api("sessions?limit=30")).sessions; }
  catch { recent = []; }
  const choices = recent.filter((row) => !panes.includes(row.sessionId));
  if (!choices.length) list.append(worded("p", "topic-pane-picker-empty", "topicPanes.noOthers", "No other conversations to add yet."));
  for (const row of choices) {
    const item = make("button", "topic-pane-picker-item", // the conversation's own words — no data-t
      firstLine(row.opening || row.lastMessage).slice(0, 80) || say("topicPanes.untitled", "Untitled conversation"));
    item.type = "button";
    item.dataset.sessionId = row.sessionId;
    item.setAttribute("role", "option");
    item.addEventListener("click", () => { addPane(row.sessionId); pickerPop?.close(); });
    list.append(item);
  }
  return list;
}
function openPicker(anchor) {
  pickerPop?.close();
  const box = make("div", "topic-pane-picker");
  box.append(worded("p", "topic-pane-picker-title", "topicPanes.pickPrompt", "Choose a conversation to add"));
  document.body.append(box);
  buildPicker().then((list) => box.append(list));
  const place = () => {
    const rect = anchor.getBoundingClientRect();
    box.style.top = `${rect.bottom + 6}px`;
    box.style.left = `${Math.max(8, rect.left)}px`;
  };
  place();
  addEventListener("resize", place);
  const onDocClick = (event) => { if (!box.contains(event.target) && event.target !== anchor) closer(); };
  const onKey = (event) => { if (event.key === "Escape") closer(); };
  function closer() {
    box.remove();
    removeEventListener("resize", place);
    document.removeEventListener("pointerdown", onDocClick, true);
    document.removeEventListener("keydown", onKey, true);
    if (pickerPop === handle) pickerPop = null;
  }
  const handle = { close: closer };
  setTimeout(() => document.addEventListener("pointerdown", onDocClick, true), 0);
  document.addEventListener("keydown", onKey, true);
  pickerPop = handle;
}

function buildOverlay() {
  const box = make("div", "topic-panes-overlay");
  box.id = "topic-panes-overlay";
  box.hidden = true;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "topic-panes-heading");
  const sheet = make("div", "topic-panes-sheet");
  const head = make("header", "topic-panes-head");
  const heading = worded("h2", "", "topicPanes.title", "Compare topics side by side");
  heading.id = "topic-panes-heading";
  const add = worded("button", "topic-panes-add", "topicPanes.add", "Add a topic");
  add.type = "button";
  add.id = "topic-panes-add";
  add.addEventListener("click", () => openPicker(add));
  const close = worded("button", "topic-panes-close", "topicPanes.close", "Close");
  close.type = "button";
  close.addEventListener("click", closeTopicPanes);
  head.append(heading, add, close);
  grid = make("div", "topic-panes-grid");
  emptyNote = worded("p", "topic-panes-empty", "topicPanes.empty", "Add two or more conversations to see them side by side.");
  sheet.append(head, emptyNote, grid);
  box.append(sheet);
  box.addEventListener("click", (event) => { if (event.target === box) closeTopicPanes(); });
  /* The sheet's Escape is its own: kept from the page's (public/layout.js), which would also close
     the floating side pane behind it and move the keyboard to that pane's switch instead of returnFocus. */
  box.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    closeTopicPanes();
  });
  document.body.append(box);
  overlay = box;
}
export function openTopicPanes() {
  if (!overlay) buildOverlay();
  returnFocus = document.activeElement;
  overlay.hidden = false;
  document.body.classList.add("topic-panes-open");
  panes = [];
  grid.replaceChildren();
  for (const id of store.get()) addPane(id);
  syncEmptyNote();
  $("topic-panes-add")?.focus();
}
export function closeTopicPanes() {
  pickerPop?.close();
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  document.body.classList.remove("topic-panes-open");
  if (returnFocus instanceof HTMLElement) returnFocus.focus();
}
/** Straight to a chosen pair or set, without opening the picker first (used by other surfaces, and by tests). */
export function openTopicPanesWith(sessionIds) {
  openTopicPanes();
  panes = [];
  grid.replaceChildren();
  for (const id of sessionIds) addPane(id);
}

function start() {
  if (!$("workspace")) return;
  const trigger = worded("button", "sr-only", "more.topicPanes", "Compare topics side by side");
  trigger.type = "button";
  trigger.id = "topic-panes-open";
  trigger.addEventListener("click", openTopicPanes);
  document.body.append(trigger);
  globalThis.branchTopicPanes = { open: openTopicPanes, openWith: openTopicPanesWith, close: closeTopicPanes };
}
if (document.body.classList.contains("lx-ready")) start();
else {
  const wait = new MutationObserver(() => {
    if (!document.body.classList.contains("lx-ready")) return;
    wait.disconnect();
    start();
  });
  wait.observe(document.body, { attributes: true, attributeFilter: ["class"] });
}
