// Redesign phase 2 (accounts, critique #40): the assistant's own files, read and changed in the window.
// SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md, SOP.md, MEMORY.md and HEARTBEAT.md: what each
// is for, where it is kept, whether it is read, and (DG-182) the sample's editor dialog: a starter, Write
// beside its Preview, History with "Put this back", and a clear Save that waits while the text is too long.
// It replaces R17-S05's "Which file does what" list and uses its
// routes (src/settings-kit/file-map.ts): the owner's alone, never a household person's or a chat
// app's (the server refuses the reads and writes to anybody else; there is no tool for them).
import { api, ownerAtWindow } from "/app.js";
import { t } from "/i18n.js";
import { fillMarkdown } from "/markdown.js";

const say = (key, english, values) => { const said = t(key, values); return said === key ? english : said; };
function el(tag, key, english, className) {
  const node = document.createElement(tag);
  if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  else if (english !== undefined) node.textContent = english;
  if (className) node.className = className;
  return node;
}
function button(key, english, onClick, className = "quiet-button") {
  const node = el("button", key, english, className);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}
const bytesOf = (text) => new TextEncoder().encode(text).length;
let drawGeneration = 0;
/* The list's own refresh, so a switch saved on another page's card shows here at once (see context-files.js). */
let redrawList = null;

const ABOUT = {
  soul: "Who your assistant is: personality, tone and boundaries.",
  identity: "Its name and vibe, as you gave them.", user: "Who you are, how to address you, what you prefer.",
  agents: "How you want work done here.", tools: "Your notes about this computer's own tools and quirks.",
  sop: "Procedures to follow the same way every time.", memory: "Things you wrote down to be remembered.",
  heartbeat: "What it checks on by itself when it wakes on a schedule.",
};
/* DG-182: each file's Off, When needed or On, saved as it is pressed (DG-025). The same switch the file's own page shows. */
const MODES = [["off", "field.switch-off", "Off"], ["when-needed", "field.switch-when-needed", "When needed"], ["on", "field.switch-on", "On"]];
const SEEN = {
  carried: ["settings-kit.seen.carried", "Read at the start of every task"],
  announced: ["settings-kit.seen.announced", "Named to it; read when the work calls for it"],
  "no room": ["settings-kit.seen.no-room", "Switched on, but there was no room; named instead"],
  off: ["settings-kit.seen.off", "Not read: switched off"], missing: ["settings-kit.seen.missing", "Not written yet"],
  empty: ["settings-kit.seen.empty", "Empty, so nothing to read"], "not trusted": ["settings-kit.seen.not-trusted", "Not read: this folder is not trusted"],
};
const WHY = {
  "not trusted": ["settings-kit.why.not-trusted", "This project's folder is not trusted, so its files are not read or written. Trust it under Permissions first."],
  "too long": ["settings-kit.why.too-long", "This file is longer than your assistant reads, so open it in your own editor to shorten it."],
};

function modeGroup(entry, choose) {
  const name = entry.name ?? entry.names[0];
  const group = el("div", undefined, undefined, "seg tri agent-file-mode");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", say("agent-files.use-named", `Use ${name}`, { name }));
  for (const [value, key, english] of MODES) {
    const option = button(key, english, () => choose(entry.slot, value, group), "segmented-option");
    option.dataset.v = value === "when-needed" ? "needed" : value;
    option.setAttribute("aria-pressed", String(entry.setting === value));
    group.append(option);
  }
  return group;
}

