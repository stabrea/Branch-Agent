// Redesign phase 2 (accounts, critique #40): the assistant's own files, read and changed in the window.
// SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md, SOP.md, MEMORY.md and HEARTBEAT.md: what each
// is for, where it is kept, whether it is read, and an editor with a preview, a size counter, a clear
// Save and an undo of the last save. It replaces R17-S05's "Which file does what" list and uses its
// routes (src/settings-kit/file-map.ts): the owner's alone, never a household person's or a chat
// app's (the server refuses the reads and writes to anybody else; there is no tool for them).
import { api } from "/app.js";
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

const ABOUT = {
  soul: "Its character: how it sounds, what it cares about, where it draws lines. Replaces the built-in character.",
  identity: "Its name and manner.", user: "Who you are, what to call you, and what you prefer.",
  agents: "How you want work done in this project.", tools: "Notes about the programs on this computer and their quirks.",
  sop: "Steps to follow the same way every time.", memory: "Things you wrote down for it to remember.",
  heartbeat: "What to check each time it wakes on a schedule.",
};
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

function fileRow(entry, open) {
  const row = el("li", undefined, undefined, "agent-file");
  row.dataset.slot = entry.slot;
  const name = el("span", undefined, entry.name ?? entry.names[0], "agent-file-name");
  const body = el("div", undefined, undefined, "agent-file-body");
  const where = entry.scope === "you" ? ["settings-kit.kept.you", "Kept with your own things, used in every project"] : ["settings-kit.kept.project", "Kept in this project's folder"];
  const written = entry.name
    ? say("settings-kit.written", `Written: ${entry.name}, ${Math.round(entry.bytes / 100) / 10} kB`, { name: entry.name, size: Math.round(entry.bytes / 100) / 10 })
    : say("settings-kit.seen.missing", "Not written yet");
  const seen = entry.name || entry.outcome !== "missing" ? SEEN[entry.outcome] ?? SEEN.missing : null;
  body.append(el("p", `settings-kit.slot.${entry.slot}`, ABOUT[entry.slot] ?? "", "agent-file-about"),
    el("p", undefined, [say(where[0], where[1]), written, seen ? say(seen[0], seen[1]) : ""].filter(Boolean).join(" · "), "meta"));
  const edit = button("settings-kit.edit", "Change it here", () => open(entry.slot));
  edit.setAttribute("aria-label", say("agent-files.edit-named", `Change ${entry.name ?? entry.names[0]} here`, { name: entry.name ?? entry.names[0] }));
  row.append(name, body, edit);
  return row;
}

/** The size line under the text: how much of what Branch reads is used, and whether Save may go. */
function counter(text, limit, line, save) {
  const used = bytesOf(text);
  line.textContent = say("agent-files.size", `${used} of ${limit} bytes`, { used: used.toLocaleString(), limit: limit.toLocaleString() });
  line.dataset.over = String(used > limit);
  if (used > limit) line.textContent += ` ${say("agent-files.too-long", "Too long: shorten it before saving.")}`;
  save.disabled = used > limit;
}

function tabs(write, preview, textarea) {
  const bar = el("div", undefined, undefined, "agent-files-tabs");
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", say("agent-files.view", "Write or preview"));
  const pick = (showPreview) => {
    write.setAttribute("aria-pressed", String(!showPreview));
    previewButton.setAttribute("aria-pressed", String(showPreview));
    textarea.hidden = showPreview;
    preview.hidden = !showPreview;
    if (showPreview) fillMarkdown(preview, textarea.value || say("agent-files.nothing", "Nothing written yet."));
  };
  const previewButton = button("agent-files.preview", "Preview", () => pick(true));
  write.addEventListener("click", () => pick(false));
  bar.append(write, previewButton);
  pick(false);
  return bar;
}

async function openEditor(area, list, slot, refresh) {
  let file;
  try { file = await api(`settings-kit/files/${slot}`); } catch (error) { area.replaceChildren(el("p", undefined, error.message, "subtle")); return; }
  list.hidden = true;
  area.hidden = false;
  const close = button("agent-files.back", "Back to all files", () => { area.hidden = true; list.hidden = false; void refresh(); });
  const head = el("div", undefined, undefined, "agent-files-head");
  head.append(el("h3", undefined, file.name), close);
  area.replaceChildren(head, el("p", `settings-kit.slot.${slot}`, ABOUT[slot] ?? "", "subtle"));
  if (!file.editable) { area.append(el("p", ...(WHY[file.why] ?? ["settings-kit.why.other", "This file cannot be changed here. Open it in your own editor."]), "field-note")); return; }
  area.append(...editorParts(file, slot, () => openEditor(area, list, slot, refresh)));
  area.querySelector("textarea")?.focus();
}

