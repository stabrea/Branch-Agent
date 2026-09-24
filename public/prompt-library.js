/* Bucket 12: "Your saved prompts", in Automations › Procedures.

   The things the owner asks for often, in groups, each with an optional command of its own
   (/weekly) that works in the window, on the phone, in the terminal and in chat apps. Writing one is
   done here with the blanks it needs listed as you type, a try on one or two models side by side
   before saving, and earlier wordings to put back. The switch ships off; while it is off the card
   shows only the switch. */
import { api, displayView, loadSlashCommands } from "/app.js";
import { t } from "/i18n.js";
import { segmented, dropdown } from "/control-makers.js";

const $ = (id) => document.getElementById(id);
const say = (key, english, values) => { const word = t(key, values); return word === key ? english : word; };
function make(tag, className, key, english) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  return node;
}
function text(tag, words, className) {
  const node = make(tag, className);
  node.textContent = words;
  return node;
}
function button(key, english, quiet, onClick) {
  const node = make("button", quiet ? "quiet-button" : "", key, english);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}
function field(id, key, english, control) {
  control.id = id;
  const label = make("label", "", key, english);
  label.htmlFor = id;
  return [label, control];
}
const POSITIONS = [["off", "field.switch-off", "Off"], ["on", "field.switch-on", "On"], ["when-needed", "field.switch-when-needed", "When needed"]];
const NOTES = {
  off: ["prompts.note.off", "Off: nothing is saved or offered, and a typed /name is what it always was."],
  "when-needed": ["prompts.note.whenNeeded", "When needed: your commands work when you type them, but the / menu does not list them; /prompts does."],
  on: ["prompts.note.on", "On: your commands work and every / menu lists them."],
};
const blanksOf = (body) => [...new Set([...String(body).matchAll(/\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g)].map((m) => m[1]))]
  .filter((name) => name !== "today" && name !== "input");

const status = () => $("prompts-status");
function report(words, key) {
  const node = status();
  if (!node) return;
  if (key) node.dataset.t = key; else delete node.dataset.t;
  node.textContent = words;
}

/* ---------- the switch ---------- */

function switchRow(mode) {
  const control = segmented({
    id: "prompts-mode",
    options: POSITIONS,
    value: mode,
    onChange: async (value) => {
      try {
        await api("prompts/settings", { mode: value });
        await loadSlashCommands(true);
        await draw();
      } catch (error) { report(error.message); }
    }
  });
  const label = make("label", "", "prompts.field.switch", "Saved prompts");
  label.htmlFor = "prompts-mode";
  const note = make("p", "field-note", ...(NOTES[mode] ?? NOTES.off));
  return [label, control, note];
}

/* ---------- the list ---------- */

function use(prompt) {
  displayView("chat");
  const box = $("prompt");
  if (!box) return;
  box.value = prompt.body;
  box.focus();
}
function row(prompt) {
  const item = make("li", "prompts-row");
  const title = text("strong", prompt.title);
  const command = prompt.command ? text("code", ` /${prompt.command}`) : null;
  const about = prompt.description ? text("p", prompt.description, "subtle") : null;
  const actions = make("div", "row-actions");
  actions.append(button("prompts.action.use", "Use", true, () => use(prompt)),
    button("prompts.action.edit", "Edit", true, () => edit(prompt)),
    button("prompts.action.remove", "Remove", true, () => remove(prompt)));
  item.append(title, ...(command ? [command] : []), ...(about ? [about] : []), actions);
  return item;
}
function list(prompts) {
  const box = make("div", "prompts-list");
  box.id = "prompts-list";
  if (!prompts.length) {
    box.append(make("p", "empty-state", "prompts.empty", "No saved prompts yet. Write one below, or add the examples to start from."));
    return box;
  }
  const groups = new Map();
  for (const prompt of prompts) groups.set(prompt.group, [...(groups.get(prompt.group) ?? []), prompt]);
  for (const [name, members] of groups) {
    const details = make("details");
    details.open = true;
    const summary = name ? text("summary", `${name} (${members.length})`) : make("summary", "", "prompts.ungrouped", "Not in a group");
    const items = make("ul", "prompts-group");
    items.append(...members.sort((a, b) => b.uses - a.uses).map(row));
    details.append(summary, items);
    box.append(details);
  }
  return box;
}
async function remove(prompt) {
  try { await api("prompts/remove", { id: prompt.id }); await loadSlashCommands(true); await draw(); }
  catch (error) { report(error.message); }
}

/* ---------- writing one, and trying it ---------- */