function fileRow(entry, open, choose) {
  const row = el("li", undefined, undefined, "agent-file");
  row.dataset.slot = entry.slot;
  const name = el("span", undefined, entry.name ?? entry.names[0], "agent-file-name");
  const body = el("div", undefined, undefined, "agent-file-body");
  const where = entry.scope === "you" ? ["settings-kit.kept.you", "Kept with your own things, used in every project"] : ["settings-kit.kept.project", "Kept in this project's folder"];
  const written = entry.name
    ? say("settings-kit.written", `Written: ${entry.name}, ${Math.round(entry.bytes / 100) / 10} kB`, { name: entry.name, size: Math.round(entry.bytes / 100) / 10 })
    : say("settings-kit.seen.missing", "Not written yet");
  const seen = entry.name || entry.outcome !== "missing" ? SEEN[entry.outcome] ?? SEEN.missing : null;
  /* The sample's line under each file: its first words, or Empty; where it is kept and whether it was read at Technical. */
  const first = entry.first ? el("p", undefined, entry.first, "meta agent-file-first") : el("p", "agent-files.empty", "Empty", "meta agent-file-first");
  const kept = el("p", undefined, [say(where[0], where[1]), written, seen ? say(seen[0], seen[1]) : ""].filter(Boolean).join(" · "), "meta agent-file-where");
  kept.dataset.level = "technical";
  body.append(el("p", `settings-kit.slot.${entry.slot}`, ABOUT[entry.slot] ?? "", "agent-file-about"), first, kept);
  const edit = button("agent-files.edit", "Edit", () => open(entry.slot));
  edit.setAttribute("aria-label", say("agent-files.edit-named", `Edit ${entry.name ?? entry.names[0]}`, { name: entry.name ?? entry.names[0] }));
  row.append(name, body, modeGroup(entry, choose), edit);
  return row;
}

/* ---------- DG-182: the editor, a dialog as in the sample ---------- */

/** Over the most Branch reads, the line under the text says so and Save waits. Quiet until then, as in the sample. */
function sizeGuard(text, limit, line, save) {
  const used = bytesOf(text);
  const over = used > limit;
  line.hidden = !over;
  line.textContent = over ? `${say("agent-files.size", `${used} of ${limit} bytes`, { used: used.toLocaleString(), limit: limit.toLocaleString() })} ${say("agent-files.too-long", "Too long: shorten it before saving.")}` : "";
  save.disabled = over;
}

/** Write and Preview sit side by side; on a narrow window the two tabs choose which one shows. */
function tabs(pane) {
  const bar = el("div", undefined, undefined, "seg agent-file-tabs");
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", say("agent-files.view", "Write or preview"));
  const pick = (show) => {
    pane.dataset.show = show;
    for (const option of bar.children) option.setAttribute("aria-pressed", String(option.dataset.v === show));
  };
  for (const [value, key, english] of [["write", "agent-files.write", "Write"], ["preview", "agent-files.preview", "Preview"]]) {
    const option = button(key, english, () => pick(value), "segmented-option");
    option.dataset.v = value;
    bar.append(option);
  }
  pick("write");
  return bar;
}

/** "Start from a starter": a blank page, or the usual shape for this file. */
function starterPicker(file, slot, textarea) {
  const select = el("select", undefined, undefined, "agent-file-starter");
  select.setAttribute("aria-label", say("agent-files.starter", "Start from a starter"));
  const prompt = el("option", "agent-files.starter", "Start from a starter");
  prompt.value = "";
  prompt.disabled = true;
  const blank = el("option", "agent-files.starter.blank", "A blank page");
  blank.value = "blank";
  const usual = el("option", "agent-files.starter.usual", "The usual shape for this file");
  usual.value = "usual";
  select.append(prompt, blank, usual);
  select.value = "";
  select.addEventListener("change", () => {
    textarea.value = select.value === "blank" ? `# ${file.name.replace(/\.md$/i, "")}\n\n`
      : say(`agent-files.starter.${slot}`, say("agent-files.starter.default", "# \n\n- \n"));
    textarea.dispatchEvent(new Event("input"));
    select.value = "";
  });
  return select;
}

/** "Write it for me": AGENTS.md drafted from what is in this workspace, into the editor only. */
function writeForMe(textarea, status) {
  const write = button("agent-files.write-for-me", "Write it for me", async () => {
    write.disabled = true;
    try {
      textarea.value = (await api("settings-kit/files/draft", { slot: "agents" })).text;
      textarea.dispatchEvent(new Event("input"));
      status.textContent = say("agent-files.written-for-you", "Written from what is in this workspace. Read it before you save.");
    } catch (error) { status.textContent = error.message; }
    finally { write.disabled = false; }
  });
  return write;
}

function when(at) {
  const date = new Date(at);
  const language = document.documentElement.lang || undefined;
  const time = date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return say("agent-files.today", `Today ${time}`, { time });
  return `${date.toLocaleDateString(language, { day: "numeric", month: "short" })} ${time}`;
}

