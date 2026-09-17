/* r17-h: flows and boards. Each card is placed by public/layout.js through data-home, and every part
   has the owner's three-way switch, starting off.

   automations:procedures    Going back to an earlier step of a flow; checks for saved procedures
   automations:scheduled     The shared board; the waiting line and typing while it works
   library:made              Live widgets the assistant builds
   settings:appearance       Focus view
   inbox:needs               Requests for new packages and tool servers

   Also here: focus view itself (globalThis.branchFocusView, used by /focus) and what happens when you
   type while a task works (globalThis.branchBusySend, used by the message box). */
import { api } from "/app.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const say = (key, english) => { const word = t(key); return word === key ? english : word; };
const toast = (text) => (typeof globalThis.toast === "function" ? globalThis.toast(text) : console.warn(text));
function make(tag, className, key, english) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  return node;
}
function plain(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
/** A control with its label and a sentence under it that says what it does. */
function described(id, key, english, noteKey, note, control) {
  const label = make("label", "", key, english);
  label.htmlFor = id;
  control.id = id;
  const hint = make("p", "field-note", noteKey, note);
  hint.id = `${id}-note`;
  control.setAttribute("aria-describedby", hint.id);
  return [label, control, hint];
}
function field(tag, value = "", type = "") {
  const node = document.createElement(tag);
  if (type) node.type = type;
  node.value = value;
  return node;
}
function choice(options, value) {
  const select = document.createElement("select");
  for (const [option, key, english] of options) {
    const item = key ? make("option", "", key, english) : plain("option", english);
    item.value = option;
    item.selected = option === value;
    select.append(item);
  }
  return select;
}
const tell = (node, error) => { delete node.dataset.t; node.textContent = error.message ?? String(error); };
const saidOk = (node, text) => { delete node.dataset.t; node.textContent = text; };
function button(key, english, handler, quiet = true, hint = "") {
  const node = make("button", quiet ? "quiet-button" : "", key, english);
  node.type = "button";
  if (hint) node.title = hint;
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await handler(); } finally { node.disabled = false; }
  });
  return node;
}
function row(...children) {
  const node = document.createElement("div");
  node.className = "identity-actions";
  node.append(...children);
  return node;
}
/** A change, then the cards drawn again; an error is said in the card's status line. */
const act = (status, work) => async () => { try { await work(); await drawCards(); } catch (error) { tell(status, error); } };

const POSITIONS = [["off", "field.switch-off", "Off"], ["on", "field.switch-on", "On"], ["when-needed", "field.switch-when-needed", "Only when it is needed"]];
const PARTS = {
  "time-travel": ["flowsBoards.part.timeTravel", "Going back to an earlier step of a flow"],
  "recipe-checks": ["flowsBoards.part.recipeChecks", "Checks, clean-up and retries for saved procedures"],
  kanban: ["flowsBoards.part.kanban", "The shared board for you and the assistant"],
  widgets: ["flowsBoards.part.widgets", "Live widgets the assistant builds"],
  "waiting-line": ["flowsBoards.part.waitingLine", "Changing the waiting line, and typing while it works"],
  focus: ["flowsBoards.part.focus", "Focus view"],
  "install-requests": ["flowsBoards.part.installs", "Requests for new packages and tool servers"],
};

function switchFor(part, modes, status) {
  const select = choice(POSITIONS, modes[part]);
  select.addEventListener("change", act(status, () => api("flows-boards/switch", { part, mode: select.value })));
  const [key, english] = PARTS[part];
  return described(`flows-switch-${part}`, key, english, "flowsBoards.switch.note",
    "Off hides it everywhere. On loads it from the start; when needed keeps it one line away until a task calls for it.", select);
}

function card(id, home, titleKey, title, purposeKey, purpose) {
  const node = make("section", "card");
  node.id = id;
  node.dataset.home = home;
  node.append(make("h2", "", titleKey, title), make("p", "subtle", purposeKey, purpose));
  const status = make("p", "subtle");
  status.setAttribute("role", "status");
  return { node, status };
}
const json = (text, fallback) => { const value = text.trim(); return value ? JSON.parse(value) : fallback; };
const shortDate = (at) => (at ? new Date(at).toLocaleString() : "");

