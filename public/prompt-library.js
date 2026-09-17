/**
 * The prompts the owner asks for often, on the screen that already holds saved procedures.
 *
 * A procedure is steps that run. A prompt is just the asking, written well once. They sit together
 * because from where the owner stands they are the same thought — "the thing I keep wanting" — and
 * splitting them across two screens would mean deciding which kind a thing is before you can find it.
 *
 * The list is grouped, and the group is a plain text field rather than a picker with a "new group…"
 * option, because typing a word you already used files it in the same place and typing a new one
 * makes the group. Nothing to manage, and nothing to clean up when the last one leaves a group.
 */
import { t } from "/i18n.js";

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
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
const worded = (tag, key, english, className) => {
  const node = el(tag, english, className);
  node.dataset.t = key;
  return node;
};

/** One saved prompt as a row: what it is called, what it is for, and the two things you can do. */
function row(saved, refresh, fill) {
  const line = el("li", undefined, "prompt-row");
  const name = el("strong", saved.name);
  line.append(name);
  if (saved.description) line.append(el("p", saved.description, "field-note"));
  const declared = Object.keys(saved.parameters ?? {});
  if (declared.length) line.append(el("p", t("prompts.asks-for", { names: declared.join(", ") }), "field-note"));

  const use = worded("button", "action.use-this-prompt", "Use this", "quiet-button");
  use.type = "button";
  use.addEventListener("click", () => fill(saved));
  const edit = worded("button", "action.edit", "Edit", "text-button");
  edit.type = "button";
  edit.addEventListener("click", () => fill(saved, { editing: true }));
  const remove = worded("button", "action.remove", "Remove", "text-button");
  remove.type = "button";
  remove.addEventListener("click", async () => {
    await api(`prompts/${encodeURIComponent(saved.id)}/remove`, {});
    await refresh();
  });
  line.append(el("div", undefined, "prompt-actions"));
  line.lastElementChild.append(use, edit, remove);
  return line;
}

function groupBlock(name, saved, refresh, fill) {
  const block = el("div", undefined, "prompt-group");
  block.append(el("h3", name));
  const list = el("ul", undefined, "prompt-list");
  for (const entry of saved) list.append(row(entry, refresh, fill));
  block.append(list);
  return block;
}

/** The form. The same one writes a new prompt and edits an existing one, so there is one shape to learn. */
function form(state, refresh) {
  const shape = el("form", undefined, "prompt-form");
  const fields = [
    ["name", "field.prompt-name", "Name", "input", 80],
    ["group", "field.prompt-group", "Group", "input", 60],
    ["description", "field.prompt-description", "What it is for, in one line", "input", 300],
    ["text", "field.prompt-text", "What to ask", "textarea", 8000],
  ];
  for (const [key, labelKey, english, tag, max] of fields) {
    const label = worded("label", labelKey, english);
    label.htmlFor = `prompt-${key}`;
    const control = el(tag);
    control.id = `prompt-${key}`;
    control.maxLength = max;
    if (tag === "textarea") control.rows = 6;
    shape.append(label, control);
  }
  shape.append(worded("p", "prompts.placeholders-note",
    "Write {{like_this}} for anything that changes each time. You will be asked for it when you use the prompt.",
    "field-note"));
  const status = el("p", undefined, "meta");
  status.setAttribute("role", "status");
  const save = worded("button", "action.save-this-prompt", "Save this prompt");
  save.type = "submit";
  shape.append(save, status);
  shape.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = Object.fromEntries(fields.map(([key]) => [key, shape.querySelector(`#prompt-${key}`).value.trim()]));
    /* Anything written {{like this}} is declared for the owner rather than making them do it twice. */
    const names = [...new Set([...value.text.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)].map((m) => m[1]))];
    const parameters = Object.fromEntries(names.map((name) => [name, { type: "string", required: true }]));
    try {
      await api(`prompts/${encodeURIComponent(state.editing ?? crypto.randomUUID())}`, { ...value, parameters });
      state.editing = null;
      await refresh();
    } catch (error) { status.textContent = error.message; }
  });
  return shape;
}

/** Puts a saved prompt's words in the message box, asking for anything it needs first. */
function useIt(saved) {
  let text = saved.text;
  for (const name of Object.keys(saved.parameters ?? {})) {
    const given = globalThis.prompt(t("prompts.what-is", { name }));
    if (given === null) return;
    text = text.replaceAll(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, "g"), given);
  }
  const box = document.getElementById("prompt");
  if (!box) return;
  box.value = text;
  box.focus();
  document.querySelector(".lx-back")?.click();
}

export async function drawPromptLibrary() {
  let state;
  try { state = await api("prompts"); } catch { return; }
  const editing = { editing: null };
  document.getElementById("prompt-library")?.remove();
  const card = el("section", undefined, "card");
  card.id = "prompt-library";
  card.dataset.home = "automations:procedures";
  card.append(worded("h2", "settings.card.prompts-you-ask-for-often", "Prompts you ask for often"));
  card.append(worded("p", "settings.note.prompt-library",
    "The things you find yourself typing again. Save one here and it is two clicks away, with the parts that change asked for as you use it."));

  const refresh = () => drawPromptLibrary();
  if (!state.prompts.length) {
    const empty = el("div", undefined, "empty-state");
    empty.append(worded("p", "prompts.empty", "Nothing saved yet."));
    empty.append(worded("p", "prompts.empty-next",
      "Write the next thing you ask for twice in the box below, give it a name, and it is here for good.", "field-note"));
    card.append(empty);
  } else {
    for (const { name } of state.groups)
      card.append(groupBlock(name, state.prompts.filter((entry) => (entry.group || "Everything else") === name),
        refresh, (saved, options) => {
          if (options?.editing) {
            editing.editing = saved.id;
            for (const key of ["name", "group", "description", "text"])
              card.querySelector(`#prompt-${key}`).value = saved[key] ?? "";
            card.querySelector("#prompt-name").focus();
          } else useIt(saved);
        }));
  }
  card.append(form(editing, refresh));
  document.body.append(card);
}

if (typeof document !== "undefined") {
  globalThis.branchPromptLibraryReady = () => { drawPromptLibrary().catch(() => {}); };
  document.addEventListener("branch-language", () => { drawPromptLibrary().catch(() => {}); });
  drawPromptLibrary().catch(() => {});
}