/** History (N): what the file held before each save here. "Put this back" fills the editor; Save keeps it. */
function historyList(versions, textarea, status) {
  const details = el("details", undefined, undefined, "agent-file-history");
  details.append(el("summary", undefined, say("agent-files.history", `History (${versions.length})`, { count: versions.length })));
  if (!versions.length) details.append(el("p", "agent-files.history-none", "Nothing saved before.", "meta"));
  for (const version of versions) {
    const row = el("div", undefined, undefined, "agent-file-version");
    const lines = version.text.split("\n").length;
    const back = button("agent-files.put-back", "Put this back", () => {
      textarea.value = version.text;
      textarea.dispatchEvent(new Event("input"));
      status.textContent = say("agent-files.put-back-done", "Put back in the editor. Save to keep it.");
    });
    back.setAttribute("aria-label", say("agent-files.put-back-named", `Put back the version from ${when(version.at)}`, { when: when(version.at) }));
    row.append(el("small", undefined, `${when(version.at)} · ${say("agent-files.lines", `${lines} lines`, { count: lines })}`, "meta"), back);
    details.append(row);
  }
  return details;
}

/** The tools above the text, the text beside its preview, and the foot: History, where it is kept, Cancel and Save. */
function editorParts(file, slot, dialog, saved) {
  const status = el("p", undefined, undefined, "meta agent-file-dialog-status");
  status.setAttribute("role", "status");
  const textarea = el("textarea", undefined, undefined, "agent-files-text");
  textarea.id = "agent-files-text";
  textarea.value = file.text;
  textarea.spellcheck = true;
  const label = el("label", "settings-kit.field.file-text", "What the file says", "sr-only");
  label.htmlFor = textarea.id;
  const preview = el("div", undefined, undefined, "agent-files-preview");
  preview.setAttribute("aria-label", say("agent-files.preview", "Preview"));
  const pane = el("div", undefined, undefined, "agent-file-ed");
  pane.append(label, textarea, preview);
  const size = el("p", undefined, undefined, "field-note agent-files-size");
  size.id = "agent-files-size";
  size.setAttribute("aria-live", "polite");
  textarea.setAttribute("aria-describedby", size.id);
  const save = button("action.save", "Save", async () => {
    save.disabled = true;
    try { await api("settings-kit/files", { slot, text: textarea.value }); dialog.close(); await saved(); }
    catch (error) { status.textContent = error.message; save.disabled = false; }
  }, "");
  const show = () => { fillMarkdown(preview, textarea.value || say("agent-files.nothing", "Nothing written yet.")); sizeGuard(textarea.value, file.limit, size, save); };
  textarea.addEventListener("input", show);
  show();
  const tools = el("div", undefined, undefined, "agent-file-tools");
  tools.append(starterPicker(file, slot, textarea));
  if (slot === "agents") tools.append(writeForMe(textarea, status));
  tools.append(el("span", undefined, undefined, "agent-file-grow"), tabs(pane));
  const foot = el("div", undefined, undefined, "agent-file-foot");
  foot.append(historyList(file.history ?? [], textarea, status));
  if (file.where) { const where = el("small", undefined, file.where, "meta agent-file-path"); where.dataset.level = "technical"; foot.append(where); }
  const actions = el("div", undefined, undefined, "agent-file-actions");
  actions.append(button("agent-files.cancel", "Cancel", () => dialog.close()), save);
  foot.append(actions);
  return [tools, pane, size, status, foot];
}

/** The X of the dialog's corner, drawn in the text colour. */
function crossIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6 6l12 12M18 6 6 18");
  svg.append(path);
  return svg;
}

/** The assistant's name, as its identity card has it. */
const assistantName = () => document.getElementById("identity-name")?.value.trim() || "Branch";