/* ---------- automations:procedures — going back to an earlier step ---------- */
const travel = { run: "", seq: "" };
async function timeTravelBody(node, status) {
  const { runs } = await api("flows-boards/flows");
  if (!runs.length) { node.append(make("p", "field-note", "flowsBoards.travel.none", "No flow has run since this was switched on.")); return; }
  if (!runs.some((r) => r.runId === travel.run)) travel.run = runs[0].runId;
  const runPick = choice(runs.map((r) => [r.runId, "", `${r.flowId.slice(0, 8)} · ${r.status} · ${r.steps} · ${shortDate(r.updatedAt)}`]), travel.run);
  runPick.addEventListener("change", () => { travel.run = runPick.value; travel.seq = ""; void drawCards(); });
  const { steps } = await api(`flows-boards/flows/${travel.run}/steps`);
  const usable = steps.filter((s) => s.nextNode && s.state);
  if (!usable.some((s) => String(s.seq) === travel.seq)) travel.seq = String(usable.at(-1)?.seq ?? "");
  const stepPick = choice(usable.map((s) => [String(s.seq), "", `${s.seq}. ${s.name}`]), travel.seq);
  const values = field("textarea", JSON.stringify(usable.find((s) => String(s.seq) === travel.seq)?.state ?? {}, null, 2));
  stepPick.addEventListener("change", () => {
    travel.seq = stepPick.value;
    values.value = JSON.stringify(usable.find((s) => String(s.seq) === travel.seq)?.state ?? {}, null, 2);
  });
  const fork = act(status, async () => {
    const before = usable.find((s) => String(s.seq) === travel.seq)?.state ?? {};
    const after = json(values.value, {});
    const changes = Object.fromEntries(Object.entries(after).filter(([k, v]) => JSON.stringify(before[k]) !== JSON.stringify(v)));
    const made = await api(`flows-boards/flows/${travel.run}/fork`, { seq: Number(travel.seq), changes });
    travel.run = made.runId;
  });
  node.append(
    ...described("flows-travel-run", "flowsBoards.travel.run", "Which run", "flowsBoards.travel.runNote", "The newest first: the flow, how it ended, how many steps were kept, and when.", runPick),
    ...described("flows-travel-step", "flowsBoards.travel.step", "Go back to after step", "flowsBoards.travel.stepNote", "The copy starts with the step after this one.", stepPick),
    ...described("flows-travel-values", "flowsBoards.travel.values", "Values at that point", "flowsBoards.travel.valuesNote", "Change any value before running the copy. The run you came from is left exactly as it was.", values),
    row(button("flowsBoards.travel.fork", "Run a copy from here", fork, false)));
}
async function timeTravelCard(modes) {
  const { node, status } = card("flows-travel-card", "automations:procedures", "flowsBoards.travel.title", "Go back in a flow",
    "flowsBoards.travel.purpose", "Pick a step a flow has already passed, change a value, and run a copy from there. Every tool it uses is checked by your approval rules again.");
  node.append(...switchFor("time-travel", modes, status));
  if (modes["time-travel"] !== "off") await timeTravelBody(node, status);
  node.append(status);
  return node;
}

