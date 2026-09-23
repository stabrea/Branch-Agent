/* mac7/r17-d: coding polish. One Settings card (settings:advanced, beside the developer tools),
   the task's checklist in the side pane's Plan tab, and the @ picker in the message box.
   Every part has the owner's three-way switch and starts off. */
import { api } from "/app.js";
import { t } from "/i18n.js";
import { segmented, dropdown } from "/control-makers.js";

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
  if (type === "checkbox") node.checked = Boolean(value); else node.value = value;
  return node;
}
const tell = (node, error) => { delete node.dataset.t; node.textContent = error.message ?? String(error); };
const done = (node) => { node.dataset.t = "coding.saved"; node.textContent = say("coding.saved", "Saved."); };
function button(key, english, handler) {
  const node = make("button", "quiet-button", key, english);
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
/** Runs a change and says how it went in the card's status line. */
const attempt = (status, work) => async () => { try { await work(); done(status); } catch (error) { tell(status, error); } };

const POSITIONS = [["off", "field.switch-off", "Off"], ["on", "field.switch-on", "On"], ["when-needed", "field.switch-when-needed", "When needed"]];
const PARTS = {
  "format-on-edit": ["coding.part.format", "Tidying a file and checking it for mistakes after every change"],
  "shell-snapshot": ["coding.part.shell", "Using your own command-line setup"],
  mentions: ["coding.part.mentions", "Pointing at files with @, and @imports in instruction files"],
  worktrees: ["coding.part.worktrees", "A separate copy of the project for a conversation or a helper"],
  init: ["coding.part.init", "Writing the project's instruction file (/init)"],
  ci: ["coding.part.ci", "Running Branch in GitHub Actions or GitLab CI"],
  checklist: ["coding.part.checklist", "A checklist for each task that you can edit while it runs"],
  "path-rules": ["coding.part.rules", "Rules for some folders only, and schedules kept as files"],
  "large-output": ["coding.part.largeOutput", "Keeping very long tool output in a file"],
  notebooks: ["coding.part.notebooks", "Reading Jupyter notebooks cell by cell"],
  "review-checks": ["coding.part.checks", "Review checks kept in the project"],
  "read-first": ["coding.part.readFirst", "Reading a file before changing it"],
  "fewer-rounds": ["coding.part.fewerRounds", "Doing more in one go, so a task takes fewer turns"],
};

function switchFor(part, modes, status) {
  const select = segmented({
    id: `coding-switch-${part}`,
    options: POSITIONS,
    value: modes[part],
    onChange: async (mode) => {
      try { await api("coding/switch", { part, mode }); done(status); await drawCard(); } catch (error) { tell(status, error); }
    }
  });
  const [key, english] = PARTS[part];
  return labelled(`coding-switch-${part}`, key, english, select);
}

/* ---------- the parts' own controls ---------- */

async function formatControls(status) {
  const { format } = await api("coding/format");
  const lines = Object.entries(format.formatters).map(([name, f]) => [name, f.path, f.extensions.join(" "), f.args.join(" ")].join(" | "));
  const list = field("textarea", lines.join("\n"));
  const diagnostics = field("input", format.diagnostics, "checkbox");
  const save = attempt(status, async () => {
    const formatters = Object.fromEntries(list.value.split("\n").map((line) => line.split("|").map((p) => p.trim())).filter((p) => p[0])
      .map(([name, path, endings, args]) => [name, { path, extensions: (endings ?? "").split(/\s+/).filter(Boolean), args: (args || "{file}").split(/\s+/) }]));
    await api("coding/format", { ...format, formatters, diagnostics: diagnostics.checked });
  });
  return [...labelled("coding-formatters", "coding.format.list", "One per line: short name | program's full address | endings (.ts .tsx) | arguments ({file} is the file)", list),
    ...labelled("coding-diagnostics", "coding.format.diagnostics", "Also ask my language servers about each changed file", diagnostics),
    row(button("coding.save", "Save", save))];
}

async function shellControls(status) {
  const view = await api("coding/shell");
  const shell = field("input", view.shell);
  shell.placeholder = say("coding.shell.default", "your login shell");
  const summary = view.snapshot
    ? plain("p", `${view.snapshot.shell} · ${view.snapshot.takenAt.slice(0, 16)} · PATH ${view.snapshot.path.length} · ${view.snapshot.dropped.length ? `${say("coding.shell.dropped", "left out")}: ${view.snapshot.dropped.join(", ")}` : ""}`, "field-note")
    : make("p", "field-note", "coding.shell.none", "No snapshot yet.");
  return [...labelled("coding-shell", "coding.shell.which", "Which shell to read (full address)", shell), summary,
    make("p", "field-note", "coding.shell.restart", "Commands use the snapshot's PATH from the next time Branch starts."),
    row(button("coding.shell.take", "Take a snapshot now", async () => {
      try { await api("coding/shell", { shell: shell.value.trim() }); await api("coding/shell/take", {}); await drawCard(); } catch (error) { tell(status, error); }
    }), button("coding.shell.forget", "Forget it", attempt(status, () => api("coding/shell/forget", {}))))];
}

async function worktreeControls(status) {
  const { forks, settings } = await api("coding/worktrees");
  const helpers = field("input", settings.perHelper, "checkbox");
  helpers.addEventListener("change", attempt(status, () => api("coding/worktrees", { perHelper: helpers.checked })));
  const nodes = [...labelled("coding-helpers", "coding.worktrees.helpers", "Give each helper a task hands work to a copy of its own", helpers)];
  for (const fork of forks)
    nodes.push(plain("p", `${fork.name} (${fork.branch})`, "field-note"),
      row(button("coding.worktrees.remove", "Remove this copy", async () => { try { await api("coding/worktrees/remove", { sessionId: fork.sessionId }); await drawCard(); } catch (error) { tell(status, error); } })));
  return nodes;
}

async function rulesControls(status) {
  const view = await api("coding/rules");
  const nodes = [plain("p", `${view.folder} · ${view.schedulesFolder}`, "field-note")];
  for (const rule of view.rules) {
    const on = field("input", rule.on, "checkbox");
    on.addEventListener("change", attempt(status, () => api("coding/rules/switch", { name: rule.name, on: on.checked })));
    const label = plain("label", `${rule.name}${rule.paths ? ` — ${rule.paths.join(", ")}` : ""}`);
    label.htmlFor = on.id = `coding-rule-${rule.name.replace(/\W/g, "-")}`;
    nodes.push(row(on, label));
  }
  for (const file of view.schedules)
    nodes.push(plain("p", `${file.name}: ${file.problem ?? `${file.every ?? file.daily ?? ""} — ${file.prompt.slice(0, 80)}${file.permissions ? ` (${file.permissions.join(", ")})` : ""}`}`, "field-note"),
      row(button("coding.rules.bringIn", "Make it a schedule", attempt(status, () => api("coding/rules/schedule", { name: file.name })))));
  return nodes;
}

async function checksControls(status) {
  const { folder, checks } = await api("coding/checks");
  const result = plain("div", "", "field-note");
  const run = async () => {
    try {
      const outcome = await api("coding/checks/run", {});
      result.replaceChildren(...outcome.checks.map((c) => plain("p", `${c.title}: ${c.status}${c.findings.length ? ` — ${c.findings.join("; ")}` : ""}`)));
    } catch (error) { tell(status, error); }
  };
  return [plain("p", `${folder}: ${checks.map((c) => c.title).join(", ") || "—"}`, "field-note"), row(button("coding.checks.run", "Run the checks now", run)), result];
}

async function ciControls(status) {
  const kind = dropdown({
    id: "coding-ci-kind",
    options: [["github", "GitHub Actions"], ["gitlab", "GitLab CI"]],
    value: "github"
  });
  const model = field("input"), endpoint = field("input", "", "url"), key = field("input", "ANTHROPIC_API_KEY");
  const out = plain("pre", "", "field-note");
  const write = attempt(status, async () => {
    const snippet = await api("coding/ci", { kind: kind.value, model: model.value.trim(), endpoint: endpoint.value.trim(), keyVariable: key.value.trim() });
    out.textContent = `# ${snippet.file}\n${snippet.text}`;
  });
  return [...labelled("coding-ci-kind", "coding.ci.kind", "Where it runs", kind), ...labelled("coding-ci-model", "coding.ci.model", "Model", model),
    ...labelled("coding-ci-endpoint", "coding.ci.endpoint", "Model service address", endpoint),
    ...labelled("coding-ci-key", "coding.ci.key", "Name of the secret holding the key", key),
    row(button("coding.ci.make", "Write the lines to paste", write)), out];
}

/* DG-191: the parts whose own settings the approved sample always draws as rows, whatever the part's switch says. */
const ALWAYS_DRAWN = new Set(["format-on-edit", "shell-snapshot", "worktrees"]);

const CONTROLS = { "format-on-edit": formatControls, "shell-snapshot": shellControls, worktrees: worktreeControls,
  "path-rules": rulesControls, "review-checks": checksControls, ci: ciControls,
  init: async () => [make("p", "field-note", "coding.init.how", "Type /init in the message box.")] };

async function buildCard() {
  const { modes } = await api("coding");
  const node = make("section", "card");
  node.id = "coding-card";
  node.dataset.home = "settings:advanced";
  node.append(make("h3", "settings-card-title", "coding.title", "Coding polish"),
    make("p", "subtle", "coding.purpose", "Extra help for work on code: tidying and checking files, your own shell, @ mentions, separate copies, checklists, project rules and checks."));
  const status = make("p", "subtle");
  status.setAttribute("role", "status");
  for (const part of Object.keys(PARTS)) {
    node.append(...switchFor(part, modes, status));
    if (CONTROLS[part] && (modes[part] !== "off" || ALWAYS_DRAWN.has(part))) node.append(...await CONTROLS[part](status).catch((error) => [plain("p", error.message, "field-note")]));
  }
  node.append(status);
  return { node, modes };
}

async function drawCard() {
  let built;
  try { built = await buildCard(); } catch { return; }
  const old = $("coding-card");
  if (old) old.replaceWith(built.node); else document.body.append(built.node);
  current.modes = built.modes;
  await drawChecklist().catch(() => undefined);
}
const current = { modes: {} };

/* ---------- the side pane's Plan tab: this task's checklist ---------- */

function checklistBlock() {
  let block = $("coding-checklist-block");
  if (block) return block;
  block = make("div", "context-block");
  block.id = "coding-checklist-block";
  block.dataset.pane = "plan";
  $("context-panel")?.append(block);
  return block;
}

async function drawChecklist() {
  const block = checklistBlock();
  const session = $("conversation")?.dataset.sessionId;
  block.hidden = current.modes.checklist === "off" || !current.modes.checklist || !session;
  if (block.hidden) return;
  const { checklist } = await api(`coding/checklist/${session}`);
  const status = make("p", "subtle");
  const steps = checklist.steps.map((step) => ({ ...step }));
  const save = attempt(status, () => api(`coding/checklist/${session}`, { steps: steps.map(({ id, text, done: finished }) => ({ id, text, done: finished })) }));
  const list = document.createElement("ul");
  list.className = "context-rows";
  for (const step of steps) {
    const tick = field("input", step.done, "checkbox");
    tick.addEventListener("change", () => { step.done = tick.checked; void save(); });
    const label = plain("label", step.text);
    label.htmlFor = tick.id = `coding-step-${step.id}`;
    const item = document.createElement("li");
    item.append(tick, label);
    list.append(item);
  }
  const text = field("input");
  const add = button("coding.checklist.add", "Add a step", async () => { if (text.value.trim()) { steps.push({ text: text.value.trim(), done: false }); await save(); await drawChecklist(); } });
  block.replaceChildren(make("h2", "context-head", "coding.checklist.title", "This task's checklist"), list,
    ...labelled("coding-step-text", "coding.checklist.new", "A step to add", text), row(add), status);
}

/* ---------- the @ picker in the message box ---------- */

function mentionAt(box) {
  const before = box.value.slice(0, box.selectionStart);
  const match = /(?:^|\s)@([\w./-]*)$/.exec(before);
  return match ? { query: match[1], start: before.length - match[1].length } : null;
}

function watchComposer() {
  const box = $("prompt");
  if (!box || box.dataset.codingPicker) return;
  box.dataset.codingPicker = "1";
  // The same look as the "/" menu (public/commands.js, style.css), above the message box.
  const menu = make("ul", "slash-menu");
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", say("coding.mentions.label", "Files to point at"));
  box.closest("form")?.prepend(menu);
  box.addEventListener("input", async () => {
    const at = current.modes.mentions && current.modes.mentions !== "off" ? mentionAt(box) : null;
    if (!at) { menu.hidden = true; return; }
    const { suggestions } = await api(`coding/mentions?q=${encodeURIComponent(at.query)}`).catch(() => ({ suggestions: [] }));
    menu.replaceChildren(...suggestions.map((path) => {
      const item = plain("li", path, "slash-choice");
      item.setAttribute("role", "option");
      item.tabIndex = 0;
      const pick = () => {
        box.value = `${box.value.slice(0, at.start)}${path} ${box.value.slice(box.selectionStart)}`;
        menu.hidden = true;
        box.focus();
      };
      item.addEventListener("click", pick);
      item.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); pick(); } });
      return item;
    }));
    menu.hidden = !suggestions.length;
  });
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

whenReady(() => {
  void drawCard();
  watchComposer();
  const conversation = $("conversation");
  if (conversation) new MutationObserver(() => { void drawChecklist().catch(() => undefined); })
    .observe(conversation, { attributes: true, attributeFilter: ["data-session-id"] });
});