/** Opens one file in the editor dialog. It lives inside the card, so leaving the owner's profile takes it away too. */
async function openEditor(section, slot, saved, listStatus) {
  let file;
  try { file = await api(`settings-kit/files/${slot}`); } catch (error) { listStatus.textContent = error.message; return; }
  section.querySelector(".agent-file-dialog")?.remove();
  const dialog = el("dialog", undefined, undefined, "agent-file-dialog");
  const title = el("h2", undefined, say("agent-files.dialog-title", `${file.name} — ${assistantName()}`, { name: file.name, assistant: assistantName() }), "agent-file-dialog-title");
  title.id = "agent-file-dialog-title";
  dialog.setAttribute("aria-labelledby", title.id);
  const close = button(undefined, undefined, () => dialog.close(), "quiet-button agent-file-dialog-x");
  close.setAttribute("aria-label", say("agent-files.close", "Close"));
  close.append(crossIcon());
  const head = el("div", undefined, undefined, "agent-file-dialog-head");
  head.append(title, close);
  const body = el("div", undefined, undefined, "agent-file-dialog-body");
  body.append(el("p", `settings-kit.slot.${slot}`, ABOUT[slot] ?? "", "agent-file-dialog-about"));
  dialog.append(head, body);
  if (file.editable) body.append(...editorParts(file, slot, dialog, saved));
  else body.append(el("p", ...(WHY[file.why] ?? ["settings-kit.why.other", "This file cannot be changed here. Open it in your own editor."]), "field-note"));
  dialog.addEventListener("close", () => dialog.remove());
  section.append(dialog);
  dialog.showModal();
  dialog.querySelector("textarea")?.focus();
}

/** Draws the real file editor on Settings › Instructions & personality. */
export async function drawAgentFiles() {
  const generation = ++drawGeneration;
  if (!ownerAtWindow()) { document.getElementById("agent-files")?.remove(); return; }
  let map;
  try { map = await api("settings-kit/files"); } catch { return; }
  if (generation !== drawGeneration || !ownerAtWindow()) return;
  document.getElementById("agent-files")?.remove();
  const section = el("section", undefined, undefined, "card agent-files");
  section.id = "agent-files";
  section.dataset.home = "settings:instructions";
  section.dataset.level = "regular";
  /* DG-182: the section head above already says "Its files", and the sample shows it once (the DG-032 way): the
     card's own heading and purpose stay for a screen reader, at the section's level so the order is not turned over (DG-008). */
  section.append(el("h3", "agent-files.title", "Its files", "settings-card-title sr-only"),
    el("p", "settings-kit.card.files-purpose", "The plain files you write to shape your assistant: what each one is for, where it is kept, and whether it is read right now. A file can change how it works, never what it is allowed to do.", "sr-only"));
  const list = el("ul", undefined, undefined, "agent-files-list");
  const status = el("p", undefined, undefined, "meta agent-files-status");
  status.setAttribute("role", "status");
  const fill = (files) => list.replaceChildren(...files.map((entry) => fileRow(entry, (slot) => openEditor(section, slot, saved, status), choose)));
  const refresh = async () => { try { fill((await api("settings-kit/files")).files); } catch { /* the list stays as it was */ } };
  const choose = chooser(refresh, status);
  const saved = async () => { status.textContent = say("settings-kit.file-saved", "Saved. It is read from your next task."); await refresh(); };
  redrawList = refresh;
  fill(map.files);
  section.append(list, el("p", "agent-files.footnote", FOOTNOTE, "subtle agent-files-foot"), status);
  document.body.append(section);
}

const FOOTNOTE = "Every file starts off. When needed means it costs one line saying it exists, and is read only if the work calls for it. A file cannot widen what the assistant may do: permission lives in Permissions.";

/** Saves one file's Off, When needed or On as it is pressed, then redraws the list and the file's own card elsewhere. */
function chooser(refresh, status) {
  return async (slot, value, group) => {
    for (const option of group.querySelectorAll("button")) option.disabled = true;
    try {
      await api("context-files", { files: { [slot]: value } });
      status.textContent = say("agent-files.mode-saved", "Saved. It applies to your next task.");
      await refresh();
      globalThis.branchContextFilesReady?.();
    } catch (error) {
      status.textContent = error.message;
      for (const option of group.querySelectorAll("button")) option.disabled = false;
    }
  };
}

if (typeof document !== "undefined") {
  globalThis.branchAgentFiles = { draw: drawAgentFiles, refresh: () => redrawList?.() };
  document.addEventListener("branch-language", () => { if (!document.querySelector(".agent-file-dialog[open]")) void drawAgentFiles(); });
  document.addEventListener("branch-profile", (event) => {
    drawGeneration += 1;
    document.getElementById("agent-files")?.remove();
    if (event.detail?.owner) void drawAgentFiles();
  });
}