/* ---------- automations:procedures — checks for saved procedures ---------- */
let recipePick = "";
async function recipeBody(node, status) {
  const { procedures } = await api("flows-boards/recipes");
  if (!procedures.length) { node.append(make("p", "field-note", "flowsBoards.recipes.none", "No saved procedures yet.")); return; }
  if (!procedures.some((p) => p.id === recipePick)) recipePick = procedures[0].id;
  const picker = choice(procedures.map((p) => [p.id, "", `${p.name} (${p.status})`]), recipePick);
  picker.addEventListener("change", () => { recipePick = picker.value; void drawCards(); });
  const plan = procedures.find((p) => p.id === recipePick).checks;
  const checks = field("textarea", JSON.stringify(plan.checks, null, 2));
  const cleanup = field("textarea", JSON.stringify(plan.cleanup, null, 2));
  const retries = field("input", String(plan.retries), "number");
  const timeout = field("input", String(plan.timeoutSeconds), "number");
  const save = act(status, () => api(`flows-boards/recipes/${recipePick}/checks`, {
    checks: json(checks.value, []), cleanup: json(cleanup.value, []), retries: Number(retries.value),
    timeoutSeconds: Number(timeout.value), stepTimeoutSeconds: plan.stepTimeoutSeconds }));
  const run = async () => {
    try {
      const outcome = await api(`flows-boards/recipes/${recipePick}/run`, { inputs: {} });
      saidOk(status, outcome.status === "passed" ? `${say("flowsBoards.recipes.passed", "Passed")} (${outcome.attempts})` : outcome.reasons.join(" "));
    } catch (error) { tell(status, error); }
  };
  node.append(
    ...described("flows-recipe-pick", "flowsBoards.recipes.pick", "Procedure", "flowsBoards.recipes.pickNote", "Only a verified procedure can be run.", picker),
    ...described("flows-recipe-checks", "flowsBoards.recipes.checks", "Checks after it runs", "flowsBoards.recipes.checksNote", "A list. A script check is {\"script\": \"…\"} and passes when it ends with 0; a tool check is {\"tool\": …, \"args\": …, \"contains\": \"words\"}.", checks),
    ...described("flows-recipe-cleanup", "flowsBoards.recipes.cleanup", "Clean-up when it fails", "flowsBoards.recipes.cleanupNote", "A list of tool calls, each {\"tool\": …, \"args\": …}, run before the next try.", cleanup),
    ...described("flows-recipe-retries", "flowsBoards.recipes.retries", "Tries after the first", "flowsBoards.recipes.retriesNote", "0 to 5. A question from your approval rules stops it instead of trying again.", retries),
    ...described("flows-recipe-timeout", "flowsBoards.recipes.timeout", "Seconds each try may take", "flowsBoards.recipes.timeoutNote", "From 5 seconds to an hour.", timeout),
    row(button("flowsBoards.recipes.save", "Save checks", save, false), button("flowsBoards.recipes.run", "Run with checks", run)));
}
async function recipeCard(modes) {
  const { node, status } = card("flows-recipes-card", "automations:procedures", "flowsBoards.recipes.title", "Checks for procedures",
    "flowsBoards.recipes.purpose", "Say how to tell that a saved procedure really worked, what to tidy up when it did not, and how many times to try.");
  node.append(...switchFor("recipe-checks", modes, status));
  if (modes["recipe-checks"] !== "off") await recipeBody(node, status);
  node.append(status);
  return node;
}

/* ---------- automations:scheduled — the shared board ---------- */
const LANES = [["todo", "flowsBoards.lane.todo", "To do"], ["doing", "flowsBoards.lane.doing", "Doing"],
  ["review", "flowsBoards.lane.review", "To check"], ["done", "flowsBoards.lane.done", "Done"], ["blocked", "flowsBoards.lane.blocked", "Stuck"]];
const NEXT = { todo: "doing", doing: "review", review: "done" };
function cardRow(item, status) {
  const line = plain("li", `${item.title} · ${item.assignee}${item.failures ? ` · ${item.failures}×` : ""}`);
  const to = (lane) => act(status, () => api(`flows-boards/board/cards/${item.id}/move`, { lane }));
  const actions = [];
  if (!item.stuck && item.lane !== "done") actions.push(button("flowsBoards.board.work", "Start work", act(status, () => api(`flows-boards/board/cards/${item.id}/work`, {}))));
  if (NEXT[item.lane]) actions.push(button("flowsBoards.board.forward", "Move on", to(NEXT[item.lane])));
  if (item.stuck) actions.push(button("flowsBoards.board.reset", "Reset", act(status, () => api(`flows-boards/board/cards/${item.id}/reset`, {}))));
  actions.push(button("flowsBoards.board.remove", "Remove", act(status, () => api(`flows-boards/board/cards/${item.id}/remove`, {}))));
  const more = document.createElement("details");
  const to_ = field("input");
  const why = field("input");
  more.append(make("summary", "", "flowsBoards.board.handoffOpen", "Hand on"),
    ...described(`flows-card-to-${item.id}`, "flowsBoards.board.handoffTo", "To whom", "flowsBoards.board.handoffToNote", "owner, assistant, or a specialist's name.", to_),
    ...described(`flows-card-why-${item.id}`, "flowsBoards.board.handoffWhy", "Why", "flowsBoards.board.handoffWhyNote", "A short note that stays on the card.", why),
    row(button("flowsBoards.board.handoff", "Hand it on", act(status, () => api(`flows-boards/board/cards/${item.id}/handoff`, { to: to_.value, note: why.value })))),
    plain("p", item.history.slice(-3).map((h) => h.what).join(" · "), "field-note"));
  line.append(row(...actions), more);
  return line;
}
async function boardBody(node, status) {
  const view = await api("flows-boards/board");
  node.append(plain("p", view.project.name, "field-note"));
  for (const [lane, key, english] of LANES) {
    node.append(make("p", "lx-eyebrow", key, english));
    const list = document.createElement("ul");
    list.dataset.lane = lane;
    list.append(...view.lanes[lane].map((item) => cardRow(item, status)));
    node.append(list);
  }
  const title = field("input"), notes = field("textarea"), who = field("input", "assistant");
  const stop = field("input", String(view.stopAfter), "number");
  node.append(
    ...described("flows-board-title", "flowsBoards.board.cardTitle", "New card", "flowsBoards.board.cardTitleNote", "What needs doing, in a few words.", title),
    ...described("flows-board-notes", "flowsBoards.board.notes", "Notes", "flowsBoards.board.notesNote", "Anything that helps whoever picks it up.", notes),
    ...described("flows-board-who", "flowsBoards.board.assignee", "Who has it", "flowsBoards.board.assigneeNote", "owner, assistant, or a specialist's name.", who),
    row(button("flowsBoards.board.add", "Add card", act(status, () => api("flows-boards/board/cards", { title: title.value, notes: notes.value, assignee: who.value })), false)),
    ...described("flows-board-stop", "flowsBoards.board.stopAfter", "Stop a card after this many failed tries", "flowsBoards.board.stopAfterNote", "A stopped card waits in Stuck until you reset it.", stop),
    row(button("flowsBoards.board.saveStop", "Save", act(status, () => api("flows-boards/board/settings", { stopAfter: Number(stop.value) })))));
}
async function boardCard(modes) {
  const { node, status } = card("flows-board-card", "automations:scheduled", "flowsBoards.board.title", "Shared board",
    "flowsBoards.board.purpose", "Cards you and the assistant work from, for the active project. The assistant can add and move cards; only you start work, finish or reset one.");
  node.append(...switchFor("kanban", modes, status));
  if (modes.kanban !== "off") await boardBody(node, status);
  node.append(status);
  return node;
}

