/**
 * The code editor (A0098), in the side pane's Files tab, and its switch in Settings → Advanced.
 * A folder list, a plain text editor with line numbers, and one Save. Saving goes through the
 * assistant's own file tool, so the bytes before are kept and the change can be put back; a file
 * changed since it was opened is merged in when the two edits touch different lines, and only a
 * real conflict is refused. Off by default.
 *
 * FQ-collaboration: a file whose name says it is a video opens as a player instead of text — its
 * bytes come from `/api/media-comments/media` (src/server.ts), gated by this same switch — with the
 * comments pinned to it (src/media-comments.ts) listed beside it. Clicking a comment's timestamp
 * reopens the video at that moment; the form below the player adds a new one at wherever the video
 * is paused right now.
 */
import { t } from "/i18n.js";
import { addMediaComment, listMediaComments, renderMediaComments } from "/media-comments.js";

const $ = (id) => document.getElementById(id);
const token = () => sessionStorage.getItem("branch-token") || "";
// `kind` keeps Save from writing a video's path with the text editor's stale content, or the other
// way round, once a file of one kind has been opened after a file of the other.
const state = { folder: ".", path: "", opened: null, base: "", dirty: false, readOnly: false, mediaUrl: "", kind: "text" };
const videoExtension = /\.(mp4|m4v|webm|ogv|mov)$/i;

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
  if (videoExtension.test(path)) return openMedia(path);
  closeMedia();
  try {
    const file = await call(`read?path=${encodeURIComponent(path)}`);
    Object.assign(state, { path: file.path, opened: file.opened, base: file.content, dirty: false, readOnly: file.readOnly, kind: "text" });
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

/** Frees the previous video's blob address; called before a new file opens and when this closes. */
function closeMedia() {
  if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl);
  state.mediaUrl = "";
  $("wsedit-media").hidden = true;
  $("wsedit-media-video").removeAttribute("src");
}

/** Opens a video from the workspace: fetches its bytes, shows the player, and lists its comments. */
async function openMedia(path) {
  $("wsedit-editor").hidden = true;
  Object.assign(state, { path: "", opened: null, dirty: false });
  try {
    const response = await fetch(`/api/media-comments/media?fileId=${encodeURIComponent(path)}`,
      { headers: { authorization: `Bearer ${token()}` } });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || t("wsedit.media.load-failed"));
    if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl);
    state.mediaUrl = URL.createObjectURL(await response.blob());
    Object.assign(state, { path, kind: "media" });
    $("wsedit-media-video").src = state.mediaUrl;
    $("wsedit-media-path").textContent = path;
    $("wsedit-media").hidden = false;
    say("");
    await refreshComments();
  } catch (error) {
    closeMedia();
    say(error.message);
  }
}

/** Redraws the comment list from the server, so a moment just added shows up right away. */
async function refreshComments() {
  const comments = await listMediaComments(state.path);
  const container = $("wsedit-media-comments");
  renderMediaComments(container, comments, $("wsedit-media-video"));
  if (!comments.length) container.append(Object.assign(document.createElement("p"),
    { className: "context-empty", textContent: t("wsedit.media.comments.empty") }));
}

$("wsedit-media-comment-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("wsedit-media-comment-text");
  const text = input.value.trim();
  if (!text || !state.path) return;
  try {
    await addMediaComment(state.path, $("wsedit-media-video").currentTime, text);
    input.value = "";
    await refreshComments();
  } catch (error) {
    say(error.message);
  }
});

async function save() {
  if (!state.path || state.readOnly || state.kind !== "text") return;
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
