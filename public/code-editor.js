/**
 * The code editor (A0098), in the side pane's Files tab, and its switch in Settings → Advanced.
 * A folder list, a plain text editor with line numbers, and one Save. Saving goes through the
 * assistant's own file tool, so the bytes before are kept and the change can be put back; a file
 * changed since it was opened is merged in when the two edits touch different lines, and only a
 * real conflict is refused. Off by default.
 */
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const token = () => sessionStorage.getItem("branch-token") || "";
const state = { folder: ".", path: "", opened: null, base: "", dirty: false, readOnly: false };

async function call(path, body) {
  const response = await fetch(`/api/workspace-editor/${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token()}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || t("wsedit.failed"));
  return data;
}
const say = (text) => { const node = $("wsedit-status"); if (node) node.textContent = text; };

function row(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "quiet wsedit-entry";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

async function list(folder) {
  if (state.dirty && !confirm(t("wsedit.discard"))) return;
  try {
    const answer = await call(`list?path=${encodeURIComponent(folder)}`);
    state.folder = folder;
    $("wsedit-folder").textContent = folder === "." ? t("wsedit.top") : folder;
    const rows = [];
    if (folder !== ".") rows.push(row(t("wsedit.up"), () => list(folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : ".")));
    for (const entry of answer.entries)
      rows.push(row(entry.type === "directory" ? `${entry.name}/` : entry.name,
        () => (entry.type === "directory" ? list(entry.path) : open(entry.path))));
    $("wsedit-list").replaceChildren(...rows);
    if (!answer.entries.length) say(t("wsedit.empty"));
  } catch (error) {
    say(error.message);
  }
}

async function open(path) {
  if (state.dirty && !confirm(t("wsedit.discard"))) return;
  try {
    const file = await call(`read?path=${encodeURIComponent(path)}`);
    Object.assign(state, { path: file.path, opened: file.opened, base: file.content, dirty: false, readOnly: file.readOnly });
    $("wsedit-text").value = file.content;
    $("wsedit-text").readOnly = file.readOnly;
    $("wsedit-path").textContent = file.path;
    $("wsedit-save").disabled = file.readOnly;
    $("wsedit-editor").hidden = false;
    say(file.readOnly ? (file.why || t("wsedit.read-only")) : "");
    refresh();
  } catch (error) {
    say(error.message);
  }
}

async function save() {
  if (!state.path || state.readOnly) return;
  try {
    const content = $("wsedit-text").value;
    const saved = await call("save", { path: state.path, content, opened: state.opened, base: state.base });
    if (saved.merged) $("wsedit-text").value = saved.content;
    Object.assign(state, { opened: saved.opened, base: saved.merged ? saved.content : content, dirty: false });
    refresh();
    say(saved.merged ? t("wsedit.merged") : t("wsedit.saved"));
  } catch (error) {
    say(error.message);
  }
}

function refresh() {
  const text = $("wsedit-text");
  const lines = text.value.split("\n").length;
  $("wsedit-lines").textContent = Array.from({ length: lines }, (_, index) => index + 1).join("\n");
  $("wsedit-unsaved").hidden = !state.dirty;
}

function onKey(event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void save();
  } else if (event.key === "Tab" && !event.shiftKey && !state.readOnly) {
    event.preventDefault();
    const text = event.target;
    const { selectionStart: start, selectionEnd: end } = text;
    text.setRangeText("  ", start, end, "end");
    state.dirty = true;
    refresh();
  }
}

async function start() {
  try {
    const { mode } = await call("settings");
    $("wsedit-off").hidden = mode !== "off";
    $("wsedit-on").hidden = mode === "off";
    if (mode !== "off") await list(state.folder);
  } catch (error) {
    say(error.message);
  }
}

/*
 * FQ-surfaces.editor-clients: ask the owner's knowledge bases a question from right inside the
 * editor, and open whichever file the answer cites — the same `open()` the file list already uses.
 */
const askSay = (text) => { const node = $("wsedit-ask-status"); if (node) node.textContent = text; };

function sourceRow(source) {
  const item = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = `[${source.number}] ${source.title}`;
  item.append(label, row(t("wsedit.ask.open"), () => open(source.path)));
  return item;
}

async function ask(question) {
  askSay(t("wsedit.ask.asking"));
  $("wsedit-ask-answer").hidden = true;
  try {
    const answer = await call("ask", { question });
    $("wsedit-ask-text").textContent = answer.answer;
    $("wsedit-ask-sources").replaceChildren(...answer.sources.map(sourceRow));
    $("wsedit-ask-answer").hidden = false;
    askSay(answer.sources.length ? "" : t("wsedit.ask.empty"));
  } catch (error) {
    askSay(error.message);
  }
}

$("wsedit-ask-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = $("wsedit-ask-question").value.trim();
  if (question) void ask(question);
});

/* The switch, in Settings → Advanced. */
async function loadSwitch() {
  try { $("wsedit-mode").value = (await call("settings")).mode; } catch { /* not signed in yet */ }
}
$("wsedit-mode-save")?.addEventListener("click", async () => {
  try {
    await call("settings", { mode: $("wsedit-mode").value });
    $("wsedit-mode-status").textContent = t("wsedit.switch-saved");
  } catch (error) {
    $("wsedit-mode-status").textContent = error.message;
  }
});
$("wsedit-card")?.addEventListener("toggle", () => { if ($("wsedit-card").open) void loadSwitch(); });

$("wsedit")?.addEventListener("toggle", () => { if ($("wsedit").open) void start(); });
$("wsedit-text")?.addEventListener("input", () => { state.dirty = true; refresh(); });
$("wsedit-text")?.addEventListener("keydown", onKey);
$("wsedit-text")?.addEventListener("scroll", (event) => { $("wsedit-lines").scrollTop = event.target.scrollTop; });
$("wsedit-save")?.addEventListener("click", () => void save());