/* ---------- automations:scheduled — the waiting line ---------- */
function waitingRow(text, handlers, id, status) {
  const line = plain("li", text.slice(0, 160));
  const words = field("textarea", text);
  const more = document.createElement("details");
  more.append(make("summary", "", "flowsBoards.waiting.editOpen", "Reword"),
    ...described(`flows-waiting-words-${id}`, "flowsBoards.waiting.words", "New wording", "flowsBoards.waiting.wordsNote", "Only while it is still waiting.", words),
    row(button("flowsBoards.waiting.saveWords", "Save wording", act(status, () => handlers.edit(words.value)))));
  line.append(row(button("flowsBoards.waiting.up", "Up", act(status, () => handlers.move("up"))),
    button("flowsBoards.waiting.down", "Down", act(status, () => handlers.move("down"))),
    button("flowsBoards.waiting.remove", "Take out", act(status, handlers.remove))), more);
  return line;
}
async function waitingBody(node, status) {
  const view = await api("flows-boards/waiting");
  const busy = choice([["queue", "flowsBoards.busy.queue", "Wait until it finishes"], ["steer", "flowsBoards.busy.steer", "Pass it on straight away"],
    ["interrupt", "flowsBoards.busy.interrupt", "Stop it and go next"]], view.busyMode);
  node.append(...described("flows-busy", "flowsBoards.busy.label", "When you type while it works", "flowsBoards.busy.note", "Passing it on uses the same trusted note as Steer; stopping cancels the task that is working.", busy),
    row(button("flowsBoards.busy.save", "Save", act(status, () => api("flows-boards/busy", { mode: busy.value })), false)));
  const tasks = document.createElement("ul");
  tasks.append(...view.tasks.map((task) => waitingRow(task.prompt, {
    edit: (prompt) => api(`flows-boards/waiting/queue/${task.id}/edit`, { prompt }),
    move: (direction) => api(`flows-boards/waiting/queue/${task.id}/move`, { direction }),
    remove: () => api(`flows-boards/waiting/queue/${task.id}/remove`, {}),
  }, task.id, status)));
  for (const { sessionId, items } of view.everywhere)
    tasks.append(...items.map((item) => waitingRow(item.prompt, {
      edit: (prompt) => api("flows-boards/waiting/followups/edit", { sessionId, id: item.id, prompt }),
      move: (direction) => api("flows-boards/waiting/followups/move", { sessionId, id: item.id, direction }),
      remove: () => api("flows-boards/waiting/followups/remove", { sessionId, id: item.id }),
    }, item.id, status)));
  node.append(make("p", "lx-eyebrow", "flowsBoards.waiting.list", "Waiting now"), tasks);
  if (!tasks.children.length) node.append(make("p", "field-note", "flowsBoards.waiting.none", "Nothing is waiting."));
}
async function waitingCard(modes) {
  const { node, status } = card("flows-waiting-card", "automations:scheduled", "flowsBoards.waiting.title", "Change the waiting line",
    "flowsBoards.waiting.purpose", "Reword, move or take out what is waiting, and choose what happens when you type while a task works.");
  node.append(...switchFor("waiting-line", modes, status));
  if (modes["waiting-line"] !== "off") await waitingBody(node, status);
  node.append(status);
  return node;
}