function editorParts(file, slot, reopen) {
  const textarea = el("textarea", undefined, undefined, "agent-files-text");
  textarea.id = "agent-files-text";
  textarea.value = file.text;
  textarea.rows = 12;
  textarea.spellcheck = true;
  const label = el("label", "settings-kit.field.file-text", "What the file says", "sr-only");
  label.htmlFor = textarea.id;
  const preview = el("div", undefined, undefined, "agent-files-preview");
  preview.setAttribute("aria-label", say("agent-files.preview", "Preview"));
  const size = el("p", undefined, undefined, "field-note agent-files-size");
  size.id = "agent-files-size";
  size.setAttribute("aria-live", "polite");
  textarea.setAttribute("aria-describedby", size.id);
  const status = el("p", undefined, undefined, "meta");
  status.setAttribute("role", "status");
  const save = button("settings-kit.save-file", "Save this file", async () => {
    save.disabled = true;
    try { await api("settings-kit/files", { slot, text: textarea.value }); await reopen(); document.querySelector(".agent-files-editor [role=status]").textContent = say("settings-kit.file-saved", "Saved. It is read from your next task."); }
    catch (error) { status.textContent = error.message; save.disabled = false; }
  }, "");
  const undo = button("agent-files.undo", "Undo the last save", async () => {
    undo.disabled = true;
    try { await api("settings-kit/files/undo", { slot }); await reopen(); document.querySelector(".agent-files-editor [role=status]").textContent = say("agent-files.undone", "The last save was undone."); }
    catch (error) { status.textContent = error.message; undo.disabled = false; }
  });
  undo.disabled = !file.lastSave;
  const starter = button("agent-files.starter", "Start from the usual shape", () => {
    textarea.value = say(`agent-files.starter.${slot}`, say("agent-files.starter.default", "# \n\n- \n"));
    textarea.dispatchEvent(new Event("input"));
  });
  starter.hidden = Boolean(file.text.trim());
  textarea.addEventListener("input", () => { counter(textarea.value, file.limit, size, save); starter.hidden = Boolean(textarea.value.trim()); });
  counter(textarea.value, file.limit, size, save);
  const actions = el("div", undefined, undefined, "agent-files-actions");
  actions.append(save, undo, starter);
  const parts = [tabs(button("agent-files.write", "Write", () => {}), preview, textarea), label, textarea, preview, size, actions, status];
  if (file.setting === "off") parts.push(el("p", "settings-kit.file-off", "This file is switched off, so it is not read yet.", "field-note"));
  return parts;
}

/** Draws the card on Settings › Assistant. Shown at the Advanced and Technical levels of detail. */
export async function drawAgentFiles() {
  let map;
  try { map = await api("settings-kit/files"); } catch { return; }
  document.getElementById("agent-files")?.remove();
  const section = el("section", undefined, undefined, "card agent-files");
  section.id = "agent-files";
  section.dataset.home = "settings:assistant";
  /* phase2/settings integration: the level itself hides this at Regular and shows it again at Advanced, so the card
     never marks itself hidden (a hidden card stayed hidden after the level went up). */
  section.dataset.level = "advanced";
  section.append(el("h2", "agent-files.title", "Your assistant's files"),
    el("p", "settings-kit.card.files-purpose", "The plain files you write to shape your assistant: what each one is for, where it is kept, and whether it is read right now. A file can change how it works, never what it is allowed to do."));
  const list = el("ul", undefined, undefined, "agent-files-list");
  const area = el("div", undefined, undefined, "agent-files-editor");
  area.hidden = true;
  const fill = (files) => list.replaceChildren(...files.map((entry) => fileRow(entry, (slot) => openEditor(area, list, slot, refresh))));
  const refresh = async () => { try { fill((await api("settings-kit/files")).files); } catch { /* the list stays as it was */ } };
  fill(map.files);
  section.append(list, area);
  document.body.append(section);
}

if (typeof document !== "undefined") {
  globalThis.branchAgentFiles = { draw: drawAgentFiles };
  document.addEventListener("branch-language", () => { if (!document.querySelector(".agent-files-editor:not([hidden])")) void drawAgentFiles(); });
}
