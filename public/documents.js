/**
 * The Documents panel: what the assistant may read from, and a search that shows the exact
 * passages it would use. Kept in its own file; the page only provides the empty section.
 */
import { inlineNodes } from "/markdown.js";
import { t } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const sizeLimit = 20 * 1024 * 1024;
let view = null;
let context = {};
// FQ-workspace.office: a shared edit's code is handed back only once, when it is started (the
// server never stores it in the clear), so it is kept here only for the life of this page.
const coeditCodes = new Map();

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function say(message) {
  $("documents-status").textContent = message;
}
async function request(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      authorization: "Bearer " + (sessionStorage.getItem("branch-token") || ""),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "That did not work");
  return data;
}
const sizeText = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const stateText = {
  indexed: "Ready to use",
  needs_helper: "Needs a PDF helper",
  failed: "Could not be read",
};

export async function loadDocuments() {
  view = await request("/api/documents");
  // The switch for naming this project's own files lives with the other retrieval settings.
  context = await request("/api/retrieval").catch(() => context);
  render();
  await loadCoedit().catch((error) => coeditSay(error.message));
}
function render() {
  if (!view) return;
  $("documents-use").checked = view.inAnswers;
  $("documents-repository").checked = Boolean(context.repositoryContext);
  $("documents-meaning").textContent = view.meaningSearch
    ? "Your documents are matched by wording and by meaning."
    : "Your documents are matched by the words in them. Connect a model that offers comparisons by meaning to also match by meaning.";
  const list = $("documents-list");
  list.replaceChildren();
  if (!view.documents.length) {
    list.append(el("p", "Nothing here yet. Add a file from your workspace, or drop one in below.", "empty"));
    return;
  }
  for (const entry of view.documents) list.append(card(entry));
}
function card(entry) {
  const node = el("div", undefined, "item");
  const badge = el("span", stateText[entry.status] ?? entry.status, "badge");
  if (entry.status !== "indexed") badge.classList.add("failed");
  node.append(badge, el("h3", entry.name));
  node.append(el("p", `${sizeText(entry.fileSize)} · ${entry.chunks} passage${entry.chunks === 1 ? "" : "s"}` +
    (entry.embedded ? ` · ${entry.embedded} matched by meaning` : "")));
  if (entry.note) node.append(el("p", entry.note));
  if (entry.filePath) node.append(el("p", entry.filePath, "meta"));
  if (entry.filePath) node.append(act("Read the file again", () => request("/api/documents/reindex", { body: { id: entry.id } })));
  node.append(act("Remove", () => request(`/api/documents/${entry.id}`, { method: "DELETE" })));
  return node;
}
function act(label, run) {
  const node = el("button", label);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await run(); say(""); await loadDocuments(); } catch (error) { say(error.message); }
    finally { node.disabled = false; }
  });
  return node;
}

/**
 * FQ-workspace.office: a Word or spreadsheet file the owner and one other person both change. Built
 * entirely here, right after the documents list, so no other panel's markup has to make room for it.
 */
