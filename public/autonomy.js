/* r17-b: it suggests, and runs things on its own. Each card is placed by public/layout.js through
   data-home, and every part has the owner's three-way switch, starting off.

   automations:scheduled     Suggested automations and the catalogue; standing orders;
                             repeating in conversations; limits on automatic work
   automations:procedures    Procedures that start themselves
   inbox:needs               What waits for your yes
   settings:assistant        "From now on" instructions
   customize:skills          What skills need on this computer */
import { api } from "/app.js";
import { t } from "/i18n.js";
import { dropdown } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
const say = (key, english) => { const word = t(key); return word === key ? english : word; };
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
function labelled(id, key, english, control) {
  const label = make("label", "", key, english);
  label.htmlFor = id;
  control.id = id;
  return [label, control];
}
function field(tag, value = "", type = "") {
  const node = document.createElement(tag);
  if (type) node.type = type;
  node.value = value;
  return node;
}
function choice(options, value) {
  return dropdown({ options, value });
}
const tell = (node, error) => { delete node.dataset.t; node.textContent = error.message ?? String(error); };
const done = (node) => { node.dataset.t = "autonomy.saved"; node.textContent = say("autonomy.saved", "Saved."); };
function button(key, english, handler, quiet = true) {
  const node = make("button", quiet ? "quiet-button" : "", key, english);
  node.type = "button";
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

const POSITIONS = [["off", "field.switch-off", "Off"], ["on", "field.switch-on", "On"], ["when-needed", "field.switch-when-needed", "When needed"]];
const PARTS = {
  suggestions: ["autonomy.part.suggestions", "Suggested automations"],
  orders: ["autonomy.part.orders", "Standing orders"],
  loops: ["autonomy.part.loops", "Repeating in a conversation (/loop and /heartbeat)"],
  "session-commands": ["autonomy.part.sessionCommands", "Sub-goals, background tasks and handing on (/subgoal, /bg, /handoff)"],
  procedures: ["autonomy.part.procedures", "Procedures that start themselves"],
  readiness: ["autonomy.part.readiness", "Checking what skills need"],
  instructions: ["autonomy.part.instructions", "\"From now on\" instructions"],
};

function switchFor(part, modes, status) {
  const select = choice(POSITIONS, modes[part]);
  select.addEventListener("change", act(status, () => api("autonomy/switch", { part, mode: select.value })));
  const [key, english] = PARTS[part];
  return labelled(`autonomy-switch-${part}`, key, english, select);
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

/* ---------- automations:scheduled — suggestions and the catalogue ---------- */
function suggestionRow(item, status) {
  const line = plain("li", `${item.title}: ${item.why}`);
  line.append(" ", button("autonomy.suggestions.accept", "Make it", act(status, () => api("autonomy/suggestions", { fingerprint: item.fingerprint, yes: true }))),
    " ", button("autonomy.suggestions.dismiss", "Not interested", act(status, () => api("autonomy/suggestions", { fingerprint: item.fingerprint, yes: false }))));
  return line;
}

function blueprintForm(catalogue, status) {
  const box = document.createElement("div");
  const picker = choice(catalogue.map((b) => [b.id, "", b.title]), catalogue[0]?.id);
  for (const option of picker.options) option.textContent = catalogue.find((b) => b.id === option.value)?.title ?? option.value;
  const blanks = document.createElement("div");
  const drawBlanks = () => {
    const entry = catalogue.find((b) => b.id === picker.value);
    blanks.replaceChildren(plain("p", entry?.description ?? "", "field-note"));
    for (const slot of entry?.slots ?? []) {
      const input = field("input", slot.default ?? "", slot.kind === "url" ? "url" : "text");
      input.dataset.slot = slot.name;
      const label = plain("label", slot.label);
      label.htmlFor = input.id = `autonomy-blank-${slot.name}`;
      blanks.append(label, input);
    }
  };
  picker.addEventListener("change", drawBlanks);
  drawBlanks();
  const create = act(status, () => {
    const values = Object.fromEntries([...blanks.querySelectorAll("input[data-slot]")].map((input) => [input.dataset.slot, input.value]));
    return api("autonomy/blueprints", { blueprint: picker.value, values, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });
  box.append(...labelled("autonomy-blueprint", "autonomy.catalogue.pick", "From the catalogue", picker), blanks,
    row(button("autonomy.catalogue.make", "Make this automation", create, false)));
  return box;
}

let showStarters = false;
async function suggestionsCard(modes) {
  const { node, status } = card("autonomy-suggestions-card", "automations:scheduled", "autonomy.suggestions.title", "Suggested automations",
    "autonomy.suggestions.purpose", "Ideas worked out on this computer from what Branch remembers and what is connected. Nothing is made until you say yes, and a no is never offered again.");
  node.append(...switchFor("suggestions", modes, status));
  if (modes.suggestions !== "off") {
    const { suggestions, catalogue } = await api(`autonomy/suggestions${showStarters ? "?starters=1" : ""}`);
    const list = document.createElement("ul");
    list.id = "autonomy-suggestions-list";
    list.append(...suggestions.map((item) => suggestionRow(item, status)));
    if (!suggestions.length) node.append(make("p", "field-note", "autonomy.suggestions.none", "Nothing to suggest right now."));
    node.append(list, row(button("autonomy.suggestions.starters", "Show starting ideas", async () => { showStarters = true; await drawCards(); })),
      make("h3", "", "autonomy.catalogue.title", "Make one from the catalogue"), blueprintForm(catalogue, status));
  }
  node.append(status);
  return node;
}

/* ---------- automations:scheduled — standing orders ---------- */
function orderRow(state, status) {
  const paused = state.status === "paused";
  const words = `${state.order.name} — ${paused ? say("autonomy.orders.paused", "paused") : say("autonomy.orders.active", "active")}${state.pausedBecause ? `: ${state.pausedBecause}` : ""}`;
  const line = plain("li", words);
  line.append(" ", button("autonomy.orders.run", "Run now", act(status, () => api(`autonomy/orders/${state.id}/run`, {}))),
    " ", paused ? button("autonomy.resume", "Resume", act(status, () => api(`autonomy/orders/${state.id}/resume`, {})))
      : button("autonomy.pause", "Pause", act(status, () => api(`autonomy/orders/${state.id}/pause`, {}))),
    " ", button("autonomy.remove", "Remove", act(status, () => api(`autonomy/orders/${state.id}/remove`, {}))));
  return line;
}

function startFrom(kind, amount) {
  if (kind === "every") return { kind, minutes: Number(amount) || 60 };
  if (kind === "daily") return { kind, time: amount || "09:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  if (kind === "after-task") return { kind, words: amount };
  return { kind: "manual" };
}
const STARTS = [["manual", "autonomy.start.manual", "Only when I start it"], ["every", "autonomy.start.every", "Every so many minutes"],
  ["daily", "autonomy.start.daily", "Each day at a time"], ["after-task", "autonomy.start.afterTask", "After a task of mine finishes"]];

function orderForm(status) {
  const name = field("input"), authority = field("textarea"), escalation = field("textarea"), when = choice(STARTS, "manual"), amount = field("input");
  const save = act(status, () => api("autonomy/orders", { name: name.value.trim(), authority: authority.value.trim(),
    escalation: escalation.value.split("\n").map((l) => l.trim()).filter(Boolean), start: startFrom(when.value, amount.value.trim()) }));
  return [...labelled("autonomy-order-name", "autonomy.orders.name", "Name of the programme", name),
    ...labelled("autonomy-order-authority", "autonomy.orders.authority", "What it may do", authority),
    ...labelled("autonomy-order-escalation", "autonomy.orders.escalation", "When to stop and ask you (one per line)", escalation),
    ...labelled("autonomy-order-when", "autonomy.start.when", "When it starts", when),
    ...labelled("autonomy-order-amount", "autonomy.start.amount", "Minutes, time (HH:MM) or words, for the start you chose", amount),
    row(button("autonomy.orders.save", "Hand it over", save, false))];
}

async function ordersCard(modes) {
  const { node, status } = card("autonomy-orders-card", "automations:scheduled", "autonomy.orders.title", "Standing orders",
    "autonomy.orders.purpose", "A programme you hand over for good: what it may do, when it runs, and when it must stop and ask you. Your approval rules still apply.");
  node.append(...switchFor("orders", modes, status));
  const { orders } = await api("autonomy/orders");
  const list = document.createElement("ul");
  list.append(...orders.map((state) => orderRow(state, status)));
  node.append(list);
  if (modes.orders !== "off") node.append(...orderForm(status));
  node.append(status);
  return node;
}

/* ---------- automations:scheduled — loops, and the limits on automatic work ---------- */
async function loopsCard(modes) {
  const { node, status } = card("autonomy-loops-card", "automations:scheduled", "autonomy.loops.title", "Repeating in conversations",
    "autonomy.loops.purpose", "Type /loop or /heartbeat in a conversation to have it asked again every so often. Each stops by itself after a set number of turns.");
  node.append(...switchFor("loops", modes, status), ...switchFor("session-commands", modes, status));
  const { loops } = await api("autonomy/loops");
  const list = document.createElement("ul");
  for (const loop of loops) {
    const line = plain("li", `/${loop.kind} (${loop.status}, ${loop.fired}/${loop.times}): ${loop.prompt}`);
    line.append(" ", button("autonomy.loops.stop", "Stop", act(status, () => api("autonomy/loops/stop", { kind: loop.kind, sessionId: loop.sessionId }))));
    list.append(line);
  }
  if (!loops.length) node.append(make("p", "field-note", "autonomy.loops.none", "Nothing repeats in any conversation."));
  node.append(list, status);
  return node;
}

async function limitsCard() {
  const { node, status } = card("autonomy-limits-card", "automations:scheduled", "autonomy.limits.title", "Limits on automatic work",
    "autonomy.limits.purpose", "How much standing orders, procedures and repeating conversations may do between them. A turn past a limit waits and says why.");
  const { limits } = await api("autonomy");
  const runs = field("input", String(limits.runsPerDay), "number"), steps = field("input", String(limits.stepsPerTurn), "number"),
    tokens = field("input", String(limits.tokensPerTurn), "number");
  const save = async () => {
    try { await api("autonomy/limits", { runsPerDay: Number(runs.value), stepsPerTurn: Number(steps.value), tokensPerTurn: Number(tokens.value) }); done(status); } catch (error) { tell(status, error); }
  };
  node.append(...labelled("autonomy-limit-runs", "autonomy.limits.runs", "Turns a day, all together", runs),
    ...labelled("autonomy-limit-steps", "autonomy.limits.steps", "Steps in one turn", steps),
    ...labelled("autonomy-limit-tokens", "autonomy.limits.tokens", "Tokens in one turn", tokens),
    row(button("autonomy.save", "Save", save)), status);
  return node;
}

/* ---------- automations:procedures — procedures that start themselves ---------- */
const LEVELS = [["ask-each-step", "autonomy.level.eachStep", "Ask before every step"], ["ask-to-start", "autonomy.level.toStart", "Ask before it starts"],
  ["auto", "autonomy.level.auto", "Run on its own"]];

function procedureRow(state, status) {
  const rate = state.successRate === null ? "—" : `${Math.round(state.successRate * 100)}%`;
  const line = plain("li", `${state.procedure.name} (${state.procedure.steps.length}) · ${say("autonomy.procedures.rate", "worked")} ${rate}${state.levelNote ? ` · ${state.levelNote}` : ""}`);
  const level = choice(LEVELS, state.procedure.level);
  level.setAttribute("aria-label", say("autonomy.procedures.level", "How much it may do on its own"));
  level.addEventListener("change", act(status, () => api(`autonomy/procedures/${state.id}/update`, { level: level.value })));
  const paused = state.status === "paused";
  line.append(" ", level, " ", button("autonomy.procedures.start", "Start now", act(status, () => api(`autonomy/procedures/${state.id}/run`, {}))),
    " ", paused ? button("autonomy.resume", "Resume", act(status, () => api(`autonomy/procedures/${state.id}/resume`, {})))
      : button("autonomy.pause", "Pause", act(status, () => api(`autonomy/procedures/${state.id}/pause`, {}))),
    " ", button("autonomy.remove", "Remove", act(status, () => api(`autonomy/procedures/${state.id}/remove`, {}))));
  return line;
}

function procedureForm(status) {
  const name = field("input"), steps = field("textarea"), when = choice(STARTS, "manual"), amount = field("input"), level = choice(LEVELS, "ask-to-start");
  const save = act(status, () => api("autonomy/procedures", { name: name.value.trim(), level: level.value, start: startFrom(when.value, amount.value.trim()),
    steps: steps.value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const at = l.indexOf(":");
      return at > 0 ? { title: l.slice(0, at).trim(), prompt: l.slice(at + 1).trim() } : { title: l.slice(0, 120), prompt: l };
    }) }));
  return [...labelled("autonomy-procedure-name", "autonomy.procedures.name", "Name", name),
    ...labelled("autonomy-procedure-steps", "autonomy.procedures.steps", "Steps, one per line: title: what to do", steps),
    ...labelled("autonomy-procedure-when", "autonomy.start.when", "When it starts", when),
    ...labelled("autonomy-procedure-amount", "autonomy.start.amount", "Minutes, time (HH:MM) or words, for the start you chose", amount),
    ...labelled("autonomy-procedure-level", "autonomy.procedures.level", "How much it may do on its own", level),
    row(button("autonomy.procedures.save", "Keep it", save, false))];
}

async function proceduresCard(modes) {
  const { node, status } = card("autonomy-procedures-card", "automations:procedures", "autonomy.procedures.title", "Procedures that start themselves",
    "autonomy.procedures.purpose", "Steps that start on a clock or after a task, asking you as often as you choose. One that keeps failing goes back to asking first.");
  node.append(...switchFor("procedures", modes, status));
  const { procedures } = await api("autonomy/procedures");
  const list = document.createElement("ul");
  list.append(...procedures.map((state) => procedureRow(state, status)));
  node.append(list);
  if (modes.procedures !== "off") node.append(...procedureForm(status));
  node.append(status);
  return node;
}

/* ---------- inbox:needs — what waits for a yes ---------- */
async function needsCard() {
  const { node, status } = card("autonomy-needs-card", "inbox:needs", "autonomy.needs.title", "Automations waiting for your yes",
    "autonomy.needs.purpose", "Suggestions from the assistant, procedures that want to start, and standing orders that stopped to ask.");
  const { waiting } = await api("autonomy");
  const list = document.createElement("ul");
  list.id = "autonomy-needs-list";
  for (const entry of waiting) {
    const line = plain("li", `${entry.title} — ${entry.detail}`);
    line.style.whiteSpace = "pre-line"; // a proposal is shown in full, one part a line
    line.append(" ", button("autonomy.needs.yes", "Yes", act(status, () => api("autonomy/decide", { id: entry.id, yes: true }))),
      " ", button("autonomy.needs.no", "No", act(status, () => api("autonomy/decide", { id: entry.id, yes: false }))));
    list.append(line);
  }
  if (!waiting.length) node.append(make("p", "field-note", "autonomy.needs.none", "Nothing waits."));
  node.append(list, status);
  return node;
}

/* ---------- settings:assistant — "from now on" ---------- */
const SCOPES = [["assistant", "autonomy.scope.assistant", "The assistant"], ["everyone", "autonomy.scope.everyone", "The assistant and every specialist"]];
async function instructionsCard(modes) {
  const { node, status } = card("autonomy-instructions-card", "settings:assistant", "autonomy.instructions.title", "\"From now on\" instructions",
    "autonomy.instructions.purpose", "When you say \"from now on\" in a conversation, Branch asks once whether to keep it. Kept ones are given to every later task.");
  /* DG-181: a row of the Assistant page's one section, as in the sample, where its switch already says its name:
     the title is read aloud under the section's heading (DG-008), not drawn again. */
  const title = node.querySelector("h2"), heading = make("h4", "sr-only", title.dataset.t, title.textContent);
  title.replaceWith(heading);
  node.append(...switchFor("instructions", modes, status));
  const { instructions } = await api("autonomy/instructions");
  const list = document.createElement("ul");
  for (const item of instructions) {
    const line = plain("li", `${item.text} (${item.scope})`);
    line.append(" ", button("autonomy.remove", "Remove", act(status, () => api("autonomy/instructions/remove", { id: item.id }))));
    list.append(line);
  }
  node.append(list);
  if (modes.instructions !== "off") {
    const text = field("input"), scope = choice(SCOPES, "assistant");
    node.append(...labelled("autonomy-instruction-text", "autonomy.instructions.new", "A new instruction, in one sentence", text),
      ...labelled("autonomy-instruction-scope", "autonomy.instructions.scope", "For", scope),
      row(button("autonomy.instructions.keep", "Keep it", act(status, () => api("autonomy/instructions", { text: text.value.trim(), scope: scope.value })), false)));
  }
  node.append(status);
  return node;
}

/* ---------- customize:skills — readiness ---------- */
async function readinessCard(modes) {
  const { node, status } = card("autonomy-readiness-card", "customize:skills", "autonomy.readiness.title", "What skills need on this computer",
    "autonomy.readiness.purpose", "Skills that say which programs and keys they need, and whether this computer has them. Nothing is installed for you.");
  node.append(...switchFor("readiness", modes, status));
  if (modes.readiness !== "off") {
    const { skills } = await api("autonomy/readiness");
    const list = document.createElement("ul");
    for (const skill of skills)
      list.append(plain("li", `${skill.name}: ${skill.ready ? say("autonomy.readiness.ready", "ready") : skill.missing.map((m) => `${m.name} — ${m.fix}`).join("; ")}`));
    if (!skills.length) node.append(make("p", "field-note", "autonomy.readiness.none", "No installed skill says what it needs."));
    node.append(list, row(button("autonomy.readiness.check", "Check again", act(status, async () => undefined))));
  }
  node.append(status);
  return node;
}

const BUILDERS = [
  ["autonomy-suggestions-card", suggestionsCard], ["autonomy-orders-card", ordersCard], ["autonomy-loops-card", loopsCard],
  ["autonomy-limits-card", limitsCard], ["autonomy-procedures-card", proceduresCard], ["autonomy-needs-card", needsCard],
  ["autonomy-instructions-card", instructionsCard], ["autonomy-readiness-card", readinessCard],
];

async function drawCards() {
  let modes;
  try { modes = (await api("autonomy")).modes; } catch { return; }
  for (const [id, build] of BUILDERS) {
    try {
      const fresh = await build(modes);
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