/* ---------- library:made — live widgets ---------- */
async function widgetsBody(node, status) {
  const { widgets, waiting } = await api("flows-boards/widgets");
  const asks = document.createElement("ul");
  for (const idea of waiting) {
    const line = plain("li", `${idea.title} — ${idea.why} (${idea.tool})`);
    line.append(row(button("flowsBoards.widgets.accept", "Show it", act(status, () => api(`flows-boards/widgets/${idea.id}/accept`, {}))),
      button("flowsBoards.widgets.dismiss", "No thanks", act(status, () => api(`flows-boards/widgets/${idea.id}/dismiss`, {})))));
    asks.append(line);
  }
  node.append(make("p", "lx-eyebrow", "flowsBoards.widgets.ideas", "Ideas waiting for you"), asks);
  if (!waiting.length) node.append(make("p", "field-note", "flowsBoards.widgets.noIdeas", "No widget ideas are waiting."));
  for (const widget of widgets) {
    const frame = document.createElement("iframe");
    frame.sandbox = "";
    frame.title = widget.title;
    frame.src = widget.frame;
    frame.style.width = "100%";
    node.append(plain("p", widget.title, "field-note"), frame,
      row(button("flowsBoards.widgets.remove", "Remove widget", act(status, () => api(`flows-boards/widgets/${widget.id}/remove`, {})))));
  }
  node.append(row(button("flowsBoards.widgets.refresh", "Check again", act(status, async () => undefined), false)));
}
async function widgetsCard(modes) {
  const { node, status } = card("flows-widgets-card", "library:made", "flowsBoards.widgets.title", "Widgets the assistant built",
    "flowsBoards.widgets.purpose", "Small pages that keep themselves up to date. The assistant suggests them; each one is shown in a sealed frame and can only look things up.");
  node.append(...switchFor("widgets", modes, status));
  if (modes.widgets !== "off") await widgetsBody(node, status);
  node.append(status);
  return node;
}

/* ---------- settings:appearance — focus view ---------- */
const FOCUS_KEY = "branch-focus-view";
let focusOn = false;
try { focusOn = localStorage.getItem(FOCUS_KEY) === "1"; } catch { /* private window: starts off */ }
let focusAllowed = false;
function markConversation() {
  const holder = $("conversation");
  if (!holder) return;
  const nodes = [...holder.children];
  nodes.forEach((node, index) => {
    const later = nodes.slice(index + 1);
    const nextUser = later.findIndex((n) => n.classList.contains("user"));
    const replyAfter = later.slice(0, nextUser < 0 ? undefined : nextUser).some((n) => n.matches(".message.assistant:not(.tool-step)"));
    const hide = focusOn && focusAllowed && (node.classList.contains("tool-step") || (node.matches(".message.assistant") && replyAfter));
    if (hide) { node.dataset.focusHidden = "1"; node.style.display = "none"; }
    else if (node.dataset.focusHidden) { delete node.dataset.focusHidden; node.style.display = ""; }
  });
}
function applyFocus(on) {
  focusOn = on;
  try { localStorage.setItem(FOCUS_KEY, on ? "1" : "0"); } catch { /* kept for this page only */ }
  document.body.dataset.focusView = focusAllowed && on ? "on" : "off";
  markConversation();
}
globalThis.branchFocusView = (on) => {
  if (!focusAllowed) { toast(say("flowsBoards.focus.off", "Focus view is switched off in Settings › Appearance.")); return; }
  applyFocus(on ?? !focusOn);
};
function watchConversation() {
  const holder = $("conversation");
  if (!holder || holder.dataset.focusWatched) return;
  holder.dataset.focusWatched = "1";
  new MutationObserver(markConversation).observe(holder, { childList: true });
}
async function focusCard(modes) {
  const { node, status } = card("flows-focus-card", "settings:appearance", "flowsBoards.focus.title", "Focus view",
    "flowsBoards.focus.purpose", "Show only what you asked and the final answers, with the steps in between folded away. /focus switches it from the message box.");
  node.append(...switchFor("focus", modes, status));
  focusAllowed = modes.focus !== "off";
  if (focusAllowed) {
    const now = choice([["off", "flowsBoards.focus.showAll", "Show every step"], ["on", "flowsBoards.focus.onlyAnswers", "Only what I asked and the answers"]], focusOn ? "on" : "off");
    node.append(...described("flows-focus-now", "flowsBoards.focus.now", "In this window", "flowsBoards.focus.nowNote", "Kept in this browser only.", now),
      row(button("flowsBoards.focus.apply", "Apply", async () => applyFocus(now.value === "on"), false)));
  }
  applyFocus(focusOn);
  watchConversation();
  node.append(status);
  return node;
}