function coeditSay(message) {
  const status = $("coedit-status");
  if (status) status.textContent = message;
}
function coeditRoot() {
  let root = $("coedit-section");
  if (root) return root;
  root = el("div", undefined, "card");
  root.id = "coedit-section";
  root.append(el("h3", t("documents.coedit.heading.edit-a-file-together")));
  root.append(el("p", t("documents.coedit.note.start-with-a-file-already"), "subtle"));
  const form = document.createElement("form");
  const label = el("label", t("field.the-workspace-file-to-edit"));
  label.htmlFor = "coedit-path";
  const path = document.createElement("input");
  path.type = "text"; path.id = "coedit-path"; path.maxLength = 500; path.placeholder = "notes/report.docx"; path.required = true;
  const submit = el("button", t("documents.coedit.action.start-a-shared-edit"));
  submit.type = "submit";
  form.append(label, path, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const started = await request("/api/office-coedit", { body: { path: path.value.trim() } });
      coeditCodes.set(started.id, started.code);
      path.value = "";
      coeditSay(t("documents.coedit.status.started-hand-this-link",
        { link: `${location.origin}${started.link}`, code: started.code }));
      await loadCoedit();
    } catch (error) { coeditSay(error.message); }
    finally { submit.disabled = false; }
  });
  const status = el("p", "", "subtle");
  status.id = "coedit-status";
  const list = el("div", undefined, "card-list");
  list.id = "coedit-list";
  root.append(form, status, list);
  const documentsList = $("documents-list");
  (documentsList?.parentElement ?? document.body).insertBefore(root, documentsList?.nextSibling ?? null);
  return root;
}
async function loadCoedit() {
  coeditRoot();
  const { sessions } = await request("/api/office-coedit");
  const list = $("coedit-list");
  list.replaceChildren();
  if (!sessions.length) { list.append(el("p", t("documents.coedit.empty.nothing-shared-yet"), "empty")); return; }
  for (const entry of sessions) list.append(coeditCard(entry));
}
function coeditCard(entry) {
  const node = el("div", undefined, "item");
  node.append(el("h3", entry.name));
  node.append(el("p", `${entry.kind.toUpperCase()} · ${t("field.version-number", { version: entry.version })} · `
    + (entry.guestJoined ? t("documents.coedit.status.guest-has-joined") : t("documents.coedit.status.waiting-for-guest")), "meta"));
  const code = coeditCodes.get(entry.id);
  node.append(el("p", code ? `${location.origin}/coedit/${entry.id} · ${code}` : t("documents.coedit.note.code-shown-once"), "meta"));
  const form = document.createElement("form");
  const find = document.createElement("input");
  find.type = "text"; find.maxLength = 2000; find.required = true; find.placeholder = t("field.find");
  const replace = document.createElement("input");
  replace.type = "text"; replace.maxLength = 4000; replace.placeholder = t("field.replace-with");
  const send = el("button", t("documents.coedit.action.send-this-change"));
  send.type = "submit";
  form.append(find, replace, send);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const done = await request(`/api/office-coedit/${entry.id}/edit`,
        { body: { operations: [{ op: "replace-text", find: find.value, replaceWith: replace.value, all: true }] } });
      find.value = ""; replace.value = "";
      coeditSay(done.changes ? "" : (done.notes[0] ?? ""));
      await loadCoedit();
    } catch (error) { coeditSay(error.message); }
  });
  node.append(form);
  node.append(act(t("documents.coedit.action.download-the-current-file"), () => downloadCoedit(entry.id, entry.name)));
  node.append(act(t("documents.coedit.action.end-this-shared-edit"), async () => {
    await request(`/api/office-coedit/${entry.id}`, { method: "DELETE" });
    coeditCodes.delete(entry.id);
  }));
  return node;
}
async function downloadCoedit(id, name) {
  const response = await fetch(`/api/office-coedit/${id}/file`,
    { headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || "") } });
  if (!response.ok) { coeditSay((await response.json().catch(() => null))?.error || "That did not work"); return; }
  const address = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = address; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(address), 10000);
}

/**
 * Brackets around the matching words come from the search; they become highlights, never markup.
 * Everything between them keeps the formatting the document was written with — bold, italic,
 * inline code and links — built as nodes, so the passage still cannot carry markup of its own.
 */
function passage(result) {
  const node = el("div", undefined, "item");
  node.append(el("h3", result.source), el("p", `Passage ${result.passage + 1}`, "meta"));
  const text = el("p", undefined, "markdown");
  for (const part of String(result.highlight || result.text).split(/(\[[^\]]*\])/))
    if (part.startsWith("[") && part.endsWith("]")) text.append(el("mark", part.slice(1, -1)));
    else if (part) text.append(...inlineNodes(part));
  node.append(text);
  return node;
}
async function search(query) {
  const results = $("documents-results");
  results.replaceChildren();
  const { results: found } = await request("/api/documents/search", { body: { query, limit: 5 } });
  if (!found.length) { results.append(el("p", "Nothing in your documents matches that.", "empty")); return; }
  for (const result of found) results.append(passage(result));
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} could not be read`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}
async function addFiles(files) {
  for (const file of files) {
    if (file.size > sizeLimit) { say(`${file.name} is larger than 20 MB, so it was skipped.`); continue; }
    say(`Adding ${file.name}…`);
    await request("/api/documents", { body: { name: file.name, content: await readFile(file) } });
  }
  say("");
  await loadDocuments();
}

function wire() {
  const drop = $("documents-drop");
  for (const name of ["dragover", "dragenter"])
    drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add("dropping"); });
  for (const name of ["dragleave", "drop"])
    drop.addEventListener(name, () => drop.classList.remove("dropping"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    addFiles([...event.dataTransfer.files]).catch((error) => say(error.message));
  });
  $("documents-file").addEventListener("change", (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    addFiles(files).catch((error) => say(error.message));
  });
  $("documents-path-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const path = $("documents-path").value.trim();
    if (!path) return;
    say(`Adding ${path}…`);
    try { await request("/api/documents", { body: { path } }); $("documents-path").value = ""; say(""); await loadDocuments(); }
    catch (error) { say(error.message); }
  });
  $("documents-search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = $("documents-query").value.trim();
    if (!query) return;
    try { await search(query); say(""); } catch (error) { say(error.message); }
  });
  $("documents-repository").addEventListener("change", async (event) => {
    try {
      context = await request("/api/retrieval/context", { body: { repositoryContext: event.target.checked } });
    } catch (error) { say(error.message); }
  });
  $("documents-use").addEventListener("change", async (event) => {
    try {
      await request("/api/documents/settings", { body: { useDocuments: event.target.checked } });
      await loadDocuments();
    } catch (error) { say(error.message); }
  });
  document.addEventListener("branch-place", (event) => {
    if (["documents", "library:documents"].includes(event.detail.view)) loadDocuments().catch((error) => say(error.message));
  });
}
wire();