function inputs(names) {
  const box = $("prompts-blanks");
  if (!box) return;
  const kept = Object.fromEntries([...box.querySelectorAll("input")].map((input) => [input.dataset.blank, input.value]));
  box.replaceChildren();
  if (!names.length) { box.append(make("p", "field-note", "prompts.blanks.none", "No blanks. Write {{name}} where a word should be filled in when the prompt is used; {{input}} takes whatever follows the command.")); return; }
  for (const name of names) {
    const input = document.createElement("input");
    input.dataset.blank = name;
    input.value = kept[name] ?? "";
    const label = text("label", name);
    label.htmlFor = input.id = `prompts-blank-${name}`;
    box.append(label, input);
  }
}
function modelSelect(id, choices, blank) {
  const options = [];
  if (blank) options.push(["", "prompts.compare.none", "Nobody else"]);
  for (const choice of choices) {
    options.push([choice.id, "", choice.name]);
  }
  return dropdown({ id, options, value: blank ? "" : (choices.length > 0 ? choices[0].id : "") });
}
function editor(choices) {
  const box = make("fieldset", "prompts-editor");
  box.id = "prompts-editor";
  const legend = make("legend", "", "prompts.editor.title", "Write or change a prompt");
  const [titleLabel, title] = field("prompts-title", "prompts.field.title", "Name of the prompt", document.createElement("input"));
  const [groupLabel, group] = field("prompts-group", "prompts.field.group", "Group", document.createElement("input"));
  const [commandLabel, command] = field("prompts-command", "prompts.field.command", "Command (without the /)", document.createElement("input"));
  const [aboutLabel, about] = field("prompts-description", "prompts.field.description", "What it is for", document.createElement("input"));
  const [bodyLabel, body] = field("prompts-body", "prompts.field.body", "The prompt", document.createElement("textarea"));
  body.rows = 6;
  body.addEventListener("input", () => inputs(blanksOf(body.value)));
  const blanks = make("div", "prompts-blanks");
  blanks.id = "prompts-blanks";
  const versions = make("div");
  versions.id = "prompts-versions";
  box.append(legend, titleLabel, title, groupLabel, group, commandLabel, command, aboutLabel, about, bodyLabel, body,
    make("p", "field-note", "prompts.blanks.title", "Filled in when it is used:"), blanks, versions, ...trySection(choices), ...saveSection());
  return box;
}
function trySection(choices) {
  const [firstLabel, first] = field("prompts-model", "prompts.field.model", "Try it with", modelSelect("", choices, false));
  const [secondLabel, second] = field("prompts-compare", "prompts.field.compare", "Side by side with", modelSelect("", choices, true));
  const answers = make("div", "prompts-answers");
  answers.id = "prompts-answers";
  const run = button("prompts.action.try", "Try it", true, () => tryIt(run));
  const note = make("p", "subtle", "prompts.try.note", "Trying asks the model with no tools at all, in a conversation that is not kept.");
  return [firstLabel, first, secondLabel, second, run, note, answers];
}
async function tryIt(run) {
  const body = $("prompts-body").value, answers = $("prompts-answers");
  const values = Object.fromEntries([...document.querySelectorAll("#prompts-blanks input")].map((input) => [input.dataset.blank, input.value]));
  const models = [$("prompts-model").value, $("prompts-compare").value].filter(Boolean);
  run.disabled = true;
  answers.replaceChildren(make("p", "subtle", "prompts.try.waiting", "Asking…"));
  try {
    const result = await api("prompts/try", { body, values, models });
    answers.replaceChildren(...result.answers.map((answer) => {
      const cell = make("div", "prompts-answer");
      cell.append(text("strong", answer.model ?? say("prompts.try.default", "The usual model")), text("p", answer.output), text("p", `${answer.status} · ${answer.milliseconds} ms`, "subtle"));
      return cell;
    }));
  } catch (error) { answers.replaceChildren(text("p", error.message)); }
  finally { run.disabled = false; }
}
function saveSection() {
  const save = button("prompts.action.save", "Save the prompt", false, () => saveCurrent());
  const clear = button("prompts.action.new", "Start a new one", true, () => edit(null));
  return [save, clear];
}
async function saveCurrent() {
  const id = $("prompts-editor").dataset.id;
  const body = {
    title: $("prompts-title").value, group: $("prompts-group").value, command: $("prompts-command").value.replace(/^\//, ""),
    description: $("prompts-description").value, body: $("prompts-body").value, ...(id ? { id } : {}),
  };
  try {
    const saved = await api("prompts", body);
    await loadSlashCommands(true);
    await draw();
    edit(saved);
    report(say("prompts.saved", "Saved."), "prompts.saved");
  } catch (error) { report(error.message); }
}
function edit(prompt) {
  const box = $("prompts-editor");
  if (!box) return;
  if (prompt) box.dataset.id = prompt.id; else delete box.dataset.id;
  for (const [id, value] of [["prompts-title", prompt?.title], ["prompts-group", prompt?.group], ["prompts-command", prompt?.command], ["prompts-description", prompt?.description], ["prompts-body", prompt?.body]])
    $(id).value = value ?? "";
  inputs(blanksOf(prompt?.body ?? ""));
  earlier(prompt);
  box.scrollIntoView?.({ block: "nearest" });
}
function earlier(prompt) {
  const box = $("prompts-versions");
  box.replaceChildren();
  if (!prompt?.versions?.length) return;
  const options = prompt.versions.map((version, index) => {
    const text = `${new Date(version.savedAt).toLocaleString()} — ${version.body.slice(0, 40)}`;
    return [String(index), text, text];
  });
  const select = dropdown({ id: "prompts-version", options, value: "0" });
  const label = make("label", "", "prompts.field.versions", "Earlier wordings");
  label.htmlFor = "prompts-version";
  const back = button("prompts.action.putBack", "Put this wording back", true, () => {
    $("prompts-body").value = prompt.versions[Number(select.value)].body;
    inputs(blanksOf($("prompts-body").value));
  });
  box.append(label, select, back);
}

/* ---------- examples, and moving prompts between computers ---------- */

function extras(view) {
  const box = make("details");
  const snippet = text("pre", JSON.stringify(view.exampleServer, null, 2));
  snippet.style.whiteSpace = "pre-wrap";
  snippet.style.overflowWrap = "anywhere";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "application/json,.json";
  file.addEventListener("change", () => importFile(file));
  box.append(make("summary", "", "prompts.more", "Examples, and moving prompts to another computer"),
    make("p", "field-note", "prompts.examples.note", "The examples include one that uses a small tool server shipped with Branch. To connect it, add these lines to your integrations file and restart Branch."),
    snippet,
    button("prompts.action.examples", "Add the examples", true, addExamples),
    button("prompts.action.export", "Save all as a file", true, exportAll),
    ...field("prompts-import", "prompts.field.import", "Add prompts from a file", file));
  return box;
}
async function addExamples() {
  try {
    const result = await api("prompts/examples", {});
    await loadSlashCommands(true);
    await draw();
    report(say("prompts.examples.added", "Added {count} example(s).", { count: result.added.length }));
  } catch (error) { report(error.message); }
}
async function exportAll() {
  const file = await api("prompts/export");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
  link.download = "branch-prompts.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
async function importFile(input) {
  try {
    const result = await api("prompts/import", JSON.parse(await input.files[0].text()));
    await loadSlashCommands(true);
    await draw();
    report([say("prompts.imported", "Added {count} prompt(s).", { count: result.added.length }), ...result.notes].join(" "));
  } catch (error) { report(error.message); }
}

/* ---------- the card ---------- */

function buildCard(view, choices) {
  const card = make("section", "card");
  card.id = "prompts-card";
  card.dataset.home = "automations:procedures";
  card.append(make("h2", "", "prompts.card.title", "Your saved prompts"),
    make("p", "", "prompts.card.purpose", "The things you ask for often, kept in groups, each with a command of its own if you like, such as /weekly."),
    ...switchRow(view.settings.mode));
  const said = make("p", "subtle");
  said.id = "prompts-status";
  said.setAttribute("role", "status");
  if (view.settings.mode !== "off") card.append(list(view.prompts), editor(choices), extras(view));
  card.append(said);
  return card;
}
async function draw() {
  let view, choices = [];
  try { view = await api("prompts"); } catch { return; }
  if (view.settings.mode !== "off") choices = (await api("models/switch").catch(() => ({ choices: [] }))).choices ?? [];
  const open = $("prompts-editor")?.dataset.id;
  $("prompts-card")?.remove();
  document.body.append(buildCard(view, choices));
  const current = open && view.prompts.find((prompt) => prompt.id === open);
  if (current) edit(current); else if ($("prompts-editor")) inputs([]);
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
if (typeof document !== "undefined") {
  document.addEventListener("branch-language", () => { draw().catch(() => {}); });
  whenReady(() => { draw().catch(() => {}); });
}