/* ---------- inbox:needs — requests for packages and tool servers ---------- */
const STATES = { waiting: ["flowsBoards.installs.waiting", "waiting for you"], approved: ["flowsBoards.installs.approved", "approved"],
  declined: ["flowsBoards.installs.declined", "declined"], refused: ["flowsBoards.installs.refused", "refused: named as harmful"] };
function requestRow(item, status) {
  const what = item.ask.kind === "package" ? `${item.ask.ecosystem} · ${item.ask.name}${item.ask.version ? ` ${item.ask.version}` : ""}` : `MCP · ${item.ask.name}`;
  const [key, english] = STATES[item.status];
  const line = plain("li", `${what} — ${item.ask.why} (${item.from}; ${item.check.note}) `);
  line.append(make("strong", "", key, english));
  const answer = (verb, body) => act(status, () => api(`flows-boards/installs/${item.id}/${verb}`, body));
  if (item.status === "waiting") {
    const buttons = [button("flowsBoards.installs.approve", "Approve", answer("approve", {})), button("flowsBoards.installs.decline", "Decline", answer("decline", {}))];
    if (item.check.state === "unchecked") buttons.splice(1, 0, button("flowsBoards.installs.anyway", "Approve without the check", answer("approve", { despiteUnchecked: true })));
    line.append(row(...buttons));
  }
  if (item.nextStep) {
    const code = document.createElement("code");
    code.textContent = item.nextStep;
    line.append(make("p", "field-note", "flowsBoards.installs.next", "Nothing was installed. To go ahead:"), code);
  }
  return line;
}
async function installsCard(modes) {
  const { node, status } = card("flows-installs-card", "inbox:needs", "flowsBoards.installs.title", "Package and tool server requests",
    "flowsBoards.installs.purpose", "What the assistant or a chat asked to add. The list of harmful packages is checked first, only you can answer, and nothing installs itself.");
  node.append(...switchFor("install-requests", modes, status));
  if (modes["install-requests"] !== "off") {
    const { requests } = await api("flows-boards/installs");
    const list = document.createElement("ul");
    list.append(...requests.slice().reverse().slice(0, 30).map((item) => requestRow(item, status)));
    node.append(list);
    if (!requests.length) node.append(make("p", "field-note", "flowsBoards.installs.none", "Nothing has been asked for."));
    node.append(row(button("flowsBoards.installs.refresh", "Check again", act(status, async () => undefined), false)));
  }
  node.append(status);
  return node;
}

/* ---------- typing while it works ---------- */
let busyMode = "queue", waitingAllowed = false;
/** The message box asks this first; null means "wait its turn", the way it always did. */
globalThis.branchBusySend = async (sessionId, prompt) => {
  if (!waitingAllowed || busyMode === "queue") return null;
  // Integration review: steering and stopping are the owner's; a key (the phone) that is refused still has its message queued.
  try { return await api("flows-boards/busy/send", { sessionId, prompt }); } catch { return null; }
};

const BUILDERS = [
  ["flows-travel-card", timeTravelCard], ["flows-recipes-card", recipeCard], ["flows-board-card", boardCard],
  ["flows-waiting-card", waitingCard], ["flows-widgets-card", widgetsCard], ["flows-focus-card", focusCard],
  ["flows-installs-card", installsCard],
];

async function drawCards() {
  let overview;
  try { overview = await api("flows-boards"); } catch { return; }
  busyMode = overview.busyMode;
  waitingAllowed = overview.modes["waiting-line"] !== "off";
  for (const [id, build] of BUILDERS) {
    try {
      const fresh = await build(overview.modes);
      const old = $(id);
      if (old) old.replaceWith(fresh); else document.body.append(fresh);
    } catch { /* one card failing leaves the rest of the window as it was */ }
  }
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

whenReady(() => { void drawCards(); });
